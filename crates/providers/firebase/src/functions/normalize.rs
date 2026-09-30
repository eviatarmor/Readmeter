use readmeter_core::{
    CallContext, Envelope, FilterShape, Op, Outcome, QueryShape, ResultStats, Target, WriteStats,
};
use readmeter_provider_api::{NormalizeContext, NormalizeError};

use super::SERVICE_ID;
use super::billing;
use super::raw::{RawCall, RawOp};

use crate::PROVIDER_ID;

pub fn normalize(raw: RawCall, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let template = format!("functions/{}", raw.name);
    // Identity is the function name. Filters must not change the key.
    let key = cx.hasher.start().str(SERVICE_ID).str(&raw.name).finish();
    let filters = attributes(&raw);
    let query = if filters.is_empty() {
        None
    } else {
        Some(shape(cx, &filters))
    };
    let op = match raw.op {
        RawOp::Callable => Op::Other("callable".into()),
        RawOp::Invoke => Op::Other("invoke".into()),
    };
    let write = if raw.request_bytes > 0 {
        Some(WriteStats {
            payload_bytes: raw.request_bytes,
            ..WriteStats::default()
        })
    } else {
        None
    };

    let mut env = Envelope {
        ts_ms: raw.ts_ms,
        provider: PROVIDER_ID.to_owned(),
        service: SERVICE_ID.to_owned(),
        op,
        target: Target {
            template,
            key,
            id_shape: None,
            collection_group: false,
        },
        query,
        result: Some(ResultStats {
            items: raw.reads,
            bytes: raw.response_bytes,
            from_cache: false,
            index_entries: None,
        }),
        usage: None,
        source: Default::default(),
        write,
        setup: None,
        outcome: match raw.error {
            Some(code) => Outcome::Error { code },
            None => Outcome::Ok,
        },
        duration_us: raw.duration_us,
        ctx: CallContext {
            session: cx.session,
            call_id: raw.call_id,
            callsite: raw.callsite.as_deref().map(|c| cx.hasher.hash_str(c)),
            callsite_label: raw
                .callsite
                .as_deref()
                .and_then(readmeter_core::callsite_label),
            listener: None,
            transaction: None,
            mount: None,
            platform: cx.platform,
            attempt: raw.attempt.max(1),
            dev: cx.dev,
            in_render: false,
        },
        units: Default::default(),
    };
    env.units = billing::units(&env);
    Ok(env)
}

fn attributes(raw: &RawCall) -> Vec<FilterShape> {
    let mut filters = Vec::new();
    if raw.cold {
        filters.push(flag("cold"));
    }
    if let Some(memory) = raw.memory_mb {
        filters.push(number("memory_mb", memory));
    }
    if let Some(cpu) = raw.cpu_milli {
        filters.push(number("cpu_milli", cpu));
    }
    if raw.rtdb_download_bytes > 0 {
        filters.push(number("rtdb_download_bytes", raw.rtdb_download_bytes));
    }
    if raw.storage_ops > 0 {
        filters.push(number("storage_ops", raw.storage_ops));
    }
    if raw.trigger_writes > 0 {
        filters.push(number("trigger_writes", raw.trigger_writes));
    }
    filters
}

fn flag(field: &str) -> FilterShape {
    FilterShape {
        field: field.into(),
        op: "true".into(),
    }
}

fn number(field: &str, value: u64) -> FilterShape {
    FilterShape {
        field: field.into(),
        op: value.to_string(),
    }
}

fn shape(cx: &NormalizeContext, filters: &[FilterShape]) -> QueryShape {
    let mut hasher = cx.hasher.start().str(SERVICE_ID);
    for filter in filters {
        hasher = hasher.str(&filter.field).str(&filter.op);
    }
    let fingerprint = hasher.finish();
    QueryShape {
        filters: filters.to_vec(),
        order_by: Vec::new(),
        limit: None,
        limit_to_last: false,
        offset: None,
        start_cursor: false,
        end_cursor: false,
        projection: None,
        aggregations: Vec::new(),
        base_key: fingerprint,
        fingerprint,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use readmeter_core::{KeyedHasher, Platform};
    use readmeter_provider_api::Provider;
    use serde_json::json;

    use super::*;

    fn cx() -> NormalizeContext {
        NormalizeContext {
            hasher: KeyedHasher::new(11, 22),
            session: 5,
            platform: Platform::Server,
            dev: false,
        }
    }

    fn norm(value: serde_json::Value) -> Envelope {
        let bytes = serde_json::to_vec(&value).unwrap();
        crate::FirebaseProvider.normalize(&bytes, &cx()).unwrap()
    }

    fn attr<'a>(env: &'a Envelope, field: &str) -> Option<&'a str> {
        env.query
            .as_ref()
            .and_then(|query| query.filters.iter().find(|filter| filter.field == field))
            .map(|filter| filter.op.as_str())
    }

    #[test]
    fn the_key_is_the_function_and_cold_does_not_change_it() {
        let warm = norm(json!({
            "service": "functions",
            "op": "invoke",
            "name": "echo",
            "ts_ms": 1,
            "duration_us": 1_000_000,
            "memory_mb": 256,
            "response_bytes": 4
        }));
        let cold = norm(json!({
            "service": "functions",
            "op": "invoke",
            "name": "echo",
            "ts_ms": 2,
            "cold": true,
            "duration_us": 1_000_000,
            "memory_mb": 256,
            "cpu_milli": 1000,
            "response_bytes": 4,
            "request_bytes": 8,
            "reads": 3,
            "rtdb_download_bytes": 90,
            "storage_ops": 2,
            "trigger_writes": 4
        }));
        assert_eq!(warm.target.key, cold.target.key);
        assert_eq!(warm.target.template, "functions/echo");
        assert_eq!(cold.op, Op::Other("invoke".into()));
        assert_eq!(attr(&cold, "cold"), Some("true"));
        assert_eq!(attr(&warm, "cold"), None);
        assert_eq!(attr(&cold, "memory_mb"), Some("256"));
        assert_eq!(attr(&cold, "cpu_milli"), Some("1000"));
        assert_eq!(attr(&cold, "rtdb_download_bytes"), Some("90"));
        assert_eq!(attr(&cold, "storage_ops"), Some("2"));
        assert_eq!(attr(&cold, "trigger_writes"), Some("4"));
        assert_eq!(attr(&warm, "trigger_writes"), None);
        assert_eq!(cold.items(), 3);
        assert_eq!(cold.bytes(), 4);
        assert_eq!(
            cold.write.as_ref().map(|write| write.payload_bytes),
            Some(8)
        );
        assert_eq!(cold.units.get("invocations"), 1);
        assert_eq!(cold.units.get("gb_seconds"), 250);
        assert_eq!(cold.units.get("cpu_seconds"), 1000);
        assert_eq!(cold.units.get("egress_bytes"), 4);
        assert!(warm.write.is_none());
    }

    #[test]
    fn a_callable_does_not_bill_compute() {
        let call = norm(json!({
            "service": "functions",
            "op": "callable",
            "name": "echo",
            "ts_ms": 1,
            "duration_us": 1_000_000,
            "memory_mb": 256,
            "request_bytes": 10,
            "response_bytes": 12
        }));
        assert_eq!(call.op, Op::Other("callable".into()));
        assert_eq!(call.units.get("invocations"), 1);
        assert_eq!(call.units.get("egress_bytes"), 12);
        assert_eq!(call.units.get("gb_seconds"), 0);
        assert_eq!(call.units.get("cpu_seconds"), 0);
    }

    #[test]
    fn no_payload_url_or_project_leaks() {
        let env = norm(json!({
            "service": "functions",
            "op": "callable",
            "name": "https://us-central1-demo-readmeter.cloudfunctions.net/echo",
            "ts_ms": 1,
            "callsite": "https://secret-payload.example/src/File.ts:1?q=secret-payload&host=127.0.0.1",
            "error": "functions/secret-payload",
            "url": "http://127.0.0.1:5001/demo-readmeter/us-central1/echo",
            "data": "secret-payload",
            "token": "eyJhbGciOiJIUzI1NiJ9.payload.sig"
        }));
        let dump = format!("{env:?}");
        for secret in [
            "demo-readmeter",
            "secret-payload",
            "127.0.0.1",
            "cloudfunctions.net",
            "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        ] {
            assert!(!dump.contains(secret), "{secret} in {dump}");
        }
        assert_eq!(env.ctx.callsite_label.as_deref(), Some("src/File.ts:1"));
        assert_eq!(env.target.template, "functions/unknown");
        assert!(env.outcome.is_error());
        let code = match &env.outcome {
            Outcome::Error { code } => code.as_str(),
            Outcome::Ok => "",
        };
        assert_eq!(code, "unknown");
    }

    #[test]
    fn trigger_writes_keep_only_the_count() {
        // A shim that misbehaves and sends the trigger document, params, and
        // write paths must not get them into the envelope.
        let env = norm(json!({
            "service": "functions",
            "op": "invoke",
            "name": "onPost",
            "ts_ms": 1,
            "trigger_writes": 2,
            "document": "posts/secret-doc-id",
            "trigger": "posts/{id}",
            "params": { "id": "secret-doc-id" },
            "paths": ["posts/secret-doc-id", "posts/other-secret-id"]
        }));
        assert_eq!(attr(&env, "trigger_writes"), Some("2"));
        let dump = format!("{env:?}");
        for secret in ["secret-doc-id", "other-secret-id", "posts/"] {
            assert!(!dump.contains(secret), "{secret} in {dump}");
        }
        assert_eq!(env.target.template, "functions/onPost");
    }

    #[test]
    fn hostile_raw_calls_never_panic() {
        let provider = crate::FirebaseProvider;
        let cases = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"functions"}"#,
            r#"{"service":"functions","op":"callable","ts_ms":-1}"#,
            r#"{"service":"functions","op":"nope","ts_ms":1}"#,
            r#"{"service":"functions","op":"invoke","ts_ms":1,"name":{"url":"http://x"}}"#,
            r#"{"service":"functions","op":"callable","ts_ms":1,"error":1}"#,
            r#"{"service":"functions","op":"invoke","ts_ms":1,"memory_mb":-1}"#,
            r#"{"service":"functions","op":"invoke","ts_ms":1,"trigger_writes":"posts/a"}"#,
            r#"{"service":"functions","op":"invoke","ts_ms":1,"trigger_writes":-3}"#,
        ];
        for case in cases {
            let _ = provider.normalize(case.as_bytes(), &cx());
        }
    }
}
