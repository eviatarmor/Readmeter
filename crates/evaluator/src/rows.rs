//! JSON-safe rows for storage.
//!
//! Consumers are JavaScript (the TypeScript ingest), where numbers above
//! 2^53 lose precision. Every 64-bit hash (session, keys, fingerprints,
//! callsites, listener/mount/call ids) is therefore a 16-char lowercase hex
//! string. Timestamps, counts and sizes stay numbers.

use readmeter_core::{Envelope, Finding, Op, Outcome, Scalar, SdkInfo, Units};
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
    /// Variant fields for `commit` / `snapshot` / `other`, else `null`.
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
}

#[derive(Debug, Serialize)]
pub struct FindingRow {
    pub rule: String,
    pub severity: Value,
    /// `sdk` (local rule, came in the batch) or `evaluator` (window rule, found here).
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
        }
    }
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
        Self {
            rule: f.rule.clone(),
            severity: to_value(&f.severity),
            source,
            ts_ms: f.ts_ms,
            provider: f.provider.clone(),
            service: f.service.clone(),
            template: f.template.clone(),
            session: hex(f.session),
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
