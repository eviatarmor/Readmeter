//! Raw call schema that Cloud Storage SDK shims send to the core, as JSON.
//!
//! Concrete paths, page tokens and object bytes are allowed at this boundary.
//! Normalization redacts them. Unknown fields are ignored so newer shims work
//! with older cores. A page token may arrive as a string; only its presence
//! is kept.

use readmeter_provider_api::NormalizeError;
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};

/// `max-age` above this is clamped. Ten years is longer than any cache
/// header this product needs to tell apart from "cached".
pub const MAX_CACHE_AGE_S: u64 = 315_360_000;

#[derive(Debug, Clone)]
pub struct RawCall {
    pub op: RawOp,
    pub ts_ms: u64,
    /// Concrete object path. Empty (or only slashes) is the bucket root.
    pub path: String,
    /// Extension the shim already split off, lowercase. The path wins when
    /// it has its own extension. Anything that is not `[a-z0-9]{1,8}` is dropped.
    pub ext: Option<String>,
    /// Byte count when the shim did not put one on `result`.
    pub bytes: Option<u64>,
    /// Content-type major (`image`, `video`, ...), already or not yet sanitized.
    pub content_type: Option<String>,
    /// `None` means the call did not observe metadata. That is not the same
    /// as [`CacheControl::None`], which means metadata was present and had
    /// no `max-age`.
    pub cache_control: Option<CacheControl>,
    pub resumable: bool,
    /// Set only when the caller passed `maxResults`.
    pub max_results: Option<u32>,
    /// A page token was present. The token string is never stored.
    pub page_token: bool,
    pub result: Option<RawResult>,
    /// Page count the shim actually saw. Billing prefers this over an estimate.
    pub pages: Option<u64>,
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
            ts_ms: req_u64(value, "ts_ms")?,
            path: req_str(value, "path")?,
            ext: opt_string(value, "ext")?,
            bytes: opt_u64(value, "bytes")?,
            content_type: opt_string(value, "content_type")?,
            cache_control: opt_cache(value)?,
            resumable: def_bool(value, "resumable", false)?,
            max_results: opt_u32(value, "max_results")?,
            page_token: page_token(value)?,
            result: opt_with(value, "result", RawResult::from_json)?,
            pages: opt_u64(value, "pages")?,
            error: opt_string(value, "error")?,
            duration_us: opt_u64(value, "duration_us")?,
            call_id: def_u64(value, "call_id", 0)?,
            callsite: opt_string(value, "callsite")?,
            attempt: def_u32(value, "attempt", 1)?,
        })
    }

    /// Bytes the shim observed, preferring `result.bytes` when that key was set.
    pub fn observed_bytes(&self) -> Option<u64> {
        self.result.as_ref().and_then(|r| r.bytes).or(self.bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawOp {
    Download,
    DownloadUrl,
    SignedUrl,
    GetMetadata,
    UpdateMetadata,
    Upload,
    Delete,
    List,
    ListAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheControl {
    /// Metadata was observed and it did not carry a `max-age`.
    None,
    MaxAge(u64),
}

#[derive(Debug, Clone, Default)]
pub struct RawResult {
    /// Listed objects. Prefixes are separate so a shim does not have to
    /// pre-sum them. Normalization adds the two.
    pub items: u64,
    pub prefixes: u64,
    pub bytes: Option<u64>,
    pub from_cache: bool,
}

impl RawResult {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            items: def_u64(value, "items", 0)?,
            prefixes: def_u64(value, "prefixes", 0)?,
            bytes: opt_u64(value, "bytes")?,
            from_cache: def_bool(value, "from_cache", false)?,
        })
    }
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

fn opt_u32(value: &JsonValue, key: &str) -> Result<Option<u32>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => Ok(Some(json::as_u32(v).map_err(|e| map_ty(key, e))?)),
    }
}

fn opt_with<T>(
    value: &JsonValue,
    key: &str,
    f: impl FnOnce(&JsonValue) -> Result<T, NormalizeError>,
) -> Result<Option<T>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => Ok(Some(f(v)?)),
    }
}

/// Absent or JSON null: unknown, not "no max-age". A hostile string is
/// dropped rather than stored. A number or a decimal string is `max-age`.
fn opt_cache(value: &JsonValue) -> Result<Option<CacheControl>, NormalizeError> {
    match json::get(value, "cache_control").map_err(|e| map_ty("cache_control", e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Str(s)) => Ok(cache_from_str(s)),
        Some(v) => match json::as_u64(v) {
            Ok(n) => Ok(Some(CacheControl::MaxAge(n.min(MAX_CACHE_AGE_S)))),
            Err(JsonTypeError::WrongType) => Err(map_ty("cache_control", JsonTypeError::WrongType)),
            Err(e) => Err(map_ty("cache_control", e)),
        },
    }
}

fn cache_from_str(s: &str) -> Option<CacheControl> {
    if s.eq_ignore_ascii_case("none") {
        return Some(CacheControl::None);
    }
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 18 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    s.parse::<u64>()
        .ok()
        .map(|n| CacheControl::MaxAge(n.min(MAX_CACHE_AGE_S)))
}

/// `true` when a token was present. A string token is reduced to that bit
/// and the characters are discarded.
fn page_token(value: &JsonValue) -> Result<bool, NormalizeError> {
    match json::get(value, "page_token").map_err(|e| map_ty("page_token", e))? {
        None | Some(JsonValue::Null) => Ok(false),
        Some(JsonValue::Bool(b)) => Ok(*b),
        Some(JsonValue::Str(s)) => Ok(!s.is_empty()),
        Some(v) => match json::as_u64(v) {
            Ok(n) => Ok(n != 0),
            Err(_) => Err(map_ty("page_token", JsonTypeError::WrongType)),
        },
    }
}

fn parse_op(s: &str) -> Result<RawOp, NormalizeError> {
    Ok(match s {
        "download" => RawOp::Download,
        "download_url" => RawOp::DownloadUrl,
        "signed_url" => RawOp::SignedUrl,
        "get_metadata" => RawOp::GetMetadata,
        "update_metadata" => RawOp::UpdateMetadata,
        "upload" => RawOp::Upload,
        "delete" => RawOp::Delete,
        "list" => RawOp::List,
        "list_all" => RawOp::ListAll,
        _ => return Err(NormalizeError::Invalid("unknown `op`".into())),
    })
}
