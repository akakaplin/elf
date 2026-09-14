//! Just enough JSON to answer the API. Responses are written straight into the
//! socket's buffer as they are produced, so a 46 MB raw window never exists as
//! one string in memory.

use std::collections::BTreeMap;
use std::io::{self, Write};

/// Something that can write itself out as JSON.
pub trait ToJson {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()>;
}

/// Writes an object one field at a time, keeping track of the commas.
pub struct Object<'a, W: Write> {
    w: &'a mut W,
    empty: bool,
}

impl<'a, W: Write> Object<'a, W> {
    pub fn new(w: &'a mut W) -> io::Result<Self> {
        w.write_all(b"{")?;
        Ok(Object { w, empty: true })
    }

    pub fn field<T: ToJson + ?Sized>(mut self, key: &str, value: &T) -> io::Result<Self> {
        if !self.empty {
            self.w.write_all(b",")?;
        }
        self.empty = false;
        write_str(self.w, key)?;
        self.w.write_all(b":")?;
        value.write_json(self.w)?;
        Ok(self)
    }

    /// Leaves the field out altogether when there is nothing, rather than
    /// writing `null`.
    pub fn field_if_some<T: ToJson>(self, key: &str, value: &Option<T>) -> io::Result<Self> {
        match value {
            Some(v) => self.field(key, v),
            None => Ok(self),
        }
    }

    pub fn end(self) -> io::Result<()> {
        self.w.write_all(b"}")
    }
}

/// A one-field object, such as `{"ok":true}`.
pub struct Field<T>(pub &'static str, pub T);

impl<T: ToJson> ToJson for Field<T> {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        Object::new(w)?.field(self.0, &self.1)?.end()
    }
}

impl ToJson for bool {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if *self {
            w.write_all(b"true")
        } else {
            w.write_all(b"false")
        }
    }
}

impl ToJson for i64 {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        write!(w, "{self}")
    }
}

impl ToJson for usize {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        write!(w, "{self}")
    }
}

impl ToJson for f64 {
    /// JSON has no NaN or infinity, so those go out as `null`. Debug formatting
    /// is the shortest text that reads back as the same number, and switches to
    /// exponent form for very large and very small magnitudes.
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        if self.is_finite() {
            write!(w, "{self:?}")
        } else {
            w.write_all(b"null")
        }
    }
}

impl ToJson for str {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        write_str(w, self)
    }
}

impl ToJson for String {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        write_str(w, self)
    }
}

impl<T: ToJson + ?Sized> ToJson for &T {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        (**self).write_json(w)
    }
}

impl<T: ToJson> ToJson for Option<T> {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        match self {
            Some(v) => v.write_json(w),
            None => w.write_all(b"null"),
        }
    }
}

impl<T: ToJson> ToJson for [T] {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        w.write_all(b"[")?;
        for (i, item) in self.iter().enumerate() {
            if i > 0 {
                w.write_all(b",")?;
            }
            item.write_json(w)?;
        }
        w.write_all(b"]")
    }
}

impl<T: ToJson, const N: usize> ToJson for [T; N] {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        self.as_slice().write_json(w)
    }
}

impl<T: ToJson> ToJson for Vec<T> {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        self.as_slice().write_json(w)
    }
}

impl<T: ToJson> ToJson for BTreeMap<String, T> {
    fn write_json<W: Write>(&self, w: &mut W) -> io::Result<()> {
        let mut obj = Object::new(w)?;
        for (key, value) in self {
            obj = obj.field(key, value)?;
        }
        obj.end()
    }
}

/// Series and column names come from directory names and parquet schemas, so
/// they can hold anything; escapes exactly what JSON requires.
fn write_str<W: Write>(w: &mut W, s: &str) -> io::Result<()> {
    w.write_all(b"\"")?;
    let bytes = s.as_bytes();
    let mut clean = 0;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'"' | b'\\' | 0x00..=0x1f => {}
            _ => continue,
        }
        w.write_all(&bytes[clean..i])?;
        match b {
            b'"' => w.write_all(b"\\\"")?,
            b'\\' => w.write_all(b"\\\\")?,
            b'\n' => w.write_all(b"\\n")?,
            b'\r' => w.write_all(b"\\r")?,
            b'\t' => w.write_all(b"\\t")?,
            _ => write!(w, "\\u{b:04x}")?,
        }
        clean = i + 1;
    }
    w.write_all(&bytes[clean..])?;
    w.write_all(b"\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render<T: ToJson + ?Sized>(value: &T) -> String {
        let mut out = Vec::new();
        value.write_json(&mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn strings_escape_what_json_requires_and_nothing_else() {
        assert_eq!(render("say \"hi\"\\ \n\r\t é/"), r#""say \"hi\"\\ \n\r\t é/""#);
        // Other control characters go out as numeric escapes.
        let esc = '\\';
        assert_eq!(render("\u{1}\u{1f}"), format!("\"{esc}u0001{esc}u001f\""));
    }

    #[test]
    fn numbers_read_back_exactly_and_non_finite_is_null() {
        let values = vec![
            Some(1.0),
            Some(-0.5),
            Some(60000.25),
            Some(1e-7),
            Some(1e21),
            Some(f64::NAN),
            Some(f64::NEG_INFINITY),
            None,
        ];
        assert_eq!(render(&values), "[1.0,-0.5,60000.25,1e-7,1e21,null,null,null]");
        assert_eq!(render(&[i64::MIN, 0]), "[-9223372036854775808,0]");
    }

    #[test]
    fn objects_keep_field_order_and_skip_absent_fields() {
        let mut map = BTreeMap::new();
        map.insert("b".to_string(), Field("ok", true));
        map.insert("a".to_string(), Field("ok", false));

        let mut out = Vec::new();
        Object::new(&mut out)
            .unwrap()
            .field("z", &1i64)
            .unwrap()
            .field_if_some("skipped", &None::<i64>)
            .unwrap()
            .field_if_some("kept", &Some("x"))
            .unwrap()
            .field("map", &map)
            .unwrap()
            .end()
            .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"z":1,"kept":"x","map":{"a":{"ok":false},"b":{"ok":true}}}"#
        );
    }
}
