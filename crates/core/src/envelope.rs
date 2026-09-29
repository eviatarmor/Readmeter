use serde::{Deserialize, Serialize};

use crate::units::Units;

/// Version of the envelope/batch schema.
///
/// Nothing has shipped yet, so ingest decodes only this version and rejects
/// every other one with [`crate::WireError::UnsupportedVersion`]. Bump on any
/// breaking change to the serialized shape.
pub const SCHEMA_VERSION: u16 = 2;

/// One normalized backend call. This is the only shape rules and the backend
/// ever see. It never contains document contents or filter values, only
/// shapes, sizes and keyed hashes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    /// Wall-clock time the call completed, in milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Provider id, e.g. `firebase`.
    pub provider: String,
    /// Service within the provider, e.g. `firestore`.
    pub service: String,
    pub op: Op,
    pub target: Target,
    pub query: Option<QueryShape>,
    pub result: Option<ResultStats>,
    /// Only set when `op` is [`Op::Usage`].
    pub usage: Option<ResultUsage>,
    /// How the read was routed. [`ReadSource::Default`] unless the host forced a source.
    pub source: ReadSource,
    /// Only on single writes (`Create`, `Set`, `Update`) when the SDK saw the payload.
    pub write: Option<WriteStats>,
    /// Only set when `op` is [`Op::Init`].
    pub setup: Option<ClientSetup>,
    pub outcome: Outcome,
    pub duration_us: Option<u64>,
    pub ctx: CallContext,
    /// Billable units this call consumed, computed by the provider.
    pub units: Units,
}

impl Envelope {
    /// Items returned by the call, 0 when there is no result.
    pub fn items(&self) -> u64 {
        self.result.as_ref().map_or(0, |r| r.items)
    }

    pub fn bytes(&self) -> u64 {
        self.result.as_ref().map_or(0, |r| r.bytes)
    }

    pub fn from_cache(&self) -> bool {
        self.result.as_ref().is_some_and(|r| r.from_cache)
    }
}

/// Generic operation kinds. Providers map their API surface onto these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    /// Single item read by key.
    Get,
    /// Multi-item read.
    Query,
    /// Server-side aggregation (count, sum, avg).
    Aggregate,
    Create,
    Set,
    Update,
    Delete,
    /// Atomic multi-write (batch or transaction commit).
    Commit {
        writes: u32,
        deletes: u32,
        transactional: bool,
    },
    /// A realtime subscription was opened. `ctx.listener` identifies it.
    Subscribe,
    /// A realtime subscription delivered data.
    Snapshot {
        initial: bool,
    },
    /// A realtime subscription was closed.
    Unsubscribe,
    /// Report of how the host consumed the result of an earlier call
    /// (`ctx.call_id` refers to that call).
    Usage,
    /// The client was configured (cache, tabs). One per client instance.
    Init,
    /// The host page became visible or hidden (browser SDKs).
    Page {
        visible: bool,
    },
    /// Provider-specific operation without a generic equivalent.
    Other(String),
}

impl Op {
    pub fn is_read(&self) -> bool {
        matches!(self, Op::Get | Op::Query | Op::Aggregate)
    }

    pub fn is_single_write(&self) -> bool {
        matches!(self, Op::Create | Op::Set | Op::Update | Op::Delete)
    }

    pub fn is_write(&self) -> bool {
        self.is_single_write() || matches!(self, Op::Commit { .. })
    }
}

/// What the call touched, with identifiers redacted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    /// Path with identifiers replaced, e.g. `users/{id}/orders`.
    pub template: String,
    /// Keyed hash of the concrete target, including query filter values and
    /// paging. Equal keys mean "the exact same request".
    pub key: u64,
    /// Shape of the final document id, when the call addressed a document.
    pub id_shape: Option<IdShape>,
    /// Query spans every collection with this id (Firestore collection group).
    pub collection_group: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdShape {
    /// Random provider-generated id (e.g. Firestore 20-char auto id).
    AutoId,
    Uuid,
    Numeric,
    /// Looks like an epoch timestamp or ISO date.
    TimestampLike,
    Other,
}

impl IdShape {
    /// Ids that grow monotonically and concentrate writes on one index range.
    pub fn is_monotonic(self) -> bool {
        matches!(self, IdShape::Numeric | IdShape::TimestampLike)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryShape {
    pub filters: Vec<FilterShape>,
    pub order_by: Vec<OrderShape>,
    pub limit: Option<u32>,
    pub limit_to_last: bool,
    pub offset: Option<u32>,
    pub start_cursor: bool,
    pub end_cursor: bool,
    /// Selected fields, when the query projects (`select()`).
    pub projection: Option<Vec<String>>,
    /// Aggregation kinds, e.g. `count`, `sum`.
    pub aggregations: Vec<String>,
    /// Keyed hash of service, collection-group flag, path, filters (with
    /// values), ordering and `select`. Excludes aggregations and paging
    /// (limit, offset, cursors): a `count()` and a fetch of the same query
    /// share it, and so do pages of one query.
    pub base_key: u64,
    /// Hash of the query shape without any values. Equal across users.
    pub fingerprint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilterShape {
    pub field: String,
    pub op: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderShape {
    pub field: String,
    pub descending: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultStats {
    /// Items returned (documents, rows). For non-initial snapshots: items changed.
    pub items: u64,
    /// Serialized payload size in bytes.
    pub bytes: u64,
    /// Served entirely from a local cache; nothing billed.
    pub from_cache: bool,
    /// Index entries scanned (aggregations), when the provider reports it.
    pub index_entries: Option<u64>,
}

/// How the host used a result, reported after the fact by SDK shims that can
/// observe property access on result objects.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultUsage {
    /// Iterated or indexed the returned items.
    pub read_items: bool,
    /// Read the item count (`size`, `length`).
    pub read_size: bool,
    /// Read the emptiness flag (`empty`).
    pub read_empty: bool,
    /// Distinct returned items whose contents were read (`data()`, `get()`),
    /// when the SDK can observe it. `None`: not tracked.
    pub items_used: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    #[default]
    Ok,
    Error {
        code: String,
    },
}

impl Outcome {
    pub fn is_error(&self) -> bool {
        matches!(self, Outcome::Error { .. })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallContext {
    /// Random per-process/per-tab session id supplied by the host.
    pub session: u64,
    /// Monotonic per-session id of this call.
    pub call_id: u64,
    /// Hash of the source location that issued the call, when known.
    pub callsite: Option<u64>,
    /// Subscription id for Subscribe/Snapshot/Unsubscribe.
    pub listener: Option<u64>,
    /// Per-session id of the transaction this call belongs to.
    /// A counter, not a hash: equal ids are the same transaction.
    pub transaction: Option<u64>,
    /// UI component mount id (e.g. from `@readmeter/react`).
    pub mount: Option<u64>,
    pub platform: Platform,
    /// 1 for the first attempt; >1 for SDK or transaction retries.
    pub attempt: u32,
    /// Host is running a development build.
    pub dev: bool,
}

/// How a read was routed. [`Default`](ReadSource::Default) is the SDK's normal
/// cache-aware path; the others are host-forced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadSource {
    #[default]
    Default,
    Server,
    Cache,
}

/// Sizes and a keyed digest of one single-document write payload.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteStats {
    /// Estimated stored size of the largest top-level field, in bytes.
    pub max_field_bytes: u64,
    /// Estimated stored size of the whole payload, in bytes.
    pub payload_bytes: u64,
    /// Field transforms used: `increment`, `array_union`, `array_remove`,
    /// `server_timestamp`, `delete_field`, `maximum`, `minimum`. Sorted, unique.
    pub transforms: Vec<String>,
    /// Keyed hash of the payload values, salted per session. Equal within
    /// one session means "the same data was written". `None` when the
    /// payload has transforms or could not be read.
    pub payload_key: Option<u64>,
}

/// Where the client keeps documents between server reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheKind {
    #[default]
    Unknown,
    Memory,
    Persistent,
}

/// Cache configuration captured once per client instance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientSetup {
    pub cache: CacheKind,
    /// Tabs share one persistent cache (multi-tab manager). Only meaningful
    /// when `cache` is [`CacheKind::Persistent`].
    pub shared_tabs: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Browser,
    Server,
    Mobile,
    #[default]
    Unknown,
}
