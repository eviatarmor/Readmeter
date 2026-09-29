//! Raw call schema that the Functions shims send to the core, as JSON.
//!
//! Request and response bodies, URLs, and project ids are ignored. The
//! function name is kept only when it matches a safe charset. Unknown
//! fields are ignored.

use readmeter_provider_api::NormalizeError;
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};

/// gRPC status codes used by `@firebase/functions` 0.14.0 (`FunctionsErrorCodeCore`).
const ERROR_CODES: &[&str] = &[
    "aborted",
    "already-exists",
    "cancelled",
    "data-loss",
    "deadline-exceeded",
    "failed-precondition",
    "internal",
    "invalid-argument",
    "not-found",
    "ok",
    "out-of-range",
    "permission-denied",
    "resource-exhausted",
    "unauthenticated",
    "unavailable",
    "unimplemented",
    "unknown",
];

#[derive(Debug, Clone)]
pub struct RawCall {
    pub op: RawOp,
    /// Allowlisted function name, or `unknown`.
    pub name: String,
    pub ts_ms: u64,
    pub request_bytes: u64,
    pub response_bytes: u64,
    /// Firestore reads tallied for this server invocation.
    pub reads: u64,
    pub cold: bool,
    pub memory_mb: Option<u64>,
    pub cpu_milli: Option<u64>,
    pub rtdb_download_bytes: u64,
    pub storage_ops: u64,
    pub error: Option<String>,
    pub duration_us: Option<u64>,
    pub call_id: u64,
    pub callsite: Option<String>,
    pub attempt: u32,
}

impl RawCall {
    pub fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            op: parse_op(&req_str(value, "op")?)?,
            name: function_name(&opt_string(value, "name")?.unwrap_or_default()),
            ts_ms: req_u64(value, "ts_ms")?,
            request_bytes: def_u64(value, "request_bytes", 0)?,
            response_bytes: def_u64(value, "response_bytes", 0)?,
            reads: def_u64(value, "reads", 0)?,
            cold: def_bool(value, "cold", false)?,
            memory_mb: opt_u64(value, "memory_mb")?,
            cpu_milli: opt_u64(value, "cpu_milli")?,
            rtdb_download_bytes: def_u64(value, "rtdb_download_bytes", 0)?,
            storage_ops: def_u64(value, "storage_ops", 0)?,
            error: opt_error(value)?,
            duration_us: opt_u64(value, "duration_us")?,
            call_id: def_u64(value, "call_id", 0)?,
            callsite: opt_string(value, "callsite")?,
            attempt: def_u32(value, "attempt", 1)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawOp {
    Callable,
    Invoke,
}

fn expect_object(value: &JsonValue) -> Result<(), NormalizeError> {
    match value {
        JsonValue::Object(_) => Ok(()),
        _ => Err(NormalizeError::Invalid("expected object".into())),
    }
}

fn map_ty(field: &str, err: JsonTypeError) -> NormalizeError {
    let why = match err {
        JsonTypeError::NotObject => "expected an object",
        JsonTypeError::WrongType => "wrong type",
        JsonTypeError::OutOfRange => "out of range",
    };
    NormalizeError::Invalid(format!("`{field}`: {why}"))
}

fn missing(field: &str) -> NormalizeError {
    NormalizeError::Invalid(format!("missing `{field}`"))
}

fn req_str(value: &JsonValue, key: &str) -> Result<String, NormalizeError> {
    match json::get_str(value, key).map_err(|e| map_ty(key, e))? {
        Some(s) => Ok(s.to_owned()),
        None => Err(missing(key)),
    }
}

fn opt_string(value: &JsonValue, key: &str) -> Result<Option<String>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Str(s)) => Ok(Some(s.clone())),
        Some(_) => Err(map_ty(key, JsonTypeError::WrongType)),
    }
}

fn def_bool(value: &JsonValue, key: &str, default: bool) -> Result<bool, NormalizeError> {
    Ok(json::get_bool(value, key)
        .map_err(|e| map_ty(key, e))?
        .unwrap_or(default))
}

fn req_u64(value: &JsonValue, key: &str) -> Result<u64, NormalizeError> {
    match json::get_u64(value, key).map_err(|e| map_ty(key, e))? {
        Some(n) => Ok(n),
        None => Err(missing(key)),
    }
}

fn def_u64(value: &JsonValue, key: &str, default: u64) -> Result<u64, NormalizeError> {
    Ok(json::get_u64(value, key)
        .map_err(|e| map_ty(key, e))?
        .unwrap_or(default))
}

fn opt_u64(value: &JsonValue, key: &str) -> Result<Option<u64>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => Ok(Some(json::as_u64(v).map_err(|e| map_ty(key, e))?)),
    }
}

fn def_u32(value: &JsonValue, key: &str, default: u32) -> Result<u32, NormalizeError> {
    Ok(json::get_u32(value, key)
        .map_err(|e| map_ty(key, e))?
        .unwrap_or(default))
}

/// Last path segment, kept only when it is a known Functions error code.
fn error_code(code: &str) -> String {
    let seg = code.rsplit('/').next().unwrap_or(code).trim();
    if seg.is_empty() || seg.len() > 64 {
        return "unknown".into();
    }
    let lower = seg.to_ascii_lowercase();
    if ERROR_CODES.binary_search(&lower.as_str()).is_ok() {
        lower
    } else {
        "unknown".into()
    }
}

fn opt_error(value: &JsonValue) -> Result<Option<String>, NormalizeError> {
    match json::get(value, "error").map_err(|e| map_ty("error", e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Str(s)) => Ok(Some(error_code(s))),
        Some(_) => Err(map_ty("error", JsonTypeError::WrongType)),
    }
}

/// Letters, digits, `_`, and `-`, at most 63 characters, not all digits
/// and not a UUID. Anything else, including a URL or a project id with a
/// dot, becomes `unknown` and the raw text is dropped.
fn function_name(raw: &str) -> String {
    if is_safe_name(raw) {
        raw.to_owned()
    } else {
        "unknown".into()
    }
}

fn is_safe_name(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_alphabetic() && first != b'_' {
        return false;
    }
    if !bytes
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
    {
        return false;
    }
    !is_uuid(raw)
}

fn is_uuid(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut index = 0;
    for (group, len) in groups.iter().enumerate() {
        if group > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..*len {
            match bytes.get(index) {
                Some(c) if c.is_ascii_hexdigit() => index += 1,
                _ => return false,
            }
        }
    }
    index == bytes.len()
}

fn parse_op(value: &str) -> Result<RawOp, NormalizeError> {
    Ok(match value {
        "callable" => RawOp::Callable,
        "invoke" => RawOp::Invoke,
        _ => return Err(NormalizeError::Invalid("unknown `op`".into())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_sorted() {
        let mut prev = "";
        for code in ERROR_CODES {
            assert!(prev < *code, "{prev} before {code}");
            prev = code;
        }
        assert_eq!(ERROR_CODES.len(), 17);
    }

    #[test]
    fn names_reject_urls_numbers_and_uuids() {
        assert_eq!(function_name("echo"), "echo");
        assert_eq!(function_name("readStorm"), "readStorm");
        assert_eq!(function_name("cold-start"), "cold-start");
        assert_eq!(function_name(""), "unknown");
        assert_eq!(function_name("12345"), "unknown");
        assert_eq!(
            function_name("http://127.0.0.1:5001/demo/us-central1/echo"),
            "unknown"
        );
        assert_eq!(function_name("demo.readmeter"), "unknown");
        assert_eq!(
            function_name("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            "unknown"
        );
        assert_eq!(function_name(&"a".repeat(64)), "unknown");
        assert_eq!(function_name(&"a".repeat(63)), "a".repeat(63));
    }
}
