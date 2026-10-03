use readmeter_core::{
    CallContext, Envelope, FilterShape, HashBuilder, IdShape, Op, OrderShape, Outcome, QueryShape,
    ResultStats, Target,
};
use readmeter_provider_api::{NormalizeContext, NormalizeError, hash_json};

use super::SERVICE_ID;
use super::billing;
use super::raw::{RawCall, RawOp, RawQuery};

use crate::PROVIDER_ID;

/// Placeholder for redacted path segments.
const ID: &str = "{id}";

pub fn normalize(mut raw: RawCall, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    // The warning names the ordered child but not the rest of the query, so
    // its shape is just that order. The field name is allowed in a shape.
    if raw.op == RawOp::IndexWarning && raw.query.is_none() {
        raw.query = raw.order_by_child.take().map(|child| RawQuery {
            order_by: Some(child),
            ..RawQuery::default()
        });
    }
    let segments: Vec<&str> = raw.path.split('/').filter(|s| !s.is_empty()).collect();
    let template = template(&segments);
    let id_shape = segments.last().copied().and_then(segment_id);
    let joined = segments.join("/");
    let base = cx.hasher.start().str(SERVICE_ID).str(&joined);
    let (key, query) = match raw.query.as_ref().filter(|q| q.has_constraints()) {
        Some(q) => {
            let base = hash_query_base(base, q);
            let key = hash_paging(base.clone(), q).finish();
            (
                key,
                Some(shape(q, base.finish(), fingerprint(cx, &template, q))),
            )
        }
        None => (base.finish(), None),
    };

    let op = match raw.op {
        RawOp::Get if query.is_some() => Op::Query,
        RawOp::Get => Op::Get,
        RawOp::Query => Op::Query,
        RawOp::Create => Op::Create,
        RawOp::Set => Op::Set,
        RawOp::Update => Op::Update,
        RawOp::Delete => Op::Delete,
        RawOp::Subscribe => Op::Subscribe,
        RawOp::Snapshot => Op::Snapshot {
            initial: raw.initial,
        },
        RawOp::Unsubscribe => Op::Unsubscribe,
        RawOp::ChildAdded => Op::Other("child_added".into()),
        RawOp::ChildChanged => Op::Other("child_changed".into()),
        RawOp::ChildRemoved => Op::Other("child_removed".into()),
        RawOp::ChildMoved => Op::Other("child_moved".into()),
        RawOp::GoOnline => Op::Other("go_online".into()),
        RawOp::GoOffline => Op::Other("go_offline".into()),
        RawOp::IndexWarning => Op::Other("index_warning".into()),
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
            collection_group: false,
        },
        query,
        result: raw.result.map(|r| ResultStats {
            items: r.children,
            bytes: r.bytes,
            from_cache: r.from_cache,
            index_entries: None,
        }),
        usage: None,
        source: Default::default(),
        write: None,
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
            listener: raw.listener,
            transaction: None,
            mount: raw.mount,
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

fn template(segments: &[&str]) -> String {
    if segments.is_empty() {
        return "/".to_owned();
    }
    segments
        .iter()
        .map(|s| if segment_id(s).is_some() { ID } else { *s })
        .collect::<Vec<_>>()
        .join("/")
}

/// `Some` when the segment is an identifier and must leave the template.
/// Static keys (alphabetic names, short slugs) stay.
fn segment_id(id: &str) -> Option<IdShape> {
    let bytes = id.as_bytes();
    if !bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit) {
        return Some(
            if (bytes.len() == 10 || bytes.len() == 13) && bytes[0] == b'1' {
                IdShape::TimestampLike
            } else {
                IdShape::Numeric
            },
        );
    }
    if is_uuid(bytes) {
        return Some(IdShape::Uuid);
    }
    if is_iso_date_prefix(bytes) {
        return Some(IdShape::TimestampLike);
    }
    if bytes.len() == 20 && bytes.iter().all(u8::is_ascii_alphanumeric) {
        return Some(IdShape::AutoId);
    }
    if is_push_id(bytes) {
        return Some(IdShape::AutoId);
    }
    if is_long_token(bytes) {
        return Some(IdShape::Other);
    }
    if crate::path::personal_segment(id) {
        return Some(IdShape::Other);
    }
    None
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

/// Firebase push id: 20 chars from the push alphabet, and not a plain word.
/// Plain words have no `-`, `_`, or digit, so `orderByChild` keys stay.
fn is_push_id(b: &[u8]) -> bool {
    if b.len() != 20 {
        return false;
    }
    let mut marked = false;
    for &c in b {
        let ok = matches!(c, b'-' | b'0'..=b'9' | b'A'..=b'Z' | b'_' | b'a'..=b'z');
        if !ok {
            return false;
        }
        if c == b'-' || c == b'_' || c.is_ascii_digit() {
            marked = true;
        }
    }
    marked
}

/// Long opaque token (Firebase UID and similar): 16..=128 of `[A-Za-z0-9_-]`
/// with both a letter and a digit. Short slugs such as `room_1` stay.
fn is_long_token(b: &[u8]) -> bool {
    if b.len() < 16 || b.len() > 128 {
        return false;
    }
    let mut digit = false;
    let mut letter = false;
    for &c in b {
        if c.is_ascii_digit() {
            digit = true;
        } else if c.is_ascii_alphabetic() {
            letter = true;
        } else if c != b'-' && c != b'_' {
            return false;
        }
    }
    digit && letter
}

fn hash_query_base(mut h: HashBuilder, q: &RawQuery) -> HashBuilder {
    h = h.u64(q.filters.len() as u64);
    for f in &q.filters {
        h = hash_json(h.str(&f.field).str(&f.op), &f.value);
    }
    match &q.order_by {
        Some(field) => h.tag(1).str(field),
        None => h.tag(0),
    }
}

fn hash_paging(h: HashBuilder, q: &RawQuery) -> HashBuilder {
    let h = h.opt_u64(q.limit.map(u64::from)).bool(q.limit_to_last);
    let h = match &q.start {
        Some(v) => hash_json(h.tag(1), v),
        None => h.tag(0),
    };
    match &q.end {
        Some(v) => hash_json(h.tag(1), v),
        None => h.tag(0),
    }
}

fn fingerprint(cx: &NormalizeContext, template: &str, q: &RawQuery) -> u64 {
    let mut h = cx.hasher.start().str(SERVICE_ID).str(template);
    for f in &q.filters {
        h = h.str(&f.field).str(&f.op);
    }
    if let Some(field) = &q.order_by {
        h = h.str(field);
    }
    h.bool(q.limit.is_some())
        .bool(q.limit_to_last)
        .bool(q.start.is_some())
        .bool(q.end.is_some())
        .finish()
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
            .map(|field| OrderShape {
                field: field.clone(),
                descending: false,
            })
            .collect(),
        limit: q.limit,
        limit_to_last: q.limit_to_last,
        offset: None,
        start_cursor: q.start.is_some(),
        end_cursor: q.end.is_some(),
        projection: None,
        aggregations: Vec::new(),
        base_key,
        fingerprint,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

    use readmeter_core::{KeyedHasher, Platform};
    use readmeter_provider_api::Provider;
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
    fn templates_redact_ids_and_keep_static_keys() {
        let push = "-NabcDEFghi123456789";
        assert_eq!(push.len(), 20);
        let doc = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": format!("posts/{push}/owner/secretUserId99abcd"),
            "result": {"children": 0, "bytes": 12}
        }));
        assert_eq!(doc.target.template, "posts/{id}/owner/{id}");
        assert_eq!(doc.target.id_shape, Some(IdShape::Other));
        assert_eq!(doc.op, Op::Get);
        assert_eq!(doc.units.get("download_bytes"), 12);

        let nested = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": "/posts/42/owner/550e8400-e29b-41d4-a716-446655440000/",
        }));
        assert_eq!(nested.target.template, "posts/{id}/owner/{id}");
        assert_eq!(nested.target.id_shape, Some(IdShape::Uuid));

        let slug = norm(json!({"op": "get", "ts_ms": 1, "path": "rooms/room_1"}));
        assert_eq!(slug.target.template, "rooms/room_1");
        assert_eq!(slug.target.id_shape, None);

        let email = norm(json!({"op": "get", "ts_ms": 1, "path": "users/alice@example.com"}));
        assert_eq!(email.target.template, "users/{id}");
        let phone = norm(json!({"op": "get", "ts_ms": 1, "path": "users/+1 (555) 123-4567"}));
        assert_eq!(phone.target.template, "users/{id}");
        let ip = norm(json!({"op": "get", "ts_ms": 1, "path": "users/192.168.0.1"}));
        assert_eq!(ip.target.template, "users/{id}");
        let long = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": format!("users/{}", "a".repeat(41)),
        }));
        assert_eq!(long.target.template, "users/{id}");

        let root = norm(json!({"op": "get", "ts_ms": 1, "path": "///"}));
        assert_eq!(root.target.template, "/");
        assert_eq!(root.target.id_shape, None);
    }

    #[test]
    fn mount_id_is_carried_and_optional() {
        let mounted = norm(
            json!({"op": "subscribe", "ts_ms": 1, "path": "rooms", "listener": 2, "mount": 9}),
        );
        assert_eq!(mounted.ctx.mount, Some(9));
        let plain = norm(json!({"op": "subscribe", "ts_ms": 1, "path": "rooms", "listener": 2}));
        assert_eq!(plain.ctx.mount, None);
    }

    #[test]
    fn constrained_get_is_a_query_and_paging_stays_out_of_base_key() {
        let limited = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": "posts",
            "query": {
                "order_by": "score",
                "limit": 10,
                "filters": [{"field": "score", "op": "==", "value": "secret-score"}],
                "start": "secret-cursor"
            },
            "result": {"children": 10, "bytes": 100}
        }));
        assert_eq!(limited.op, Op::Query);
        let q = limited.query.unwrap();
        assert_eq!(q.limit, Some(10));
        assert!(q.start_cursor);
        assert_eq!(q.order_by[0].field, "score");
        assert_eq!(q.filters[0].op, "==");

        let other_page = norm(json!({
            "op": "query",
            "ts_ms": 1,
            "path": "posts",
            "query": {
                "order_by": "score",
                "limit": 25,
                "limit_to_last": true,
                "filters": [{"field": "score", "op": "==", "value": "secret-score"}]
            }
        }));
        let page = other_page.query.unwrap();
        assert_eq!(q.base_key, page.base_key);
        assert_ne!(limited.target.key, other_page.target.key);
        assert_ne!(
            q.fingerprint, page.fingerprint,
            "limitToLast is part of the shape"
        );

        let other_cursor = norm(json!({
            "op": "query",
            "ts_ms": 1,
            "path": "posts",
            "query": {
                "order_by": "score",
                "limit": 10,
                "filters": [{"field": "score", "op": "==", "value": "secret-score"}],
                "start": "other-cursor"
            }
        }));
        let cursor = other_cursor.query.unwrap();
        assert_eq!(q.base_key, cursor.base_key);
        assert_eq!(q.fingerprint, cursor.fingerprint);
        assert_ne!(limited.target.key, other_cursor.target.key);

        let other_value = norm(json!({
            "op": "query",
            "ts_ms": 1,
            "path": "posts",
            "query": {
                "order_by": "score",
                "limit": 10,
                "filters": [{"field": "score", "op": "==", "value": "other"}]
            }
        }));
        assert_ne!(limited.target.key, other_value.target.key);
        assert_ne!(q.base_key, other_value.query.unwrap().base_key);
    }

    #[test]
    fn child_events_transactions_and_connections() {
        let child = norm(json!({
            "op": "child_added",
            "ts_ms": 1,
            "path": "posts",
            "result": {"children": 0, "bytes": 8}
        }));
        assert_eq!(child.op, Op::Other("child_added".into()));
        assert_eq!(child.units.get("download_bytes"), 8);

        let txn = norm(json!({
            "op": "update",
            "ts_ms": 1,
            "path": "counters/online",
            "result": {"bytes": 4}
        }));
        assert_eq!(txn.op, Op::Update);
        assert_eq!(txn.units.get("download_bytes"), 4);

        let plain = norm(json!({"op": "set", "ts_ms": 1, "path": "counters/online"}));
        assert!(plain.units.is_empty());

        let on = norm(json!({"op": "go_online", "ts_ms": 1, "path": ""}));
        assert_eq!(on.op, Op::Other("go_online".into()));
        assert_eq!(on.units.get("connections"), 1);
        assert_eq!(on.target.template, "/");

        let cached = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": "posts",
            "result": {"bytes": 9, "from_cache": true}
        }));
        assert!(cached.units.is_empty());

        let failed = norm(json!({
            "op": "get",
            "ts_ms": 1,
            "path": "posts",
            "result": {"bytes": 9},
            "error": "permission-denied"
        }));
        assert!(failed.units.is_empty());
    }

    #[test]
    fn no_raw_values_or_ids_leak() {
        let env = norm(json!({
            "op": "query",
            "ts_ms": 1,
            "path": "posts/-NabcDEFghi123456789/owner/secretUserId99abcd",
            "callsite": "https://secret.example/src/File.tsx:1?q=secret",
            "query": {
                "order_by": "title",
                "filters": [{"field": "title", "op": "==", "value": "secret-title"}],
                "start": "secret-cursor"
            }
        }));
        let dump = format!("{env:?}");
        assert!(!dump.contains("secret"), "{dump}");
        assert_eq!(env.ctx.callsite_label.as_deref(), Some("src/File.tsx:1"));
        assert_eq!(env.target.template, "posts/{id}/owner/{id}");
    }

    #[test]
    fn index_warning_is_a_templated_order_with_no_units() {
        let env = norm(json!({
            "op": "index_warning",
            "ts_ms": 1,
            "path": "/rooms/-NabcDEFghi123456789/scores/secretUserId99abcd",
            "order_by_child": "pts",
            "call_id": 7,
            "callsite": "https://secret.example/src/Board.tsx:12?token=secret"
        }));
        assert_eq!(env.op, Op::Other("index_warning".into()));
        assert_eq!(env.target.template, "rooms/{id}/scores/{id}");
        let q = env.query.as_ref().unwrap();
        assert_eq!(q.order_by.len(), 1);
        assert_eq!(q.order_by[0].field, "pts");
        assert_eq!(q.limit, None);
        assert!(env.units.is_empty());
        assert!(env.result.is_none());
        assert_eq!(env.ctx.callsite_label.as_deref(), Some("src/Board.tsx:12"));
        let dump = format!("{env:?}");
        assert!(!dump.contains("secret"), "{dump}");
        assert!(!dump.contains("NabcDEF"), "{dump}");

        let root = norm(
            json!({"op": "index_warning", "ts_ms": 1, "path": "/", "order_by_child": "$value"}),
        );
        assert_eq!(root.target.template, "/");
        assert_eq!(root.query.unwrap().order_by[0].field, "$value");

        let bare = norm(json!({"op": "index_warning", "ts_ms": 1, "path": "posts"}));
        assert!(bare.query.is_none());
    }

    #[test]
    fn classify() {
        assert_eq!(segment_id("1727481600"), Some(IdShape::TimestampLike));
        assert_eq!(segment_id("1727481600000"), Some(IdShape::TimestampLike));
        assert_eq!(segment_id("42"), Some(IdShape::Numeric));
        assert_eq!(
            segment_id("2026-09-28T10:00:00Z"),
            Some(IdShape::TimestampLike)
        );
        assert_eq!(
            segment_id("0190a8f0-7c1e-7a2b-9c3d-4e5f60718293"),
            Some(IdShape::Uuid)
        );
        assert_eq!(segment_id("-NabcDEFghi123456789"), Some(IdShape::AutoId));
        assert_eq!(segment_id("Xb3kD9aQ2mLp7rT1vY0z"), Some(IdShape::AutoId));
        assert_eq!(segment_id("secretUserId99abcd"), Some(IdShape::Other));
        assert_eq!(segment_id("alice@example.com"), Some(IdShape::Other));
        assert_eq!(segment_id("+1 (555) 123-4567"), Some(IdShape::Other));
        assert_eq!(segment_id("192.168.0.1"), Some(IdShape::Other));
        assert_eq!(segment_id("[2001:db8::1]"), Some(IdShape::Other));
        assert_eq!(segment_id(&"a".repeat(41)), Some(IdShape::Other));
        assert_eq!(segment_id("alice"), None);
        assert_eq!(segment_id("room_1"), None);
    }

    #[test]
    fn unknown_op_is_an_error() {
        let bytes = br#"{"service":"database","op":"listen","ts_ms":1,"path":"a"}"#;
        let err = crate::FirebaseProvider.normalize(bytes, &cx());
        assert!(err.is_err());
    }

    /// Shims are other people's code: any JSON must give an error or an
    /// envelope, never a panic.
    #[test]
    fn hostile_raw_calls_never_panic() {
        let provider = crate::FirebaseProvider;
        let cases = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"database"}"#,
            r#"{"service":"database","op":"get","ts_ms":-1,"path":""}"#,
            r#"{"service":"database","op":"get","ts_ms":1,"path":"////"}"#,
            r#"{"service":"database","op":"query","ts_ms":1,"path":"a","query":{"limit":-5}}"#,
            r#"{"service":"database","op":"get","ts_ms":1,"path":"a","query":{"filters":[{"field":"x","op":"==","value":{"a":[1,{"b":[[[null]]]}]}}]}}"#,
            r#"{"service":"database","op":"get","ts_ms":1,"path":"a","result":{"children":18446744073709551615,"bytes":18446744073709551615}}"#,
            r#"{"service":"database","op":"snapshot","ts_ms":1,"path":"a/b","attempt":0}"#,
            r#"{"service":"database","op":"child_added","ts_ms":1,"path":"\u0000/\ud800"}"#,
            r#"{"service":"database","op":"nope","ts_ms":1,"path":"a"}"#,
        ];
        for case in cases {
            let _ = provider.normalize(case.as_bytes(), &cx());
        }
    }
}
