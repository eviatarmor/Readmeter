//! Raw call schema that Realtime Database SDK shims send to the core, as JSON.
//!
//! This is the in-process boundary: it may contain concrete paths, query
//! bounds and cursor values. None of that survives normalization. Unknown
//! fields are ignored so newer shims work with older cores.

use readmeter_provider_api::NormalizeError;
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};

#[derive(Debug, Clone)]
pub struct RawCall {
    pub op: RawOp,
    pub ts_ms: u64,
    /// Concrete path. Empty (or only slashes) is the database root.
    pub path: String,
    pub query: Option<RawQuery>,
    pub result: Option<RawResult>,
    /// For `snapshot`: first snapshot of the listener.
    pub initial: bool,
    pub error: Option<String>,
    pub duration_us: Option<u64>,
    pub call_id: u64,
    pub callsite: Option<String>,
    pub listener: Option<u64>,
    /// UI component mount id (e.g. from `@readmeter/react`). A counter, not hashed.
    pub mount: Option<u64>,
    pub attempt: u32,
    /// For `index_warning`: the child named in the SDK's "Using an
    /// unspecified index" warning (`$value` for `orderByValue`).
    pub order_by_child: Option<String>,
}

impl RawCall {
    pub fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            op: parse_op(&req_str(value, "op")?)?,
            ts_ms: req_u64(value, "ts_ms")?,
            path: req_str(value, "path")?,
            query: opt_with(value, "query", RawQuery::from_json)?,
            result: opt_with(value, "result", RawResult::from_json)?,
            initial: def_bool(value, "initial", false)?,
            error: opt_string(value, "error")?,
            duration_us: opt_u64(value, "duration_us")?,
            call_id: def_u64(value, "call_id", 0)?,
            callsite: opt_string(value, "callsite")?,
            listener: opt_u64(value, "listener")?,
            mount: opt_u64(value, "mount")?,
            attempt: def_u32(value, "attempt", 1)?,
            order_by_child: opt_string(value, "order_by_child")?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawOp {
    Get,
    Query,
    Create,
    Set,
    Update,
    Delete,
    Subscribe,
    Snapshot,
    Unsubscribe,
    ChildAdded,
    ChildChanged,
    ChildRemoved,
    ChildMoved,
    GoOnline,
    GoOffline,
    /// The SDK logged "Using an unspecified index" for a listen at `path`.
    IndexWarning,
}

#[derive(Debug, Clone, Default)]
pub struct RawQuery {
    pub filters: Vec<RawFilter>,
    /// `orderByChild` path, or `$key` / `$value` / `$priority`.
    pub order_by: Option<String>,
    pub limit: Option<u32>,
    pub limit_to_last: bool,
    pub start: Option<JsonValue>,
    pub end: Option<JsonValue>,
}

impl RawQuery {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            filters: vec_with(value, "filters", RawFilter::from_json)?,
            order_by: opt_string(value, "order_by")?,
            limit: opt_u32(value, "limit")?,
            limit_to_last: def_bool(value, "limit_to_last", false)?,
            start: opt_json(value, "start")?,
            end: opt_json(value, "end")?,
        })
    }

    pub fn has_constraints(&self) -> bool {
        self.limit.is_some()
            || self.limit_to_last
            || self.start.is_some()
            || self.end.is_some()
            || self.order_by.is_some()
            || !self.filters.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct RawFilter {
    pub field: String,
    pub op: String,
    pub value: JsonValue,
}

impl RawFilter {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            field: req_str(value, "field")?,
            op: req_str(value, "op")?,
            value: match json::get(value, "value").map_err(|e| map_ty("value", e))? {
                None => JsonValue::Null,
                Some(v) => v.clone(),
            },
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct RawResult {
    /// Immediate children (`DataSnapshot.size` / `numChildren()`), not bytes.
    pub children: u64,
    pub bytes: u64,
    pub from_cache: bool,
}

impl RawResult {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            children: def_u64(value, "children", 0)?,
            bytes: def_u64(value, "bytes", 0)?,
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

fn opt_json(value: &JsonValue, key: &str) -> Result<Option<JsonValue>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => Ok(Some(v.clone())),
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

fn vec_with<T>(
    value: &JsonValue,
    key: &str,
    f: impl Fn(&JsonValue) -> Result<T, NormalizeError>,
) -> Result<Vec<T>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(items)) => items.iter().map(f).collect(),
        Some(_) => Err(map_ty(key, JsonTypeError::WrongType)),
    }
}

fn parse_op(s: &str) -> Result<RawOp, NormalizeError> {
    Ok(match s {
        "get" => RawOp::Get,
        "query" => RawOp::Query,
        "create" => RawOp::Create,
        "set" => RawOp::Set,
        "update" => RawOp::Update,
        "delete" => RawOp::Delete,
        "subscribe" => RawOp::Subscribe,
        "snapshot" => RawOp::Snapshot,
        "unsubscribe" => RawOp::Unsubscribe,
        "child_added" => RawOp::ChildAdded,
        "child_changed" => RawOp::ChildChanged,
        "child_removed" => RawOp::ChildRemoved,
        "child_moved" => RawOp::ChildMoved,
        "go_online" => RawOp::GoOnline,
        "go_offline" => RawOp::GoOffline,
        "index_warning" => RawOp::IndexWarning,
        _ => return Err(NormalizeError::Invalid("unknown `op`".into())),
    })
}
