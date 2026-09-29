//! The provider contract.
//!
//! A provider turns raw calls reported by its SDK shims into generic
//! [`Envelope`]s, computes billable units, and contributes detectors for its
//! provider-specific rules. Everything downstream (engine, buffer, wire,
//! backend) is provider-agnostic.

use readmeter_core::{Envelope, HashBuilder, KeyedHasher, Platform};
use readmeter_rules::DetectorFactory;

pub mod json;

pub use json::{JsonError, JsonValue};

/// Per-client values a provider needs while normalizing.
#[derive(Debug, Clone, Copy)]
pub struct NormalizeContext {
    /// Project-keyed hasher used to redact paths, ids and values.
    pub hasher: KeyedHasher,
    pub session: u64,
    pub platform: Platform,
    pub dev: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum NormalizeError {
    #[error("invalid raw call JSON: {0}")]
    Json(#[from] JsonError),
    #[error("unknown service `{0}`")]
    UnknownService(String),
    #[error("invalid raw call: {0}")]
    Invalid(String),
}

pub trait Provider: Send + Sync {
    /// Stable provider id, used in rule ids (`<id>.<service>/<rule>`).
    fn id(&self) -> &'static str;

    fn services(&self) -> &'static [&'static str];

    /// Normalizes one already-parsed raw call. The raw call may carry filter
    /// values and concrete ids; the returned envelope must not.
    fn normalize_value(
        &self,
        raw: &JsonValue,
        cx: &NormalizeContext,
    ) -> Result<Envelope, NormalizeError>;

    /// Parses `raw_json` and calls [`Provider::normalize_value`].
    fn normalize(
        &self,
        raw_json: &[u8],
        cx: &NormalizeContext,
    ) -> Result<Envelope, NormalizeError> {
        let value = json::parse(raw_json)?;
        self.normalize_value(&value, cx)
    }

    /// Detectors for this provider's rules.
    fn detectors(&self) -> Vec<(&'static str, DetectorFactory)>;
}

/// Feeds a JSON value into a hash canonically: object keys are visited in
/// sorted order and every node is type-tagged, so `1`, `1.0`, `"1"` and
/// `[1]` all hash differently while key order does not matter.
pub fn hash_json(mut h: HashBuilder, value: &JsonValue) -> HashBuilder {
    match value {
        JsonValue::Null => h.tag(0),
        JsonValue::Bool(b) => h.tag(1).bool(*b),
        JsonValue::Uint(n) => h.tag(2).u64(*n),
        JsonValue::Int(n) => h.tag(2).u64(*n as u64),
        JsonValue::Float(f) => h.tag(6).u64(f.to_bits()),
        JsonValue::Str(s) => h.tag(3).str(s),
        JsonValue::Array(items) => {
            h = h.tag(4).u64(items.len() as u64);
            for item in items {
                h = hash_json(h, item);
            }
            h
        }
        JsonValue::Object(entries) => {
            let mut sorted: Vec<&(String, JsonValue)> = entries.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            h = h.tag(5).u64(sorted.len() as u64);
            for (key, v) in sorted {
                h = hash_json(h.str(key), v);
            }
            h
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(json: &str) -> u64 {
        let v = json::parse(json.as_bytes()).unwrap();
        hash_json(KeyedHasher::new(1, 2).start(), &v).finish()
    }

    #[test]
    fn canonical_hash() {
        assert_eq!(h(r#"{"a": 1, "b": [true]}"#), h(r#"{"b": [true], "a": 1}"#));
        assert_eq!(h("-5"), h("-5"));
        assert_ne!(h("1"), h("1.0"));
        assert_ne!(h("1"), h(r#""1""#));
        assert_ne!(h("1"), h("[1]"));
        assert_ne!(h("null"), h("false"));
        assert_ne!(h(r#"{"a": {"b": 1}}"#), h(r#"{"a": {"b": 2}}"#));
    }
}
