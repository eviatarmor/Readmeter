//! Id shapes, and filter, equality and cursor values folded into keyed
//! hashes.
//!
//! The project hash key ships inside browser bundles, so anyone with the key
//! and the events can hash candidate values and compare. That is hopeless for
//! a random id and trivial for `true`, `"admin"`, `30` or an email. On a
//! browser (or an unknown platform) only id-shaped strings go into the hash;
//! every other value is reduced to its type, plus the length for strings,
//! first. Server and mobile builds keep the key out of reach of end users and
//! hash the full value.

#[cfg(any(feature = "database", feature = "storage"))]
use readmeter_core::IdShape;
#[cfg(any(feature = "firestore", feature = "database"))]
use readmeter_core::{HashBuilder, Platform};
#[cfg(any(feature = "firestore", feature = "database"))]
use readmeter_provider_api::JsonValue;

#[cfg(any(feature = "firestore", feature = "database"))]
/// Feeds a raw filter or cursor value into `h`, coarsened unless the
/// platform keeps the hash key secret.
pub(crate) fn hash_value(h: HashBuilder, value: &JsonValue, platform: Platform) -> HashBuilder {
    feed(
        h,
        value,
        matches!(platform, Platform::Server | Platform::Mobile),
    )
}

#[cfg(any(feature = "firestore", feature = "database"))]
/// With `full`, the same input as `readmeter_provider_api::hash_json` (one
/// walker instead of two keeps the SDK wasm small). Without it, ids go in as
/// they are and everything else as a type tag, plus the length for strings.
fn feed(mut h: HashBuilder, value: &JsonValue, full: bool) -> HashBuilder {
    match value {
        JsonValue::Null => h.tag(0),
        JsonValue::Bool(b) if full => h.tag(1).bool(*b),
        JsonValue::Bool(_) => h.tag(1),
        JsonValue::Uint(n) if full => h.tag(2).u64(*n),
        JsonValue::Int(n) if full => h.tag(2).u64(*n as u64),
        JsonValue::Float(f) if full => h.tag(6).u64(f.to_bits()),
        JsonValue::Uint(_) | JsonValue::Int(_) | JsonValue::Float(_) => h.tag(2),
        JsonValue::Str(s) if full || id_shaped(s) => h.tag(3).str(s),
        // Length in bytes. Timestamps arrive as ISO strings of one fixed
        // length, so they need no tag of their own.
        JsonValue::Str(s) => h.tag(8).u64(s.len() as u64),
        JsonValue::Array(items) => {
            h = h.tag(4).u64(items.len() as u64);
            for item in items {
                h = feed(h, item, full);
            }
            h
        }
        JsonValue::Object(entries) if full => {
            let mut sorted: Vec<&(String, JsonValue)> = entries.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            h = h.tag(5).u64(sorted.len() as u64);
            for (key, v) in sorted {
                h = feed(h.str(key), v, full);
            }
            h
        }
        // Keys can be data too; a map is its size only.
        JsonValue::Object(entries) => h.tag(5).u64(entries.len() as u64),
    }
}

#[cfg(any(feature = "firestore", feature = "database"))]
/// A random, high-entropy id: Firestore auto id, push id, UUID, or a long
/// opaque token such as a Firebase Auth uid. A document reference path
/// (`users/<id>`) counts when its last segment does.
pub(crate) fn id_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    let last = b.rsplit(|c| *c == b'/').next().unwrap_or(b);
    // A UUID is a long token too.
    is_long_token(last)
        || (last.len() == 20
            && token_classes(last).is_some_and(|c| {
                // Auto id without a digit: mixed case. Push id: a `-` or `_`.
                c & (LOWER | UPPER) == LOWER | UPPER || (c & MARK != 0 && c & (LOWER | UPPER) != 0)
            }))
}

const LOWER: u8 = 1;
const UPPER: u8 = 2;
const DIGIT: u8 = 4;
const MARK: u8 = 8;

/// Character classes of a `[A-Za-z0-9_-]` token, or `None` for any other byte.
fn token_classes(b: &[u8]) -> Option<u8> {
    b.iter().try_fold(0u8, |acc, c| {
        let class = match c {
            b'a'..=b'z' => LOWER,
            b'A'..=b'Z' => UPPER,
            b'0'..=b'9' => DIGIT,
            b'-' | b'_' => MARK,
            _ => return None,
        };
        Some(acc | class)
    })
}

/// `Some` when a Realtime Database or Cloud Storage path segment is an
/// identifier and must leave the template. Static keys (alphabetic names,
/// short slugs) stay.
#[cfg(any(feature = "database", feature = "storage"))]
pub(crate) fn segment_id(id: &str) -> Option<IdShape> {
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

pub(crate) fn is_uuid(b: &[u8]) -> bool {
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `YYYY-MM-DD...`
pub(crate) fn is_iso_date_prefix(b: &[u8]) -> bool {
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

#[cfg(any(feature = "database", feature = "storage"))]
/// Firebase push id: 20 chars from the push alphabet, and not a plain word.
/// Plain words have no `-`, `_`, or digit, so `orderByChild` keys stay.
pub(crate) fn is_push_id(b: &[u8]) -> bool {
    b.len() == 20 && token_classes(b).is_some_and(|c| c & (DIGIT | MARK) != 0)
}

/// Long opaque token (Firebase UID and similar): 16..=128 of `[A-Za-z0-9_-]`
/// with both a letter and a digit. Short slugs such as `room_1` stay.
pub(crate) fn is_long_token(b: &[u8]) -> bool {
    (16..=128).contains(&b.len())
        && token_classes(b).is_some_and(|c| c & DIGIT != 0 && c & (LOWER | UPPER) != 0)
}

#[cfg(all(test, any(feature = "firestore", feature = "database")))]
mod tests {
    #![allow(clippy::unwrap_used)]

    use readmeter_core::KeyedHasher;

    use super::*;

    fn h(json: &str, platform: Platform) -> u64 {
        let v = readmeter_provider_api::json::parse(json.as_bytes()).unwrap();
        hash_value(KeyedHasher::new(1, 2).start(), &v, platform).finish()
    }

    fn browser(json: &str) -> u64 {
        h(json, Platform::Browser)
    }

    #[test]
    fn browser_values_keep_type_and_length_only() {
        assert_eq!(browser(r#""admin""#), browser(r#""owner""#));
        assert_ne!(browser(r#""admin""#), browser(r#""editor""#));
        assert_eq!(browser("true"), browser("false"));
        assert_eq!(browser("30"), browser("31"));
        assert_eq!(browser("30"), browser("-2.5"));
        assert_eq!(
            browser(r#""2026-01-01T00:00:00Z""#),
            browser(r#""2031-07-12T13:14:15Z""#)
        );
        assert_eq!(
            browser(r#"{"latitude": 1, "longitude": 2}"#),
            browser(r#"{"a": "x", "b": true}"#)
        );
        assert_eq!(browser(r#"["a", 1]"#), browser(r#"["b", 2]"#));
        assert_ne!(browser(r#"["a", 1]"#), browser(r#"["a", 1, 2]"#));
        // Types stay apart.
        let distinct = [
            "null",
            "true",
            "1",
            r#""1""#,
            "[1]",
            "{}",
            r#""2026-01-01""#,
        ];
        for (i, a) in distinct.iter().enumerate() {
            for b in &distinct[i + 1..] {
                assert_ne!(browser(a), browser(b), "{a} vs {b}");
            }
        }
    }

    #[test]
    fn browser_ids_stay_distinct() {
        let ids = [
            r#""Xb3kD9aQ2mLp7rT1vY0z""#,
            r#""Yc4lE0bR3nMq8sU2wZ1a""#,
            r#""-NabcDEFghi123456789""#,
            r#""550e8400-e29b-41d4-a716-446655440000""#,
            r#""550e8400-e29b-41d4-a716-446655440001""#,
            r#""kT9pQ2xZ7vLm4nB8cR1sW6yD3fH0""#,
            r#""users/Xb3kD9aQ2mLp7rT1vY0z""#,
        ];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(browser(a), browser(b), "{a} vs {b}");
            }
        }
        assert_ne!(
            browser(r#"["Xb3kD9aQ2mLp7rT1vY0z"]"#),
            browser(r#"["Yc4lE0bR3nMq8sU2wZ1a"]"#)
        );
        // A reference to a low-entropy document id is not an id.
        assert_eq!(browser(r#""users/alice""#), browser(r#""users/carol""#));
    }

    #[test]
    fn full_mode_matches_hash_json() {
        let samples = [
            "null",
            "true",
            "-5",
            "7",
            "1.5",
            r#""admin""#,
            r#"[1, "a", [null]]"#,
            r#"{"b": [true], "a": {"c": 1}}"#,
        ];
        for json in samples {
            let v = readmeter_provider_api::json::parse(json.as_bytes()).unwrap();
            let start = || KeyedHasher::new(1, 2).start();
            assert_eq!(
                hash_value(start(), &v, Platform::Server).finish(),
                readmeter_provider_api::hash_json(start(), &v).finish(),
                "{json}"
            );
        }
    }

    #[test]
    fn server_and_mobile_hash_full_values() {
        for p in [Platform::Server, Platform::Mobile] {
            assert_ne!(h(r#""admin""#, p), h(r#""owner""#, p));
            assert_ne!(h("true", p), h("false", p));
            assert_ne!(h("30", p), h("31", p));
        }
        assert_eq!(h(r#""admin""#, Platform::Unknown), browser(r#""owner""#));
    }

    #[test]
    fn classifies_ids() {
        assert!(id_shaped("Xb3kD9aQ2mLp7rT1vY0z"));
        assert!(id_shaped("0190a8f0-7c1e-7a2b-9c3d-4e5f60718293"));
        assert!(id_shaped("kT9pQ2xZ7vLm4nB8cR1sW6yD3fH0"));
        assert!(!id_shaped("admin"));
        assert!(!id_shaped("alice@example.com"));
        assert!(!id_shaped("42"));
        assert!(!id_shaped("1727481600000"));
        assert!(!id_shaped("room_1"));
        assert!(!id_shaped("notificationsettings"));
        assert!(!id_shaped(""));
    }
}
