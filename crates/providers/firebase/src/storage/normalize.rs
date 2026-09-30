use readmeter_core::{
    CallContext, Envelope, FilterShape, IdShape, Op, Outcome, QueryShape, ResultStats, Target,
};
use readmeter_provider_api::{NormalizeContext, NormalizeError};

use super::SERVICE_ID;
use super::billing::{self, Observed};
use super::raw::{CacheControl, RawCall, RawOp};

use crate::PROVIDER_ID;

/// Placeholder for redacted path segments.
const ID: &str = "{id}";

/// Extensions treated as images when the call did not observe a content type.
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "heic", "heif", "svg",
];

pub fn normalize(raw: RawCall, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let segments: Vec<&str> = raw.path.split('/').filter(|s| !s.is_empty()).collect();
    let pieces: Vec<Piece> = segments.iter().copied().map(piece).collect();
    let template = if pieces.is_empty() {
        "/".to_owned()
    } else {
        pieces
            .iter()
            .map(|p| p.template.as_str())
            .collect::<Vec<_>>()
            .join("/")
    };
    let id_shape = pieces.last().and_then(|p| p.id);
    let ext = pieces
        .last()
        .and_then(|p| p.ext.clone())
        .or_else(|| sanitize_ext(raw.ext.as_deref()));
    let joined = segments.join("/");
    // Object identity ignores query attributes, so the same object matches
    // across getMetadata, getBytes and upload.
    let key = cx.hasher.start().str(SERVICE_ID).str(&joined).finish();

    let filters = attributes(&raw, ext.as_deref());
    let query = if filters.is_empty() && raw.max_results.is_none() && !raw.page_token {
        None
    } else {
        Some(shape(cx, &filters, raw.max_results, raw.page_token))
    };

    let op = match raw.op {
        RawOp::Download => Op::Other("download".into()),
        RawOp::DownloadUrl => Op::Other("download_url".into()),
        RawOp::SignedUrl => Op::Other("signed_url".into()),
        RawOp::GetMetadata => Op::Get,
        RawOp::UpdateMetadata => Op::Update,
        RawOp::Upload => Op::Other("upload".into()),
        RawOp::Delete => Op::Delete,
        RawOp::List => Op::Other("list".into()),
        RawOp::ListAll => Op::Other("list_all".into()),
    };

    let listed = matches!(raw.op, RawOp::List | RawOp::ListAll);
    let items = if listed {
        raw.result
            .as_ref()
            .map_or(0, |r| r.items.saturating_add(r.prefixes))
    } else {
        0
    };
    let size = raw.observed_bytes();
    let transferred = match raw.op {
        RawOp::Download | RawOp::Upload => size.unwrap_or(0),
        _ => 0,
    };
    let object_bytes = match raw.op {
        RawOp::GetMetadata | RawOp::Upload => size,
        _ => None,
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
        result: Some(ResultStats {
            items,
            bytes: transferred,
            from_cache: raw.result.as_ref().is_some_and(|r| r.from_cache),
            index_entries: None,
        }),
        usage: None,
        source: Default::default(),
        write: None,
        setup: None,
        outcome: match raw.error.as_deref().map(error_code) {
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
        },
        units: Default::default(),
    };
    env.units = billing::units(
        &env,
        &Observed {
            pages: raw.pages,
            object_bytes,
        },
    );
    Ok(env)
}

struct Piece {
    template: String,
    ext: Option<String>,
    id: Option<IdShape>,
}

/// Splits one trailing extension, classifies the stem, and redacts it.
/// A leading-dot name (`.env`, `.jpg`) keeps the whole segment and has no
/// extension. `file.tar.gz` keeps only `gz`.
fn piece(seg: &str) -> Piece {
    if crate::path::personal_segment(seg) {
        return Piece {
            template: ID.to_owned(),
            ext: None,
            id: Some(IdShape::Other),
        };
    }
    let (stem, ext) = split_ext(seg);
    let id = segment_id(stem);
    let template = match (&id, ext.as_deref()) {
        (Some(_), Some(ext)) => format!("{ID}.{ext}"),
        (Some(_), None) => ID.to_owned(),
        (None, _) => seg.to_owned(),
    };
    Piece { template, ext, id }
}

fn split_ext(seg: &str) -> (&str, Option<String>) {
    if seg.starts_with('.') {
        return (seg, None);
    }
    let Some((stem, ext)) = seg.rsplit_once('.') else {
        return (seg, None);
    };
    if stem.is_empty() {
        return (seg, None);
    }
    match sanitize_ext(Some(ext)) {
        Some(clean) => (stem, Some(clean)),
        None => (seg, None),
    }
}

fn sanitize_ext(ext: Option<&str>) -> Option<String> {
    let ext = ext?.trim();
    if ext.is_empty() || ext.len() > 8 {
        return None;
    }
    if !ext.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// `Some` when the segment is an identifier and must leave the template.
/// Static keys (alphabetic names, short slugs) stay. Same classifier as
/// Realtime Database: a storage path has no "every second segment" rule.
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

fn attributes(raw: &RawCall, ext: Option<&str>) -> Vec<FilterShape> {
    let mut filters = Vec::new();
    if let Some(cache) = raw.cache_control {
        let op = match cache {
            CacheControl::None => "none".to_owned(),
            CacheControl::MaxAge(secs) => secs.to_string(),
        };
        filters.push(FilterShape {
            field: "cache_control".into(),
            op,
        });
    }
    if let Some(major) = content_major(raw.content_type.as_deref()) {
        filters.push(FilterShape {
            field: "content_type".into(),
            op: major,
        });
    }
    if let Some(ext) = ext {
        filters.push(FilterShape {
            field: "ext".into(),
            op: ext.to_owned(),
        });
    }
    if raw.resumable {
        filters.push(FilterShape {
            field: "resumable".into(),
            op: "true".into(),
        });
    }
    filters
}

/// Major type, lowercased, parameters dropped. Anything that is not a short
/// alphabetic token is omitted so a hostile header cannot reach the envelope.
fn content_major(raw: Option<&str>) -> Option<String> {
    let raw = raw?.split([';', ' ']).next()?.trim();
    let major = raw.split('/').next()?.trim();
    if major.is_empty() || major.len() > 32 {
        return None;
    }
    if !major.bytes().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(major.to_ascii_lowercase())
}

/// Last path segment of an SDK error code (`storage/object-not-found` →
/// `object-not-found`). Capped so a shim cannot put a document on the envelope.
fn error_code(code: &str) -> String {
    let seg = code.rsplit('/').next().unwrap_or(code);
    let seg = if seg.is_empty() { "unknown" } else { seg };
    seg.chars().take(64).collect()
}

fn shape(
    cx: &NormalizeContext,
    filters: &[FilterShape],
    limit: Option<u32>,
    page_token: bool,
) -> QueryShape {
    let mut h = cx.hasher.start().str(SERVICE_ID);
    for f in filters {
        h = h.str(&f.field).str(&f.op);
    }
    let fingerprint = h
        .clone()
        .opt_u64(limit.map(u64::from))
        .bool(page_token)
        .finish();
    QueryShape {
        filters: filters.to_vec(),
        order_by: Vec::new(),
        limit,
        limit_to_last: false,
        offset: None,
        start_cursor: page_token,
        end_cursor: false,
        projection: None,
        aggregations: Vec::new(),
        base_key: fingerprint,
        fingerprint,
    }
}

/// Image extensions used when a download has no content type. Metadata wins
/// when it is present, including `application/octet-stream`.
pub(crate) fn ext_is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
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

    fn attr<'a>(env: &'a Envelope, field: &str) -> Option<&'a str> {
        env.query
            .as_ref()
            .and_then(|q| q.filters.iter().find(|f| f.field == field))
            .map(|f| f.op.as_str())
    }

    #[test]
    fn templates_keep_static_names_and_extensions() {
        let push = "-NabcDEFghi123456789";
        assert_eq!(push.len(), 20);
        let doc = norm(json!({
            "op": "download",
            "ts_ms": 1,
            "path": format!("users/{push}/avatar.PNG"),
            "result": {"bytes": 12}
        }));
        assert_eq!(doc.target.template, "users/{id}/avatar.PNG");
        assert_eq!(doc.target.id_shape, None);
        assert_eq!(attr(&doc, "ext"), Some("png"));
        assert_eq!(doc.op, Op::Other("download".into()));
        assert_eq!(doc.units.get("class_b"), 1);
        assert_eq!(doc.units.get("egress_bytes"), 12);
        assert_eq!(doc.result.as_ref().map(|r| r.items), Some(0));

        let file = norm(json!({
            "op": "download",
            "ts_ms": 1,
            "path": "photos/secretUserId99abcd.jpg",
        }));
        assert_eq!(file.target.template, "photos/{id}.jpg");
        assert_eq!(file.target.id_shape, Some(IdShape::Other));
        assert_eq!(attr(&file, "ext"), Some("jpg"));

        let slug = norm(json!({"op": "download", "ts_ms": 1, "path": "rooms/room_1.png"}));
        assert_eq!(slug.target.template, "rooms/room_1.png");
        assert_eq!(slug.target.id_shape, None);

        let dotted =
            norm(json!({"op": "get_metadata", "ts_ms": 1, "path": "archives/file.tar.gz"}));
        assert_eq!(dotted.target.template, "archives/file.tar.gz");
        assert_eq!(attr(&dotted, "ext"), Some("gz"));

        let email =
            norm(json!({"op": "download", "ts_ms": 1, "path": "users/alice@example.com.png"}));
        assert_eq!(email.target.template, "users/{id}");
        assert_eq!(attr(&email, "ext"), None);
        let ip = norm(json!({"op": "download", "ts_ms": 1, "path": "192.168.0.1.jpg"}));
        assert_eq!(ip.target.template, "{id}.jpg");
        assert_eq!(attr(&ip, "ext"), Some("jpg"));
        let phone = norm(json!({"op": "download", "ts_ms": 1, "path": "+15551234567"}));
        assert_eq!(phone.target.template, "{id}");
        let long = norm(json!({
            "op": "download",
            "ts_ms": 1,
            "path": "a".repeat(41),
        }));
        assert_eq!(long.target.template, "{id}");

        let hidden = norm(json!({"op": "download", "ts_ms": 1, "path": "secrets/.env"}));
        assert_eq!(hidden.target.template, "secrets/.env");
        assert_eq!(attr(&hidden, "ext"), None);

        let root = norm(json!({"op": "list", "ts_ms": 1, "path": "///"}));
        assert_eq!(root.target.template, "/");
        assert_eq!(root.units.get("class_a"), 1);
    }

    #[test]
    fn attributes_do_not_change_the_object_key() {
        let plain = norm(
            json!({"op": "download", "ts_ms": 1, "path": "photos/hero.png", "result": {"bytes": 4}}),
        );
        let typed = norm(json!({
            "op": "get_metadata",
            "ts_ms": 2,
            "path": "photos/hero.png",
            "content_type": "image/png; charset=utf-8",
            "cache_control": "none",
            "result": {"bytes": 4}
        }));
        assert_eq!(plain.target.key, typed.target.key);
        assert_eq!(attr(&typed, "content_type"), Some("image"));
        assert_eq!(attr(&typed, "cache_control"), Some("none"));
        assert_eq!(typed.op, Op::Get);
        assert_eq!(
            typed.bytes(),
            0,
            "metadata size is stored_bytes, not a payload"
        );
        assert_eq!(typed.units.get("stored_bytes"), 4);
        assert_eq!(typed.units.get("egress_bytes"), 0);
        assert_eq!(typed.units.get("class_b"), 1);

        let other = norm(json!({"op": "download", "ts_ms": 1, "path": "photos/other.png"}));
        assert_ne!(plain.target.key, other.target.key);
    }

    #[test]
    fn billing_ops_page_tokens_and_errors() {
        let upload = norm(json!({
            "op": "upload",
            "ts_ms": 1,
            "path": "videos/clip.bin",
            "resumable": false,
            "bytes": 9
        }));
        assert_eq!(upload.op, Op::Other("upload".into()));
        assert_eq!(attr(&upload, "resumable"), None);
        assert_eq!(upload.units.get("class_a"), 1);
        assert_eq!(upload.units.get("stored_bytes"), 9);
        assert_eq!(upload.bytes(), 9);

        let resumable = norm(json!({
            "op": "upload",
            "ts_ms": 1,
            "path": "videos/clip.bin",
            "resumable": true,
            "bytes": 9
        }));
        assert_eq!(attr(&resumable, "resumable"), Some("true"));
        assert_eq!(upload.target.key, resumable.target.key);

        let updated =
            norm(json!({"op": "update_metadata", "ts_ms": 1, "path": "a", "cache_control": 3600}));
        assert_eq!(updated.op, Op::Update);
        assert_eq!(updated.units.get("class_a"), 1);
        assert_eq!(attr(&updated, "cache_control"), Some("3600"));

        assert!(
            norm(json!({"op": "delete", "ts_ms": 1, "path": "a"}))
                .units
                .is_empty()
        );
        assert!(
            norm(json!({"op": "signed_url", "ts_ms": 1, "path": "a"}))
                .units
                .is_empty()
        );

        let url = norm(json!({"op": "download_url", "ts_ms": 1, "path": "a"}));
        assert_eq!(url.op, Op::Other("download_url".into()));
        assert_eq!(url.units.get("class_b"), 1);
        assert_eq!(url.units.get("egress_bytes"), 0);

        let listed = norm(json!({
            "op": "list_all",
            "ts_ms": 1,
            "path": "photos",
            "result": {"items": 1001, "prefixes": 1}
        }));
        assert_eq!(listed.items(), 1002);
        assert_eq!(listed.units.get("class_a"), 2);

        let paged = norm(json!({
            "op": "list_all",
            "ts_ms": 1,
            "path": "photos",
            "pages": 4,
            "result": {"items": 1001}
        }));
        assert_eq!(paged.units.get("class_a"), 4);

        let limited = norm(json!({
            "op": "list",
            "ts_ms": 1,
            "path": "photos",
            "max_results": 50,
            "page_token": "secret-page-token",
            "result": {"items": 50, "prefixes": 2}
        }));
        let q = limited.query.as_ref().unwrap();
        assert_eq!(q.limit, Some(50));
        assert!(q.start_cursor);
        assert_eq!(limited.items(), 52);
        assert_eq!(limited.units.get("class_a"), 1);

        let failed = norm(json!({
            "op": "download",
            "ts_ms": 1,
            "path": "a",
            "result": {"bytes": 9},
            "error": "storage/object-not-found"
        }));
        assert!(failed.units.is_empty());
        assert_eq!(
            failed.outcome,
            Outcome::Error {
                code: "object-not-found".into()
            }
        );

        let cached = norm(json!({
            "op": "download",
            "ts_ms": 1,
            "path": "a",
            "result": {"bytes": 9, "from_cache": true}
        }));
        assert!(cached.units.is_empty());
    }

    #[test]
    fn no_raw_values_or_ids_leak() {
        let env = norm(json!({
            "op": "list",
            "ts_ms": 1,
            "path": "users/secretUserId99abcd/secretFileId99abcd.jpg",
            "callsite": "https://secret.example/src/File.tsx:1?q=secret",
            "ext": "../../secret-ext",
            "content_type": "<script>alert(1)</script>",
            "cache_control": "max-age=secret",
            "page_token": "secret-page-token-value",
            "error": "storage/secret-prefix/object-not-found"
        }));
        let dump = format!("{env:?}");
        assert!(!dump.contains("secret"), "{dump}");
        assert_eq!(env.ctx.callsite_label.as_deref(), Some("src/File.tsx:1"));
        assert!(!dump.contains("script"), "{dump}");
        assert!(!dump.contains("token"), "{dump}");
        assert_eq!(env.target.template, "users/{id}/{id}.jpg");
        assert_eq!(attr(&env, "ext"), Some("jpg"));
        assert_eq!(attr(&env, "content_type"), None);
        assert_eq!(attr(&env, "cache_control"), None);
    }

    #[test]
    fn classify() {
        assert_eq!(segment_id("1727481600"), Some(IdShape::TimestampLike));
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
        assert_eq!(segment_id("alice"), None);
        assert_eq!(segment_id("room_1"), None);
        assert!(ext_is_image("jpg"));
        assert!(!ext_is_image("bin"));
    }

    #[test]
    fn hostile_raw_calls_never_panic() {
        let provider = crate::FirebaseProvider;
        let cases = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"storage"}"#,
            r#"{"service":"storage","op":"download","ts_ms":-1,"path":""}"#,
            r#"{"service":"storage","op":"download","ts_ms":1,"path":"////"}"#,
            r#"{"service":"storage","op":"list","ts_ms":1,"path":"a","max_results":-5}"#,
            r#"{"service":"storage","op":"download","ts_ms":1,"path":"a","content_type":{"a":1},"cache_control":[]}"#,
            r#"{"service":"storage","op":"list_all","ts_ms":1,"path":"a","result":{"items":18446744073709551615,"prefixes":1}}"#,
            r#"{"service":"storage","op":"upload","ts_ms":1,"path":"a","attempt":0}"#,
            r#"{"service":"storage","op":"download","ts_ms":1,"path":"\u0000/\ud800.jpg"}"#,
            r#"{"service":"storage","op":"nope","ts_ms":1,"path":"a"}"#,
            r#"{"service":"storage","op":"get_metadata","ts_ms":1,"path":"a","page_token":"super-secret-token"}"#,
        ];
        for case in cases {
            let _ = provider.normalize(case.as_bytes(), &cx());
        }
    }
}
