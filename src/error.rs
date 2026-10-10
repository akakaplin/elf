//! One error type: a message for whoever reads it. The server's errors all end
//! as text -- a `{"error": ...}` body or a line on stderr -- and nothing
//! matches on their kind, so a string is the whole of what is needed.

use std::fmt;

pub struct Error(pub String);

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// `err!("unknown series `{name}`")`: an [`Error`] from a format string.
macro_rules! err {
    ($($arg:tt)*) => {
        $crate::error::Error(format!($($arg)*))
    };
}
pub(crate) use err;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The message alone: this is what `main` prints when it returns an error.
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error(e.to_string())
    }
}

impl From<crate::duck::Error> for Error {
    fn from(e: crate::duck::Error) -> Error {
        Error(e.to_string())
    }
}

impl From<std::net::AddrParseError> for Error {
    fn from(e: std::net::AddrParseError) -> Error {
        Error(e.to_string())
    }
}
