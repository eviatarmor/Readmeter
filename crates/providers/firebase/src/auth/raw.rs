//! Raw call schema that Authentication SDK shims send to the core, as JSON.
//!
//! Emails, phone numbers, uids, tokens, and page-token strings are allowed
//! at this boundary and discarded here. Unknown fields are ignored.

use readmeter_core::CacheKind;
use readmeter_provider_api::NormalizeError;
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};

#[cfg(test)]
use super::error_codes::error_codes;
use super::error_codes::is_error_code;

/// Methods the shim may name. Anything else, including a string that
/// contains `@`, becomes `unknown` and the raw text is dropped.
const METHODS: &[&str] = &[
    "confirm",
    "createCustomToken",
    "createUserWithEmailAndPassword",
    "getIdToken",
    "getUser",
    "initializeAuth",
    "listUsers",
    "onAuthStateChanged",
    "onIdTokenChanged",
    "sendEmailVerification",
    "sendPasswordResetEmail",
    "setCustomUserClaims",
    "setPersistence",
    "signInAnonymously",
    "signInWithCredential",
    "signInWithCustomToken",
    "signInWithEmailLink",
    "signInWithPassword",
    "signInWithPhoneNumber",
    "signInWithPopup",
    "signInWithRedirect",
    "signOut",
    "verifyIdToken",
    "verifyPhoneNumber",
];

#[derive(Debug, Clone)]
pub struct RawCall {
    pub op: RawOp,
    /// Allowlisted method, or `unknown`.
    pub method: String,
    pub ts_ms: u64,
    pub force: bool,
    /// `None` when this call did not configure persistence.
    pub persistence: Option<CacheKind>,
    /// Provider id such as `google.com`, when it matched the safe charset.
    pub provider: Option<String>,
    /// A page token was present. The token string is never stored.
    pub page_token: bool,
    pub items: u64,
    pub from_cache: bool,
    pub error: Option<String>,
    pub duration_us: Option<u64>,
    pub call_id: u64,
    pub callsite: Option<String>,
    pub listener: Option<u64>,
    /// `withFlush` invocation. Mapped to `ctx.transaction` only for `list_users`.
    pub invocation: Option<u64>,
    pub attempt: u32,
}

impl RawCall {
    pub fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        let result = opt_with(value, "result", RawResult::from_json)?;
        Ok(Self {
            op: parse_op(&req_str(value, "op")?)?,
            method: method_name(&opt_string(value, "method")?.unwrap_or_default()),
            ts_ms: req_u64(value, "ts_ms")?,
            force: def_bool(value, "force", false)?,
            persistence: persistence_of(value)?,
            provider: opt_string(value, "provider")?.and_then(|s| provider_id(&s)),
            page_token: page_token(value)?,
            items: result
                .as_ref()
                .map(|r| r.items)
                .or(opt_u64(value, "items")?)
                .unwrap_or(0),
            from_cache: result.as_ref().is_some_and(|r| r.from_cache),
            error: opt_error(value)?,
            duration_us: opt_u64(value, "duration_us")?,
            call_id: def_u64(value, "call_id", 0)?,
            callsite: opt_string(value, "callsite")?,
            listener: opt_u64(value, "listener")?,
            invocation: opt_u64(value, "invocation")?,
            attempt: def_u32(value, "attempt", 1)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawOp {
    SignIn,
    SignInAnonymous,
    SignOut,
    Subscribe,
    Unsubscribe,
    TokenRefresh,
    PasswordReset,
    EmailVerification,
    Phone,
    Init,
    VerifyIdToken,
    GetUser,
    ListUsers,
    CustomToken,
    SetClaims,
}

#[derive(Debug, Clone, Default)]
struct RawResult {
    items: u64,
    from_cache: bool,
}

impl RawResult {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            items: def_u64(value, "items", 0)?,
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

fn method_name(raw: &str) -> String {
    if METHODS.binary_search(&raw).is_ok() {
        raw.to_owned()
    } else {
        "unknown".into()
    }
}

/// Last path segment, kept only when it is a known Auth error code.
/// The charset `[a-z0-9-]` with a 64 character cap is necessary but not
/// sufficient: a uid is the same shape. Unknown codes become `unknown`.
fn error_code(code: &str) -> String {
    let seg = code.rsplit('/').next().unwrap_or(code).trim();
    if seg.is_empty() || seg.len() > 64 {
        return "unknown".into();
    }
    let lower = seg.to_ascii_lowercase();
    if !lower
        .bytes()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return "unknown".into();
    }
    if is_error_code(&lower) {
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

/// `google.com` and `password` pass. An address, a uid, or mixed case does not.
fn provider_id(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 || raw.contains('@') {
        return None;
    }
    if !bytes
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(raw.to_owned())
}

/// `NONE` is memory. `LOCAL`, `COOKIE`, and `SESSION` are persistent.
/// `SESSION` is not in-memory: it survives a reload of the same tab.
/// An array is memory only when every entry is `NONE`. A list that starts
/// with `LOCAL` (the `getAuth` fallback, which ends in memory) is persistent.
fn persistence_of(value: &JsonValue) -> Result<Option<CacheKind>, NormalizeError> {
    match json::get(value, "persistence").map_err(|e| map_ty("persistence", e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Str(s)) => Ok(Some(kind_token(s))),
        Some(JsonValue::Array(items)) => Ok(Some(kind_list(items)?)),
        Some(_) => Err(map_ty("persistence", JsonTypeError::WrongType)),
    }
}

fn kind_list(items: &[JsonValue]) -> Result<CacheKind, NormalizeError> {
    if items.is_empty() {
        return Ok(CacheKind::Unknown);
    }
    let mut all_memory = true;
    let mut saw_persistent = false;
    for item in items {
        let JsonValue::Str(token) = item else {
            return Err(map_ty("persistence", JsonTypeError::WrongType));
        };
        match kind_token(token) {
            CacheKind::Memory => {}
            CacheKind::Persistent => {
                all_memory = false;
                saw_persistent = true;
            }
            CacheKind::Unknown => all_memory = false,
        }
    }
    if all_memory {
        Ok(CacheKind::Memory)
    } else if saw_persistent {
        Ok(CacheKind::Persistent)
    } else {
        Ok(CacheKind::Unknown)
    }
}

fn kind_token(token: &str) -> CacheKind {
    match token.trim().to_ascii_lowercase().as_str() {
        "none" | "memory" => CacheKind::Memory,
        "local" | "session" | "cookie" | "persistent" => CacheKind::Persistent,
        _ => CacheKind::Unknown,
    }
}

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
        "sign_in" => RawOp::SignIn,
        "sign_in_anonymous" => RawOp::SignInAnonymous,
        "sign_out" => RawOp::SignOut,
        "subscribe" => RawOp::Subscribe,
        "unsubscribe" => RawOp::Unsubscribe,
        "token_refresh" => RawOp::TokenRefresh,
        "password_reset" => RawOp::PasswordReset,
        "email_verification" => RawOp::EmailVerification,
        "phone" => RawOp::Phone,
        "init" => RawOp::Init,
        "verify_id_token" => RawOp::VerifyIdToken,
        "get_user" => RawOp::GetUser,
        "list_users" => RawOp::ListUsers,
        "custom_token" => RawOp::CustomToken,
        "set_claims" => RawOp::SetClaims,
        _ => return Err(NormalizeError::Invalid("unknown `op`".into())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_are_sorted() {
        let mut prev = "";
        for method in METHODS {
            assert!(prev < *method, "{prev} before {method}");
            prev = method;
        }
        prev = "";
        let mut n = 0;
        for code in error_codes() {
            assert!(prev < code, "{prev} before {code}");
            assert!(is_error_code(code));
            prev = code;
            n += 1;
        }
        assert_eq!(n, 177);
        assert!(!is_error_code("user@host"));
        assert!(!is_error_code("not-a-real-auth-code"));
        assert!(is_error_code("wrong-password"));
    }
}
