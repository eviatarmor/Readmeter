//! JSON-safe rows for storage.
//!
//! Consumers are JavaScript (the TypeScript ingest), where numbers above
//! 2^53 lose precision. Every 64-bit hash (session, keys, fingerprints,
//! callsites, listener/mount/call ids) is therefore a 16-char lowercase hex
//! string. Timestamps, counts and sizes stay numbers.

use readmeter_core::{
    ClientSetup, Envelope, Finding, Op, Outcome, ReadSource, ResultUsage, Scalar, SdkInfo, Units,
    WriteStats,
};
use serde::Serialize;
use serde_json::{Map, Value};

pub fn hex(v: u64) -> String {
    format!("{v:016x}")
}

#[derive(Debug, Serialize)]
pub struct BatchRow {
    pub schema: u16,
    pub sdk: SdkInfo,
    pub session: String,
    pub sent_at_ms: u64,
    pub dropped_events: u64,
    pub dropped_findings: u64,
}

#[derive(Debug, Serialize)]
pub struct EventRow {
    pub ts_ms: u64,
    pub session: String,
    pub provider: String,
    pub service: String,
    /// `get`, `query`, `commit`, ... (`Op` variant name).
    pub op: String,
    /// Variant fields for `commit` / `snapshot` / `page` / `other`, else `null`.
    pub op_detail: Value,
    pub template: String,
    pub target_key: String,
    pub id_shape: Option<String>,
    pub collection_group: bool,
    /// Query shape without hashes (filters, order, limit, offset, cursors,
    /// projection, aggregations), or `null`.
    pub query: Value,
    pub fingerprint: Option<String>,
    pub base_key: Option<String>,
    pub items: u64,
    pub bytes: u64,
    pub from_cache: bool,
    pub error_code: Option<String>,
    pub duration_us: Option<u64>,
    pub call_id: String,
    pub callsite: Option<String>,
    pub listener: Option<String>,
    pub mount: Option<String>,
    pub platform: Value,
    pub attempt: u32,
    pub dev: bool,
    pub units: Value,
    /// Present signals only. `null` when the call carries none.
    pub signals: Value,
}

#[derive(Debug, Serialize)]
pub struct FindingRow {
    pub rule: String,
    pub severity: Value,
    /// `sdk` (local rule, came in the batch) or `evaluator` (window or
    /// aggregate rule, found here).
    pub source: &'static str,
    pub ts_ms: u64,
    pub provider: String,
    pub service: String,
    pub template: String,
    pub session: String,
    pub callsite: Option<String>,
    pub message: String,
    pub evidence: Value,
    pub wasted: Value,
}

pub fn units(u: &Units) -> Value {
    Value::Object(
        u.iter()
            .map(|(k, v)| (k.to_owned(), Value::from(v)))
            .collect::<Map<_, _>>(),
    )
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn op_parts(op: &Op) -> (String, Value) {
    match op {
        Op::Commit {
            writes,
            deletes,
            transactional,
        } => (
            "commit".into(),
            serde_json::json!({"writes": writes, "deletes": deletes, "transactional": transactional}),
        ),
        Op::Snapshot { initial } => ("snapshot".into(), serde_json::json!({"initial": initial})),
        Op::Page { visible } => ("page".into(), serde_json::json!({"visible": visible})),
        Op::Other(name) => ("other".into(), serde_json::json!({"name": name})),
        simple => match to_value(simple) {
            Value::String(s) => (s, Value::Null),
            _ => ("other".into(), Value::Null),
        },
    }
}

impl EventRow {
    pub fn from_envelope(e: &Envelope) -> Self {
        let (op, op_detail) = op_parts(&e.op);
        let query = e.query.as_ref().map_or(Value::Null, |q| {
            serde_json::json!({
                "filters": to_value(&q.filters),
                "order_by": to_value(&q.order_by),
                "limit": q.limit,
                "limit_to_last": q.limit_to_last,
                "offset": q.offset,
                "start_cursor": q.start_cursor,
                "end_cursor": q.end_cursor,
                "projection": q.projection,
                "aggregations": q.aggregations,
            })
        });
        Self {
            ts_ms: e.ts_ms,
            session: hex(e.ctx.session),
            provider: e.provider.clone(),
            service: e.service.clone(),
            op,
            op_detail,
            template: e.target.template.clone(),
            target_key: hex(e.target.key),
            id_shape: e.target.id_shape.and_then(|s| match to_value(&s) {
                Value::String(s) => Some(s),
                _ => None,
            }),
            collection_group: e.target.collection_group,
            query,
            fingerprint: e.query.as_ref().map(|q| hex(q.fingerprint)),
            base_key: e.query.as_ref().map(|q| hex(q.base_key)),
            items: e.items(),
            bytes: e.bytes(),
            from_cache: e.from_cache(),
            error_code: match &e.outcome {
                Outcome::Ok => None,
                Outcome::Error { code } => Some(code.clone()),
            },
            duration_us: e.duration_us,
            call_id: hex(e.ctx.call_id),
            callsite: e.ctx.callsite.map(hex),
            listener: e.ctx.listener.map(hex),
            mount: e.ctx.mount.map(hex),
            platform: to_value(&e.ctx.platform),
            attempt: e.ctx.attempt,
            dev: e.ctx.dev,
            units: units(&e.units),
            signals: signals(e),
        }
    }
}

/// Object of the signals that are actually set. `null` when there are none.
fn signals(e: &Envelope) -> Value {
    let mut map = Map::new();
    if e.source != ReadSource::Default {
        map.insert("source".into(), to_value(&e.source));
    }
    if let Some(usage) = e.usage {
        map.insert("usage".into(), usage_value(usage));
    }
    if let Some(write) = &e.write {
        map.insert("write".into(), write_value(write));
    }
    if let Some(id) = e.ctx.transaction {
        // A counter, not a hash. Decimal so it is not mistaken for a hex key.
        map.insert("transaction".into(), Value::String(id.to_string()));
    }
    if let Some(setup) = e.setup {
        map.insert("setup".into(), setup_value(setup));
    }
    if map.is_empty() {
        Value::Null
    } else {
        Value::Object(map)
    }
}

fn usage_value(usage: ResultUsage) -> Value {
    let mut map = Map::new();
    map.insert("read_items".into(), Value::Bool(usage.read_items));
    map.insert("read_size".into(), Value::Bool(usage.read_size));
    map.insert("read_empty".into(), Value::Bool(usage.read_empty));
    if let Some(n) = usage.items_used {
        map.insert("items_used".into(), Value::from(n));
    }
    Value::Object(map)
}

fn write_value(write: &WriteStats) -> Value {
    let mut map = Map::new();
    map.insert("max_field_bytes".into(), Value::from(write.max_field_bytes));
    map.insert("payload_bytes".into(), Value::from(write.payload_bytes));
    map.insert(
        "transforms".into(),
        Value::Array(
            write
                .transforms
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    if let Some(key) = write.payload_key {
        map.insert("payload_key".into(), Value::String(hex(key)));
    }
    Value::Object(map)
}

fn setup_value(setup: ClientSetup) -> Value {
    serde_json::json!({
        "cache": to_value(&setup.cache),
        "shared_tabs": setup.shared_tabs,
    })
}

fn scalar(s: &Scalar) -> Value {
    match s {
        Scalar::U64(v) => Value::from(*v),
        Scalar::I64(v) => Value::from(*v),
        Scalar::F64(v) => serde_json::Number::from_f64(*v).map_or(Value::Null, Value::Number),
        Scalar::Bool(v) => Value::Bool(*v),
        Scalar::Str(v) => Value::String(v.clone()),
    }
}

impl FindingRow {
    pub fn from_finding(f: &Finding, source: &'static str) -> Self {
        Self::with_session(f, source, hex(f.session))
    }

    /// `session` replaces the envelope session. Aggregate findings pass
    /// `"*"` (every session of the project). The unique index is
    /// `(project, rule, session, callsite, template)`, so `"*"` dedupes
    /// those findings across sessions without a schema change.
    pub fn with_session(f: &Finding, source: &'static str, session: String) -> Self {
        Self {
            rule: f.rule.clone(),
            severity: to_value(&f.severity),
            source,
            ts_ms: f.ts_ms,
            provider: f.provider.clone(),
            service: f.service.clone(),
            template: f.template.clone(),
            session,
            callsite: f.callsite.map(hex),
            message: f.message.clone(),
            evidence: Value::Object(
                f.evidence
                    .iter()
                    .map(|(k, v)| (k.to_owned(), scalar(v)))
                    .collect(),
            ),
            wasted: units(&f.wasted),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use readmeter_core::{
        CacheKind, CallContext, ClientSetup, Envelope, Op, Outcome, ReadSource, ResultUsage,
        Target, Units, WriteStats,
    };

    use super::*;

    fn env(op: Op) -> Envelope {
        Envelope {
            ts_ms: 1,
            provider: "firebase".into(),
            service: "firestore".into(),
            op,
            target: Target::default(),
            query: None,
            result: None,
            usage: None,
            source: ReadSource::Default,
            write: None,
            setup: None,
            outcome: Outcome::Ok,
            duration_us: None,
            ctx: CallContext {
                session: 1,
                call_id: 2,
                attempt: 1,
                ..CallContext::default()
            },
            units: Units::new(),
        }
    }

    #[test]
    fn no_signals_is_null() {
        let row = EventRow::from_envelope(&env(Op::Get));
        assert_eq!(row.signals, Value::Null);
        assert_eq!(row.op, "get");
        assert_eq!(row.op_detail, Value::Null);
    }

    #[test]
    fn each_signal_is_present_only_when_set() {
        let mut sourced = env(Op::Get);
        sourced.source = ReadSource::Server;
        let row = EventRow::from_envelope(&sourced);
        assert_eq!(row.signals["source"], "server");
        assert!(row.signals.get("usage").is_none());

        let mut used = env(Op::Usage);
        used.usage = Some(ResultUsage {
            read_items: true,
            read_size: false,
            read_empty: true,
            items_used: Some(4),
        });
        let row = EventRow::from_envelope(&used);
        assert_eq!(row.signals["usage"]["read_items"], true);
        assert_eq!(row.signals["usage"]["read_size"], false);
        assert_eq!(row.signals["usage"]["read_empty"], true);
        assert_eq!(row.signals["usage"]["items_used"], 4);

        let mut untracked = env(Op::Usage);
        untracked.usage = Some(ResultUsage {
            read_size: true,
            ..ResultUsage::default()
        });
        let row = EventRow::from_envelope(&untracked);
        assert!(row.signals["usage"].get("items_used").is_none());

        let mut written = env(Op::Set);
        written.write = Some(WriteStats {
            max_field_bytes: 7,
            payload_bytes: 7,
            transforms: vec!["increment".into()],
            payload_key: Some(0x0123),
        });
        let row = EventRow::from_envelope(&written);
        assert_eq!(row.signals["write"]["max_field_bytes"], 7);
        assert_eq!(row.signals["write"]["payload_bytes"], 7);
        assert_eq!(row.signals["write"]["transforms"][0], "increment");
        assert_eq!(row.signals["write"]["payload_key"], "0000000000000123");

        written.write.as_mut().unwrap().payload_key = None;
        let row = EventRow::from_envelope(&written);
        assert!(row.signals["write"].get("payload_key").is_none());

        let mut tx = env(Op::Commit {
            writes: 1,
            deletes: 0,
            transactional: true,
        });
        tx.ctx.transaction = Some(42);
        let row = EventRow::from_envelope(&tx);
        assert_eq!(row.signals["transaction"], "42");

        let mut init = env(Op::Init);
        init.setup = Some(ClientSetup {
            cache: CacheKind::Persistent,
            shared_tabs: true,
        });
        let row = EventRow::from_envelope(&init);
        assert_eq!(row.op, "init");
        assert_eq!(row.op_detail, Value::Null);
        assert_eq!(row.signals["setup"]["cache"], "persistent");
        assert_eq!(row.signals["setup"]["shared_tabs"], true);

        let row = EventRow::from_envelope(&env(Op::Page { visible: false }));
        assert_eq!(row.op, "page");
        assert_eq!(row.op_detail, serde_json::json!({"visible": false}));
        assert_eq!(row.signals, Value::Null);
    }
}
