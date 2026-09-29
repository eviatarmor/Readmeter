//! Raw call schema that Firestore SDK shims send to the core, as JSON.
//!
//! This is the in-process boundary: it may contain concrete paths, filter
//! values and cursor values. None of that survives normalization. Unknown
//! fields are ignored so newer shims work with older cores.

use readmeter_core::{CacheKind, ClientSetup, ReadSource, ResultUsage};
use readmeter_provider_api::NormalizeError;
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};

#[derive(Debug, Clone)]
pub struct RawCall {
    pub op: RawOp,
    pub ts_ms: u64,
    /// Concrete path: `users/abc/orders` (collection) or `users/abc` (doc).
    /// For collection group queries, the collection id.
    pub path: String,
    pub collection_group: bool,
    pub query: Option<RawQuery>,
    pub result: Option<RawResult>,
    /// For `usage`: how the result of `call_id` was consumed.
    pub usage: Option<ResultUsage>,
    /// Host-forced read route. Unknown strings are an error.
    pub source: Option<ReadSource>,
    /// Per-session transaction counter. Not hashed.
    pub transaction: Option<u64>,
    /// Single-document write sizes. Ignored unless the op is create/set/update.
    pub write: Option<RawWrite>,
    /// Client cache setup. Required when `op` is `init`.
    pub setup: Option<ClientSetup>,
    /// For `commit`.
    pub commit: Option<RawCommit>,
    /// For `snapshot`: first snapshot of the listener.
    pub initial: bool,
    /// Firestore error code (`permission-denied`, `aborted`, ...).
    pub error: Option<String>,
    pub duration_us: Option<u64>,
    pub call_id: u64,
    /// Source location, e.g. `src/Feed.tsx:42:7`. Hashed before leaving.
    pub callsite: Option<String>,
    pub listener: Option<u64>,
    pub mount: Option<u64>,
    pub attempt: u32,
}

impl RawCall {
    /// Reads a raw call object. Missing fields take the same defaults serde
    /// used to (`attempt` is 1). Unknown fields are ignored. A wrong JSON
    /// type is an error.
    pub fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            op: parse_op(&req_str(value, "op")?)?,
            ts_ms: req_u64(value, "ts_ms")?,
            path: req_str(value, "path")?,
            collection_group: def_bool(value, "collection_group", false)?,
            query: opt_with(value, "query", RawQuery::from_json)?,
            result: opt_with(value, "result", RawResult::from_json)?,
            usage: opt_with(value, "usage", usage_from)?,
            source: opt_source(value)?,
            transaction: opt_u64(value, "transaction")?,
            write: opt_with(value, "write", write_from)?,
            setup: opt_with(value, "setup", setup_from)?,
            commit: opt_with(value, "commit", RawCommit::from_json)?,
            initial: def_bool(value, "initial", false)?,
            error: opt_string(value, "error")?,
            duration_us: opt_u64(value, "duration_us")?,
            call_id: def_u64(value, "call_id", 0)?,
            callsite: opt_string(value, "callsite")?,
            listener: opt_u64(value, "listener")?,
            mount: opt_u64(value, "mount")?,
            attempt: def_u32(value, "attempt", 1)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawOp {
    Get,
    Query,
    Aggregate,
    Create,
    Set,
    Update,
    Delete,
    Commit,
    Subscribe,
    Snapshot,
    Unsubscribe,
    Usage,
    Init,
}

#[derive(Debug, Clone, Default)]
pub struct RawQuery {
    pub filters: Vec<RawFilter>,
    pub order_by: Vec<RawOrder>,
    pub limit: Option<u32>,
    pub limit_to_last: bool,
    pub offset: Option<u32>,
    /// Cursor values (`startAt`/`startAfter`), or a document snapshot id.
    pub start: Option<JsonValue>,
    pub end: Option<JsonValue>,
    /// Fields from `select()` (server SDKs only).
    pub select: Option<Vec<String>>,
    /// Aggregations: `count`, `sum:<field>`, `avg:<field>`.
    pub aggregations: Vec<String>,
}

impl RawQuery {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            filters: vec_with(value, "filters", RawFilter::from_json)?,
            order_by: vec_with(value, "order_by", RawOrder::from_json)?,
            limit: opt_u32(value, "limit")?,
            limit_to_last: def_bool(value, "limit_to_last", false)?,
            offset: opt_u32(value, "offset")?,
            start: opt_json(value, "start")?,
            end: opt_json(value, "end")?,
            select: opt_string_vec(value, "select")?,
            aggregations: string_vec(value, "aggregations")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RawFilter {
    pub field: String,
    /// `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`,
    /// `array-contains-any`.
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

#[derive(Debug, Clone)]
pub struct RawOrder {
    pub field: String,
    pub direction: Direction,
}

impl RawOrder {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        let direction =
            match json::get_str(value, "direction").map_err(|e| map_ty("direction", e))? {
                None => Direction::Asc,
                Some(s) => parse_direction(s)?,
            };
        Ok(Self {
            field: req_str(value, "field")?,
            direction,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Direction {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, Default)]
pub struct RawResult {
    /// Documents returned; for non-initial snapshots, documents changed.
    pub docs: u64,
    pub bytes: u64,
    pub from_cache: bool,
    /// Index entries scanned by an aggregation (for count: the count).
    pub index_entries: Option<u64>,
}

impl RawResult {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            docs: def_u64(value, "docs", 0)?,
            bytes: def_u64(value, "bytes", 0)?,
            from_cache: def_bool(value, "from_cache", false)?,
            index_entries: opt_u64(value, "index_entries")?,
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RawCommit {
    pub writes: u32,
    pub deletes: u32,
    pub transactional: bool,
}

impl RawCommit {
    fn from_json(value: &JsonValue) -> Result<Self, NormalizeError> {
        expect_object(value)?;
        Ok(Self {
            writes: def_u32(value, "writes", 0)?,
            deletes: def_u32(value, "deletes", 0)?,
            transactional: def_bool(value, "transactional", false)?,
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

fn string_vec(value: &JsonValue, key: &str) -> Result<Vec<String>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| {
                json::as_str(item)
                    .map(str::to_owned)
                    .map_err(|e| map_ty(key, e))
            })
            .collect(),
        Some(_) => Err(map_ty(key, JsonTypeError::WrongType)),
    }
}

fn opt_string_vec(value: &JsonValue, key: &str) -> Result<Option<Vec<String>>, NormalizeError> {
    match json::get(value, key).map_err(|e| map_ty(key, e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| {
                json::as_str(item)
                    .map(str::to_owned)
                    .map_err(|e| map_ty(key, e))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(map_ty(key, JsonTypeError::WrongType)),
    }
}

fn usage_from(value: &JsonValue) -> Result<ResultUsage, NormalizeError> {
    expect_object(value)?;
    Ok(ResultUsage {
        read_items: def_bool(value, "read_items", false)?,
        read_size: def_bool(value, "read_size", false)?,
        read_empty: def_bool(value, "read_empty", false)?,
        items_used: opt_u32(value, "items_used")?,
    })
}

/// Transforms the SDK is allowed to name. Anything else is dropped.
const KNOWN_TRANSFORMS: &[&str] = &[
    "array_remove",
    "array_union",
    "delete_field",
    "increment",
    "maximum",
    "minimum",
    "server_timestamp",
];

/// Sizes and an optional payload digest for one write.
#[derive(Debug, Clone)]
pub struct RawWrite {
    pub max_field_bytes: u64,
    pub payload_bytes: u64,
    pub transforms: Vec<String>,
    /// Parsed 16-char lowercase hex digest. `None` when the field is absent.
    pub digest: Option<u64>,
}

fn write_from(value: &JsonValue) -> Result<RawWrite, NormalizeError> {
    expect_object(value)?;
    let mut transforms: Vec<String> = string_vec(value, "transforms")?
        .into_iter()
        .filter(|name| KNOWN_TRANSFORMS.contains(&name.as_str()))
        .collect();
    transforms.sort();
    transforms.dedup();
    let digest = match opt_string(value, "digest")? {
        None => None,
        Some(s) => Some(parse_digest(&s)?),
    };
    Ok(RawWrite {
        max_field_bytes: req_u64(value, "max_field_bytes")?,
        payload_bytes: req_u64(value, "payload_bytes")?,
        transforms,
        digest,
    })
}

/// Exactly 16 lowercase hex digits. Uppercase, a short string, or a `0x` prefix is an error.
fn parse_digest(s: &str) -> Result<u64, NormalizeError> {
    let bytes = s.as_bytes();
    let hex = bytes.len() == 16
        && bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (*b >= b'a' && *b <= b'f'));
    if !hex {
        return Err(NormalizeError::Invalid(
            "`digest`: expected 16 lowercase hex".into(),
        ));
    }
    u64::from_str_radix(s, 16)
        .map_err(|_| NormalizeError::Invalid("`digest`: expected 16 lowercase hex".into()))
}

fn setup_from(value: &JsonValue) -> Result<ClientSetup, NormalizeError> {
    expect_object(value)?;
    let cache = match req_str(value, "cache")?.as_str() {
        "unknown" => CacheKind::Unknown,
        "memory" => CacheKind::Memory,
        "persistent" => CacheKind::Persistent,
        _ => return Err(NormalizeError::Invalid("unknown `cache`".into())),
    };
    Ok(ClientSetup {
        cache,
        shared_tabs: def_bool(value, "shared_tabs", false)?,
    })
}

fn opt_source(value: &JsonValue) -> Result<Option<ReadSource>, NormalizeError> {
    match json::get(value, "source").map_err(|e| map_ty("source", e))? {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Str(s)) => Ok(Some(parse_source(s)?)),
        Some(_) => Err(map_ty("source", JsonTypeError::WrongType)),
    }
}

fn parse_source(s: &str) -> Result<ReadSource, NormalizeError> {
    match s {
        "default" => Ok(ReadSource::Default),
        "server" => Ok(ReadSource::Server),
        "cache" => Ok(ReadSource::Cache),
        _ => Err(NormalizeError::Invalid("unknown `source`".into())),
    }
}

fn parse_op(s: &str) -> Result<RawOp, NormalizeError> {
    Ok(match s {
        "get" => RawOp::Get,
        "query" => RawOp::Query,
        "aggregate" => RawOp::Aggregate,
        "create" => RawOp::Create,
        "set" => RawOp::Set,
        "update" => RawOp::Update,
        "delete" => RawOp::Delete,
        "commit" => RawOp::Commit,
        "subscribe" => RawOp::Subscribe,
        "snapshot" => RawOp::Snapshot,
        "unsubscribe" => RawOp::Unsubscribe,
        "usage" => RawOp::Usage,
        "init" => RawOp::Init,
        _ => return Err(NormalizeError::Invalid("unknown `op`".into())),
    })
}

fn parse_direction(s: &str) -> Result<Direction, NormalizeError> {
    match s {
        "asc" => Ok(Direction::Asc),
        "desc" => Ok(Direction::Desc),
        _ => Err(NormalizeError::Invalid("unknown `direction`".into())),
    }
}
