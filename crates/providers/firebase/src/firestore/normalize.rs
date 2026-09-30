use readmeter_core::{
    CallContext, Envelope, FilterShape, HashBuilder, IdShape, Op, OrderShape, Outcome, QueryShape,
    ReadSource, ResultStats, Target, WriteStats,
};
use readmeter_provider_api::{NormalizeContext, NormalizeError, hash_json};

use super::SERVICE_ID;
use super::billing;
use super::raw::{Direction, RawCall, RawOp, RawQuery};
use crate::PROVIDER_ID;

/// Placeholder for document ids in templates.
const ID: &str = "{id}";

pub fn normalize(raw: RawCall, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let segments: Vec<&str> = raw.path.split('/').filter(|s| !s.is_empty()).collect();
    // An init with no database path is the only empty-path call. Its key is
    // fixed so every such client hashes the same way.
    let init_root = raw.op == RawOp::Init && segments.is_empty();
    if segments.is_empty() && !init_root {
        return Err(NormalizeError::Invalid("empty path".into()));
    }

    let (template, id_shape, key, query) = if init_root {
        (
            String::new(),
            None,
            cx.hasher.start().str(SERVICE_ID).str("init").finish(),
            None,
        )
    } else {
        let template = template(&segments, raw.collection_group);
        // Firestore paths alternate collection/document: even length = document.
        let id_shape = (!raw.collection_group && segments.len() % 2 == 0)
            .then(|| segments.last().map_or(IdShape::Other, |id| classify_id(id)));
        let base = cx
            .hasher
            .start()
            .str(SERVICE_ID)
            .bool(raw.collection_group)
            .str(&segments.join("/"));
        let (key, query) = match &raw.query {
            Some(q) => {
                let base = hash_query_base(base, q);
                // Aggregations stay out of base_key but in the target key, so a
                // count and a fetch of the same query do not collapse into one read.
                let key = hash_paging(hash_aggregations(base.clone(), q), q).finish();
                (
                    key,
                    Some(shape(q, base.finish(), fingerprint(cx, &template, q))),
                )
            }
            None => (base.finish(), None),
        };
        (template, id_shape, key, query)
    };

    let op = match raw.op {
        RawOp::Get => Op::Get,
        RawOp::Query => Op::Query,
        RawOp::Aggregate => Op::Aggregate,
        RawOp::Create => Op::Create,
        RawOp::Set => Op::Set,
        RawOp::Update => Op::Update,
        RawOp::Delete => Op::Delete,
        RawOp::Commit => {
            let c = raw.commit.ok_or_else(|| {
                NormalizeError::Invalid("`commit` op requires `commit` field".into())
            })?;
            Op::Commit {
                writes: c.writes,
                deletes: c.deletes,
                transactional: c.transactional,
            }
        }
        RawOp::Subscribe => Op::Subscribe,
        RawOp::Snapshot => Op::Snapshot {
            initial: raw.initial,
        },
        RawOp::Unsubscribe => Op::Unsubscribe,
        RawOp::Usage => Op::Usage,
        RawOp::Init => Op::Init,
    };

    let setup = if raw.op == RawOp::Init {
        Some(
            raw.setup
                .ok_or_else(|| NormalizeError::Invalid("init requires setup".into()))?,
        )
    } else {
        None
    };
    // Source is only meaningful on a single get or a query. A present but
    // unknown string already failed while parsing.
    let source = if matches!(raw.op, RawOp::Get | RawOp::Query) {
        raw.source.unwrap_or_default()
    } else {
        ReadSource::Default
    };
    let write = if matches!(raw.op, RawOp::Create | RawOp::Set | RawOp::Update) {
        raw.write.map(|w| {
            let payload_key = match w.digest {
                Some(digest) if w.transforms.is_empty() => {
                    Some(cx.hasher.start().str("payload").u64(digest).finish())
                }
                _ => None,
            };
            WriteStats {
                max_field_bytes: w.max_field_bytes,
                payload_bytes: w.payload_bytes,
                transforms: w.transforms,
                payload_key,
            }
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
            id_shape,
            collection_group: raw.collection_group,
        },
        query,
        result: raw.result.map(|r| ResultStats {
            items: r.docs,
            bytes: r.bytes,
            from_cache: r.from_cache,
            index_entries: r.index_entries,
        }),
        usage: if raw.op == RawOp::Usage {
            raw.usage
        } else {
            None
        },
        source,
        write,
        setup,
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
            listener: raw.listener,
            transaction: raw.transaction,
            mount: raw.mount,
            platform: cx.platform,
            attempt: raw.attempt.max(1),
            dev: cx.dev,
            in_render: raw.in_render,
        },
        units: Default::default(),
    };
    env.units = billing::units(&env);
    Ok(env)
}

fn template(segments: &[&str], collection_group: bool) -> String {
    if collection_group {
        return format!("**/{}", segments.join("/"));
    }
    segments
        .iter()
        .enumerate()
        .map(|(i, s)| if i % 2 == 1 { ID } else { *s })
        .collect::<Vec<_>>()
        .join("/")
}

/// Filters (with values), ordering and `select`.
/// Aggregations and paging are not included: a `count()` and a fetch of the
/// same query share this hash, and so do pages of one query.
fn hash_query_base(mut h: HashBuilder, q: &RawQuery) -> HashBuilder {
    h = h.u64(q.filters.len() as u64);
    for f in &q.filters {
        h = hash_json(h.str(&f.field).str(&f.op), &f.value);
    }
    h = h.u64(q.order_by.len() as u64);
    for o in &q.order_by {
        h = h.str(&o.field).bool(o.direction == Direction::Desc);
    }
    match &q.select {
        Some(fields) => fields
            .iter()
            .fold(h.tag(1).u64(fields.len() as u64), |h, f| h.str(f)),
        None => h.tag(0),
    }
}

/// Aggregations belong to `target.key` only, after [`hash_query_base`].
fn hash_aggregations(h: HashBuilder, q: &RawQuery) -> HashBuilder {
    q.aggregations
        .iter()
        .fold(h.u64(q.aggregations.len() as u64), |h, a| h.str(a))
}

fn hash_paging(h: HashBuilder, q: &RawQuery) -> HashBuilder {
    let h = h
        .opt_u64(q.limit.map(u64::from))
        .bool(q.limit_to_last)
        .opt_u64(q.offset.map(u64::from));
    let h = match &q.start {
        Some(v) => hash_json(h.tag(1), v),
        None => h.tag(0),
    };
    match &q.end {
        Some(v) => hash_json(h.tag(1), v),
        None => h.tag(0),
    }
}

/// Value-free shape hash, comparable across users of a project.
fn fingerprint(cx: &NormalizeContext, template: &str, q: &RawQuery) -> u64 {
    let mut h = cx.hasher.start().str(SERVICE_ID).str(template);
    for f in &q.filters {
        h = h.str(&f.field).str(&f.op);
    }
    for o in &q.order_by {
        h = h.str(&o.field).bool(o.direction == Direction::Desc);
    }
    for a in &q.aggregations {
        h = h.str(a);
    }
    h.bool(q.limit.is_some()).bool(q.offset.is_some()).finish()
}

fn shape(q: &RawQuery, base_key: u64, fingerprint: u64) -> QueryShape {
    QueryShape {
        filters: q
            .filters
            .iter()
            .map(|f| FilterShape {
                field: f.field.clone(),
                op: f.op.clone(),
            })
            .collect(),
        order_by: q
            .order_by
            .iter()
            .map(|o| OrderShape {
                field: o.field.clone(),
                descending: o.direction == Direction::Desc,
            })
            .collect(),
        limit: q.limit,
        limit_to_last: q.limit_to_last,
        offset: q.offset,
        start_cursor: q.start.is_some(),
        end_cursor: q.end.is_some(),
        projection: q.select.clone(),
        aggregations: q.aggregations.clone(),
        base_key,
        fingerprint,
    }
}

pub fn classify_id(id: &str) -> IdShape {
    let bytes = id.as_bytes();
    if !bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit) {
        // Epoch seconds (10 digits) or milliseconds (13 digits) in 2001..2286.
        return if (bytes.len() == 10 || bytes.len() == 13) && bytes[0] == b'1' {
            IdShape::TimestampLike
        } else {
            IdShape::Numeric
        };
    }
    if is_uuid(bytes) {
        return IdShape::Uuid;
    }
    if is_iso_date_prefix(bytes) {
        return IdShape::TimestampLike;
    }
    if bytes.len() == 20 && bytes.iter().all(u8::is_ascii_alphanumeric) {
        return IdShape::AutoId;
    }
    IdShape::Other
}

fn is_uuid(b: &[u8]) -> bool {
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `YYYY-MM-DD...`
fn is_iso_date_prefix(b: &[u8]) -> bool {
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use readmeter_core::{KeyedHasher, Platform};
    use serde_json::json;

    use super::*;

    fn cx() -> NormalizeContext {
        NormalizeContext {
            hasher: KeyedHasher::new(11, 22),
            session: 5,
            platform: Platform::Browser,
            dev: false,
        }
    }

    fn raw_call(v: serde_json::Value) -> RawCall {
        let bytes = serde_json::to_vec(&v).unwrap();
        let parsed = readmeter_provider_api::json::parse(&bytes).unwrap();
        RawCall::from_json(&parsed).unwrap()
    }

    fn norm(v: serde_json::Value) -> Envelope {
        normalize(raw_call(v), &cx()).unwrap()
    }

    #[test]
    fn templates_and_id_shapes() {
        let doc = norm(
            json!({"op": "get", "ts_ms": 1, "path": "users/Xb3kD9aQ2mLp7rT1vY0z", "result": {"docs": 1}}),
        );
        assert_eq!(doc.target.template, "users/{id}");
        assert_eq!(doc.target.id_shape, Some(IdShape::AutoId));
        assert_eq!(doc.units.get("reads"), 1);

        let col = norm(
            json!({"op": "query", "ts_ms": 1, "path": "/users/u1/orders/", "query": {}, "result": {"docs": 3}}),
        );
        assert_eq!(col.target.template, "users/{id}/orders");
        assert_eq!(col.target.id_shape, None);

        let cg = norm(
            json!({"op": "query", "ts_ms": 1, "path": "orders", "collection_group": true, "query": {}}),
        );
        assert_eq!(cg.target.template, "**/orders");
    }

    #[test]
    fn values_change_key_but_not_fingerprint() {
        let q = |uid: &str, limit: u32| {
            norm(json!({
                "op": "query", "ts_ms": 1, "path": "posts",
                "query": {"filters": [{"field": "author", "op": "==", "value": uid}], "limit": limit}
            }))
        };
        let (a, b, a2) = (q("alice", 10), q("bob", 10), q("alice", 20));
        let (qa, qb, qa2) = (a.query.unwrap(), b.query.unwrap(), a2.query.unwrap());
        assert_ne!(a.target.key, b.target.key);
        assert_eq!(qa.fingerprint, qb.fingerprint);
        assert_ne!(qa.base_key, qb.base_key);
        assert_eq!(qa.base_key, qa2.base_key, "paging excluded from base key");
        assert_ne!(a.target.key, a2.target.key, "paging included in key");
    }

    #[test]
    fn count_and_fetch_share_base_key_not_target_key() {
        let count = norm(json!({
            "op": "aggregate", "ts_ms": 1, "path": "tasks",
            "query": {
                "filters": [{"field": "status", "op": "==", "value": "open"}],
                "aggregations": ["count"]
            }
        }));
        let fetch = norm(json!({
            "op": "query", "ts_ms": 2, "path": "tasks",
            "query": {
                "filters": [{"field": "status", "op": "==", "value": "open"}],
                "limit": 25
            }
        }));
        let summed = norm(json!({
            "op": "aggregate", "ts_ms": 3, "path": "tasks",
            "query": {
                "filters": [{"field": "status", "op": "==", "value": "open"}],
                "aggregations": ["sum:total"]
            }
        }));
        let projected = norm(json!({
            "op": "query", "ts_ms": 4, "path": "tasks",
            "query": {
                "filters": [{"field": "status", "op": "==", "value": "open"}],
                "select": ["title"]
            }
        }));
        let (qc, qf) = (count.query.unwrap(), fetch.query.unwrap());
        assert_eq!(qc.base_key, qf.base_key);
        assert_eq!(qc.base_key, summed.query.unwrap().base_key);
        assert_ne!(count.target.key, fetch.target.key);
        assert_ne!(count.target.key, summed.target.key);
        assert_ne!(
            qf.base_key,
            projected.query.unwrap().base_key,
            "select stays in base key"
        );
    }

    #[test]
    fn no_raw_values_or_ids_leak() {
        let env = norm(json!({
            "op": "query", "ts_ms": 1, "path": "users/secret-user-id/orders",
            "callsite": "https://secret.example/src/File.tsx:1?q=secret",
            "query": {"filters": [{"field": "email", "op": "==", "value": "secret@example.com"}], "start": ["secret-cursor"]}
        }));
        let dump = format!("{env:?}");
        assert!(!dump.contains("secret"), "{dump}");
        assert_eq!(env.ctx.callsite_label.as_deref(), Some("src/File.tsx:1"));
    }

    #[test]
    fn commit_requires_payload() {
        let raw = raw_call(json!({"op": "commit", "ts_ms": 1, "path": "a"}));
        assert!(normalize(raw, &cx()).is_err());
        let env = norm(
            json!({"op": "commit", "ts_ms": 1, "path": "a", "commit": {"writes": 2, "transactional": true}}),
        );
        assert_eq!(env.units.get("writes"), 2);
    }

    #[test]
    fn classify() {
        assert_eq!(classify_id("1727481600"), IdShape::TimestampLike);
        assert_eq!(classify_id("1727481600000"), IdShape::TimestampLike);
        assert_eq!(classify_id("42"), IdShape::Numeric);
        assert_eq!(classify_id("2026-09-28T10:00:00Z"), IdShape::TimestampLike);
        assert_eq!(
            classify_id("0190a8f0-7c1e-7a2b-9c3d-4e5f60718293"),
            IdShape::Uuid
        );
        assert_eq!(classify_id("alice"), IdShape::Other);
    }

    /// Shims are other people's code: any JSON must give an error or an
    /// envelope, never a panic.
    #[test]
    fn hostile_raw_calls_never_panic() {
        use readmeter_provider_api::Provider;
        let provider = crate::FirebaseProvider;
        let cases = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"firestore"}"#,
            r#"{"service":"firestore","op":"get","ts_ms":-1,"path":"a"}"#,
            r#"{"service":"firestore","op":"get","ts_ms":1,"path":"////"}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{"limit":-5}}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{"filters":[{"field":"x","op":"==","value":{"a":[1,{"b":[[[null]]]}]}}]}}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","result":{"docs":18446744073709551615,"bytes":18446744073709551615},"query":{"offset":4294967295}}"#,
            r#"{"service":"firestore","op":"aggregate","ts_ms":1,"path":"a","result":{"index_entries":18446744073709551615}}"#,
            r#"{"service":"firestore","op":"commit","ts_ms":1,"path":"a","commit":{"writes":4294967295,"deletes":4294967295}}"#,
            r#"{"service":"firestore","op":"snapshot","ts_ms":1,"path":"a/b/c/d/e/f/g/h","attempt":0}"#,
            r#"{"service":"firestore","op":"get","ts_ms":1,"path":"\u0000/\ud800"}"#,
        ];
        for case in cases {
            let _ = provider.normalize(case.as_bytes(), &cx());
        }
        let deep = format!(
            r#"{{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{{"filters":[{{"field":"x","op":"==","value":{}1{}}}]}}}}"#,
            "[".repeat(10_000),
            "]".repeat(10_000)
        );
        assert!(
            provider.normalize(deep.as_bytes(), &cx()).is_err(),
            "recursion limit must reject"
        );
    }

    #[test]
    fn wrong_types_are_errors() {
        let bad = [
            json!({"op": 1, "ts_ms": 1, "path": "a"}),
            json!({"op": "get", "ts_ms": "1", "path": "a"}),
            json!({"op": "get", "ts_ms": 1.5, "path": "a"}),
            json!({"op": "get", "ts_ms": 1, "path": "a", "query": {"limit": -1}}),
            json!({"op": "get", "ts_ms": 1}),
            json!({"op": "nope", "ts_ms": 1, "path": "a"}),
            json!({"op": "get", "ts_ms": 1, "path": "a", "source": 1}),
            json!({"op": "get", "ts_ms": 1, "path": "a", "source": "disk"}),
            json!({"op": "get", "ts_ms": 1, "path": "a", "transaction": "1"}),
            json!({"op": "get", "ts_ms": 1, "path": "a", "transaction": -1}),
            json!({"op": "set", "ts_ms": 1, "path": "a/b", "write": []}),
            json!({"op": "set", "ts_ms": 1, "path": "a/b", "write": {"transforms": []}}),
            json!({"op": "set", "ts_ms": 1, "path": "a/b", "write": {
                "max_field_bytes": 1, "payload_bytes": 1, "digest": "0123456789ABCDEF"
            }}),
            json!({"op": "set", "ts_ms": 1, "path": "a/b", "write": {
                "max_field_bytes": 1, "payload_bytes": 1, "digest": "0123456789abcde"
            }}),
            json!({"op": "set", "ts_ms": 1, "path": "a/b", "write": {
                "max_field_bytes": 1, "payload_bytes": 1, "digest": 1
            }}),
            json!({"op": "usage", "ts_ms": 1, "path": "a", "usage": {"items_used": -1}}),
            json!({"op": "usage", "ts_ms": 1, "path": "a", "usage": {"items_used": true}}),
            json!({"op": "init", "ts_ms": 1, "path": "", "setup": {"cache": "disk"}}),
            json!({"op": "init", "ts_ms": 1, "path": "", "setup": []}),
        ];
        for v in bad {
            let bytes = serde_json::to_vec(&v).unwrap();
            let parsed = readmeter_provider_api::json::parse(&bytes).unwrap();
            assert!(RawCall::from_json(&parsed).is_err(), "{v}");
        }
    }

    #[test]
    fn new_fields_normalize() {
        let sourced = norm(json!({
            "op": "get", "ts_ms": 1, "path": "users/u1",
            "source": "server", "transaction": 7,
        }));
        assert_eq!(sourced.source, ReadSource::Server);
        assert_eq!(sourced.ctx.transaction, Some(7));

        let cached = norm(json!({
            "op": "query", "ts_ms": 1, "path": "users", "source": "cache", "query": {},
        }));
        assert_eq!(cached.source, ReadSource::Cache);

        let ignored = norm(json!({
            "op": "delete", "ts_ms": 1, "path": "users/u1",
            "source": "server",
            "write": {"max_field_bytes": 4, "payload_bytes": 4, "digest": "0123456789abcdef"},
            "setup": {"cache": "memory", "shared_tabs": true},
        }));
        assert_eq!(ignored.source, ReadSource::Default);
        assert!(ignored.write.is_none());
        assert!(ignored.setup.is_none());

        let used = norm(json!({
            "op": "usage", "ts_ms": 1, "path": "users",
            "usage": {"read_items": true, "items_used": 3},
        }));
        assert_eq!(used.usage.unwrap().items_used, Some(3));

        let init = norm(json!({
            "op": "init", "ts_ms": 1, "path": "",
            "setup": {"cache": "persistent", "shared_tabs": true},
        }));
        assert_eq!(init.op, Op::Init);
        assert_eq!(init.target.template, "");
        assert_eq!(init.target.id_shape, None);
        assert!(init.units.is_empty());
        assert_eq!(
            init.setup,
            Some(readmeter_core::ClientSetup {
                cache: readmeter_core::CacheKind::Persistent,
                shared_tabs: true,
            })
        );
        let keyed = cx().hasher.start().str(SERVICE_ID).str("init").finish();
        assert_eq!(init.target.key, keyed);

        let named = norm(json!({
            "op": "init", "ts_ms": 1, "path": "projects/p/databases/d",
            "setup": {"cache": "memory"},
        }));
        assert_eq!(named.target.template, "projects/{id}/databases/{id}");
        assert!(named.setup.is_some());
        assert!(
            normalize(
                raw_call(json!({"op": "init", "ts_ms": 1, "path": ""})),
                &cx()
            )
            .is_err()
        );
    }

    #[test]
    fn payload_key_is_keyed_and_does_not_copy_the_digest() {
        let digest = "0123456789abcdef";
        let body = |key: (u64, u64)| {
            let mut cx = cx();
            cx.hasher = KeyedHasher::new(key.0, key.1);
            normalize(
                raw_call(json!({
                    "op": "set", "ts_ms": 1, "path": "users/u1",
                    "transaction": 4,
                    "write": {
                        "max_field_bytes": 7,
                        "payload_bytes": 7,
                        "transforms": ["nope", "increment", "increment"],
                        "digest": digest,
                    }
                })),
                &cx,
            )
            .unwrap()
        };
        let with_transform = body((11, 22));
        let write = with_transform.write.unwrap();
        assert_eq!(write.transforms, vec!["increment".to_owned()]);
        assert_eq!(write.payload_key, None, "transforms suppress the key");
        assert_eq!(with_transform.ctx.transaction, Some(4));

        let plain = |key: (u64, u64)| {
            let mut cx = cx();
            cx.hasher = KeyedHasher::new(key.0, key.1);
            normalize(
                raw_call(json!({
                    "op": "update", "ts_ms": 1, "path": "users/u1",
                    "write": {
                        "max_field_bytes": 7,
                        "payload_bytes": 7,
                        "transforms": ["not-a-transform"],
                        "digest": digest,
                    }
                })),
                &cx,
            )
            .unwrap()
            .write
            .unwrap()
            .payload_key
            .unwrap()
        };
        let a = plain((11, 22));
        let b = plain((1, 2));
        assert_ne!(a, b, "two hash keys must not agree");
        assert_ne!(a, u64::from_str_radix(digest, 16).unwrap());
        let dumped = format!("{a:x} {b:x}");
        assert!(
            !dumped.contains(digest),
            "keyed digest leaked into payload_key: {dumped}"
        );

        let leaked = norm(json!({
            "op": "set", "ts_ms": 1, "path": "users/secret-user/orders",
            "callsite": "https://secret.example/src/File.tsx:1?q=secret",
            "transaction": 4,
            "write": {
                "max_field_bytes": 1,
                "payload_bytes": 1,
                "digest": digest,
            }
        }));
        let dump = format!("{leaked:?}");
        assert!(!dump.contains(digest), "{dump}");
        assert!(!dump.contains("secret"), "{dump}");
        assert!(dump.contains("transaction: Some(4)"), "{dump}");
        let encoded = serde_json::to_string(&leaked).unwrap();
        assert!(
            !encoded.contains(digest),
            "digest leaked into the encoded envelope: {encoded}"
        );
        let raw = u64::from_str_radix(digest, 16).unwrap().to_string();
        assert!(
            !encoded.contains(&raw),
            "digest integer leaked into the encoded envelope: {encoded}"
        );
    }
}
