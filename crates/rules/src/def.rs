use readmeter_core::{Envelope, Severity, VecMap};
use serde::{Deserialize, Serialize};

/// Wildcard for `provider` / `service` in generic rules.
pub const ANY: &str = "*";

/// A rule definition as written in `rules/**/*.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleDef {
    /// `generic/<name>` or `<provider>.<service>/<name>`, kebab-case name.
    pub id: String,
    pub title: String,
    /// Provider id or `*`.
    pub provider: String,
    /// Service id or `*`.
    pub service: String,
    pub severity: Severity,
    pub category: Category,
    pub evaluation: Evaluation,
    pub status: Status,
    #[serde(default = "default_true")]
    pub default_enabled: bool,
    /// One line, shown in lists.
    pub summary: String,
    /// Why this costs money. Markdown.
    pub description: String,
    /// How to fix it. Markdown.
    pub fix: String,
    #[serde(default)]
    pub docs: Vec<String>,
    /// Default parameter values. Overrides may only set keys declared here.
    #[serde(default)]
    pub params: VecMap<ParamValue>,
    #[serde(default)]
    pub examples: Vec<Example>,
}

fn default_true() -> bool {
    true
}

impl RuleDef {
    /// The engine-facing part of this rule, as shipped to SDKs.
    pub fn spec(&self) -> RuleSpec {
        RuleSpec {
            id: self.id.clone(),
            provider: self.provider.clone(),
            service: self.service.clone(),
            severity: self.severity,
            evaluation: self.evaluation,
            status: self.status,
            default_enabled: self.default_enabled,
            params: self.params.clone(),
        }
    }
}

/// What the engine needs to run a rule. SDK bundles carry only this, so
/// descriptions, docs and examples never ship inside customer apps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSpec {
    pub id: String,
    pub provider: String,
    pub service: String,
    pub severity: Severity,
    pub evaluation: Evaluation,
    pub status: Status,
    #[serde(default = "default_true")]
    pub default_enabled: bool,
    #[serde(default)]
    pub params: VecMap<ParamValue>,
}

impl RuleSpec {
    pub fn is_generic(&self) -> bool {
        self.provider == ANY
    }

    pub fn applies_to(&self, env: &Envelope) -> bool {
        (self.provider == ANY || self.provider == env.provider)
            && (self.service == ANY || self.service == env.service)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Reads,
    Writes,
    Realtime,
    Pagination,
    Payload,
    Aggregation,
    Hotspots,
    Reliability,
}

/// Where a rule can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Evaluation {
    /// Single envelope, stateless. Cheap enough for every SDK.
    Local,
    /// Needs a time window of one session's envelopes. Runs on the backend
    /// evaluator, and optionally in SDKs in dev mode.
    Window,
    /// Needs data across sessions or long periods. Backend only.
    Aggregate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Stable,
    /// Enabled by default only if `default_enabled`; may change or be noisy.
    Beta,
    /// Documented but no detector yet. Never evaluated.
    Planned,
}

/// Parameter value. Serialized as a bare JSON/TOML scalar. Deserialization
/// is hand-written: `#[serde(untagged)]` would pull serde's buffering
/// machinery into every SDK binary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

impl ParamValue {
    pub fn kind(&self) -> &'static str {
        match self {
            ParamValue::Bool(_) => "bool",
            ParamValue::Int(_) => "int",
            ParamValue::Float(_) => "float",
            ParamValue::Str(_) => "string",
        }
    }

    /// Ints are accepted where floats are declared, not the other way round.
    pub fn same_kind(&self, other: &ParamValue) -> bool {
        matches!(
            (self, other),
            (ParamValue::Bool(_), ParamValue::Bool(_))
                | (ParamValue::Int(_), ParamValue::Int(_))
                | (
                    ParamValue::Float(_),
                    ParamValue::Float(_) | ParamValue::Int(_)
                )
                | (ParamValue::Str(_), ParamValue::Str(_))
        )
    }
}

impl<'de> Deserialize<'de> for ParamValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = ParamValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a bool, integer, float or string")
            }
            fn visit_bool<E>(self, v: bool) -> Result<ParamValue, E> {
                Ok(ParamValue::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<ParamValue, E> {
                Ok(ParamValue::Int(v))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<ParamValue, E> {
                i64::try_from(v)
                    .map(ParamValue::Int)
                    .map_err(|_| E::custom("integer out of range"))
            }
            fn visit_f64<E>(self, v: f64) -> Result<ParamValue, E> {
                Ok(ParamValue::Float(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<ParamValue, E> {
                Ok(ParamValue::Str(v.to_owned()))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Example {
    /// Language tag, e.g. `ts`, `go`, `python`.
    pub lang: String,
    pub bad: String,
    pub good: String,
}
