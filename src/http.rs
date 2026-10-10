//! A deliberately small HTTP/1.1 server: GET and HEAD only, one request per
//! connection, each connection on its own thread. It serves a local viewer, so
//! it goes without keep-alive, ranges and caching headers.
//!
//! A thread per connection is what keeps the health probe honest: it answers
//! while a slow DuckDB query holds a different thread.

use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::json::ToJson;

/// Most bytes of request line and headers read before a request is refused.
const MAX_HEAD: u64 = 16 * 1024;
/// Sent with every response. The viewer is wholly same-origin -- vendored
/// scripts, one stylesheet, `fetch` to its own API -- so nothing else may load.
/// Inline `style=` set from script goes through the CSSOM, which `style-src`
/// does not govern, so React's styling still works.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
                   connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; \
                   frame-ancestors 'none'";
/// How long a client may take to send its request, or leave a response unread.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Request {
    pub method: String,
    /// Percent-decoded, always starting with `/`.
    pub path: String,
    query: Vec<(String, String)>,
}

impl Request {
    /// The first value given for `key`, percent-decoded.
    pub fn param(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

pub struct Response {
    status: u16,
    content_type: &'static str,
    body: Body,
}

enum Body {
    Bytes(Vec<u8>),
    File(File, u64),
    /// Produced while it is sent. Its length is not known up front, so the end
    /// of the body is marked by closing the connection.
    Json(Box<dyn FnOnce(&mut BufWriter<TcpStream>) -> io::Result<()>>),
}

impl Response {
    pub fn json<T: ToJson + 'static>(status: u16, value: T) -> Response {
        Response {
            status,
            content_type: "application/json",
            body: Body::Json(Box::new(move |w: &mut BufWriter<TcpStream>| {
                value.write_json(w)
            })),
        }
    }

    fn text(status: u16, text: &str) -> Response {
        Response {
            status,
            content_type: "text/plain; charset=utf-8",
            body: Body::Bytes(text.as_bytes().to_vec()),
        }
    }
}

/// Accepts connections forever, answering each on its own thread.
pub fn serve<H>(listener: TcpListener, handler: H) -> !
where
    H: Fn(&Request) -> Response + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) => {
                // Usually out of file descriptors: back off rather than spin.
                eprintln!("elf: accept failed: {e}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let handler = Arc::clone(&handler);
        let spawned = thread::Builder::new()
            .name("elf-conn".into())
            .spawn(move || {
                // A client leaving mid-response is routine -- the page aborts
                // requests it no longer needs -- and there is no one to tell.
                let _ = handle(stream, &*handler);
            });
        if let Err(e) = spawned {
            eprintln!("elf: cannot start a connection thread: {e}");
        }
    }
}

fn handle<H: Fn(&Request) -> Response>(stream: TcpStream, handler: &H) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let (response, head_only) = match read_request(&stream)? {
        Err(why) => (Response::text(400, why), false),
        Ok(req) if req.method == "GET" || req.method == "HEAD" => {
            let head_only = req.method == "HEAD";
            (handler(&req), head_only)
        }
        Ok(_) => (Response::text(405, "only GET and HEAD are served"), false),
    };
    write_response(stream, response, head_only)
}

/// Reads one request head. The outer error is the socket failing, which leaves
/// no one to answer; the inner one is a malformed request, which gets a 400.
fn read_request(stream: &TcpStream) -> io::Result<Result<Request, &'static str>> {
    let mut reader = BufReader::new(stream.take(MAX_HEAD));
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    let Ok(request_line) = std::str::from_utf8(&line) else {
        return Ok(Err("request line is not UTF-8"));
    };
    let mut parts = request_line.split_ascii_whitespace();
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(Err("malformed request line"));
    };
    if !version.starts_with("HTTP/1.") {
        return Ok(Err("unsupported HTTP version"));
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if !path.starts_with('/') {
        return Ok(Err("request target must be a path"));
    }
    let request = Request {
        method: method.to_string(),
        path: percent_decode(path, false),
        query: query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                (percent_decode(k, true), percent_decode(v, true))
            })
            .collect(),
    };

    // Nothing here looks at a header, but they still have to come off the wire
    // before answering.
    let mut header = Vec::new();
    loop {
        header.clear();
        reader.read_until(b'\n', &mut header)?;
        if !header.ends_with(b"\n") {
            return Ok(Err("request head too large or cut short"));
        }
        if header == b"\r\n" || header == b"\n" {
            return Ok(Ok(request));
        }
    }
}

fn write_response(stream: TcpStream, response: Response, head_only: bool) -> io::Result<()> {
    let mut out = BufWriter::with_capacity(1 << 16, stream);
    write!(
        out,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Security-Policy: {CSP}\r\n\
         X-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        response.status,
        reason(response.status),
        response.content_type
    )?;
    match &response.body {
        Body::Bytes(bytes) => write!(out, "Content-Length: {}\r\n", bytes.len())?,
        Body::File(_, len) => write!(out, "Content-Length: {len}\r\n")?,
        Body::Json(_) => {}
    }
    out.write_all(b"\r\n")?;
    if !head_only {
        match response.body {
            Body::Bytes(bytes) => out.write_all(&bytes)?,
            Body::File(mut file, _) => {
                io::copy(&mut file, &mut out)?;
            }
            Body::Json(produce) => produce(&mut out)?,
        }
    }
    out.flush()
}

/// Serves `path` from under `root`, with a directory standing for its
/// `index.html`. A `..` segment is refused outright rather than resolved, so no
/// URL can name a file outside `root`.
pub fn static_file(root: &Path, path: &str) -> Response {
    let mut file_path = root.to_path_buf();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => return not_found(),
            s if s.contains('\\') || s.contains('\0') => return not_found(),
            s => file_path.push(s),
        }
    }
    if file_path.is_dir() {
        file_path.push("index.html");
    }
    let opened = File::open(&file_path).and_then(|file| {
        let meta = file.metadata()?;
        Ok((file, meta))
    });
    match opened {
        Ok((file, meta)) if meta.is_file() => Response {
            status: 200,
            content_type: content_type(&file_path),
            body: Body::File(file, meta.len()),
        },
        _ => not_found(),
    }
}

fn not_found() -> Response {
    Response::text(404, "not found")
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        // Browsers refuse to run a `<script type="module">` served as anything else.
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "",
    }
}

/// Decodes `%XX` escapes, and `+` as a space when `plus_is_space` (query
/// strings). A `%` without two hex digits after it is kept as it is, and
/// invalid UTF-8 is replaced -- the same leniency browsers show.
fn percent_decode(s: &str, plus_is_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hi = bytes.get(i + 1).and_then(|&b| hex(b));
                let lo = bytes.get(i + 2).and_then(|&b| hex(b));
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi << 4) | lo);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' if plus_is_space => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("bbo%3Abid%2Cbbo%3Aask", true), "bbo:bid,bbo:ask");
        assert_eq!(percent_decode("a+b%20c", true), "a b c");
        assert_eq!(percent_decode("a+b", false), "a+b");
        assert_eq!(percent_decode("100%", true), "100%");
        assert_eq!(percent_decode("%zz%4", true), "%zz%4");
        assert_eq!(percent_decode("%C3%A9", false), "é");
    }

    fn request_from(raw: &[u8]) -> Result<Request, &'static str> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.write_all(raw).unwrap();
        drop(client);
        let (server, _) = listener.accept().unwrap();
        read_request(&server).unwrap()
    }

    #[test]
    fn request_heads() {
        let req = request_from(
            b"GET /api/data?channels=bbo%3Abid%2Cbbo%3Aask&from=1&from=2&flag HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api/data");
        assert_eq!(req.param("channels"), Some("bbo:bid,bbo:ask"));
        assert_eq!(req.param("from"), Some("1"));
        assert_eq!(req.param("flag"), Some(""));
        assert_eq!(req.param("to"), None);

        assert!(request_from(b"GET /x HTTP/1.1\r\nHost: x\r\n").is_err());
        assert!(request_from(b"GET http://x/ HTTP/1.1\r\n\r\n").is_err());
        assert!(request_from(b"GET / SPDY/3\r\n\r\n").is_err());
        let huge = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD as usize));
        assert!(request_from(huge.as_bytes()).is_err());
    }

    #[test]
    fn responses_carry_the_csp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        write_response(server, Response::text(200, "ok"), false).unwrap();
        let mut raw = String::new();
        client.read_to_string(&mut raw).unwrap();
        let head = raw.split("\r\n\r\n").next().unwrap();
        assert!(head.contains(&format!("\r\nContent-Security-Policy: {CSP}\r\n")));
        assert!(head.contains("\r\nX-Content-Type-Options: nosniff\r\n"));
        assert!(!CSP.contains("  "), "line continuation left padding in the policy");
    }

    #[test]
    fn static_files_stay_inside_the_root() {
        let base = std::env::temp_dir().join(format!("elf-static-{}", std::process::id()));
        let web = base.join("web");
        fs::create_dir_all(web.join("vendor")).unwrap();
        fs::write(web.join("index.html"), "<p>hi</p>").unwrap();
        fs::write(web.join("vendor/lib.js"), "export {}").unwrap();
        fs::write(base.join("secret.txt"), "private").unwrap();

        let served = |path: &str| {
            let r = static_file(&web, path);
            (r.status, r.content_type)
        };
        assert_eq!(served("/"), (200, "text/html; charset=utf-8"));
        assert_eq!(served("/vendor/lib.js"), (200, "text/javascript; charset=utf-8"));
        for refused in ["/vendor/", "/../secret.txt", "/vendor/../../secret.txt", "/vendor/..", "/nope.js"] {
            assert_eq!(served(refused).0, 404, "{refused}");
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
