use serde::{Deserialize, Serialize};

use crate::map::VecMap;
use crate::units::Units;

/// Severity is ranked by cost impact, not by code quality.
///
/// - `critical`: cost grows without bound with data size or traffic.
/// - `high`: large constant multiplier on cost (roughly 5x or more).
/// - `medium`: measurable waste on a hot path.
/// - `low`: minor waste, or latency-only impact.
/// - `info`: observation worth surfacing, no direct waste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// Evidence value attached to a finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scalar {
    U64(u64),
    I64(i64),
    F64(f64),
    Bool(bool),
    Str(String),
}

impl From<u64> for Scalar {
    fn from(v: u64) -> Self {
        Scalar::U64(v)
    }
}
impl From<u32> for Scalar {
    fn from(v: u32) -> Self {
        Scalar::U64(u64::from(v))
    }
}
impl From<usize> for Scalar {
    fn from(v: usize) -> Self {
        Scalar::U64(v as u64)
    }
}
impl From<f64> for Scalar {
    fn from(v: f64) -> Self {
        Scalar::F64(v)
    }
}
impl From<bool> for Scalar {
    fn from(v: bool) -> Self {
        Scalar::Bool(v)
    }
}
impl From<&str> for Scalar {
    fn from(v: &str) -> Self {
        Scalar::Str(v.to_owned())
    }
}
impl From<String> for Scalar {
    fn from(v: String) -> Self {
        Scalar::Str(v)
    }
}

/// A rule violation detected on one or more envelopes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// Fully qualified rule id, e.g. `firebase.firestore/unbounded-list`.
    pub rule: String,
    pub severity: Severity,
    pub ts_ms: u64,
    pub provider: String,
    pub service: String,
    pub template: String,
    pub session: u64,
    pub callsite: Option<u64>,
    /// Human-readable, one sentence, no identifiers or values.
    pub message: String,
    pub evidence: VecMap<Scalar>,
    /// Billable units the rule attributes to the problem.
    pub wasted: Units,
}
