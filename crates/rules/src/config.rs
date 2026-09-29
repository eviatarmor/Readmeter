use readmeter_core::{Severity, VecMap};
use serde::{Deserialize, Serialize};

use crate::def::{ParamValue, RuleSpec, Status};

/// Tenant/project level rule settings, layered over catalog defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleConfig {
    #[serde(default)]
    pub overrides: VecMap<RuleOverride>,
    /// Minimum time between two findings of the same rule for the same
    /// callsite (or template) in one session.
    #[serde(default = "default_cooldown_ms")]
    pub cooldown_ms: u64,
}

fn default_cooldown_ms() -> u64 {
    60_000
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self {
            overrides: VecMap::new(),
            cooldown_ms: default_cooldown_ms(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleOverride {
    pub enabled: Option<bool>,
    pub severity: Option<Severity>,
    #[serde(default)]
    pub params: VecMap<ParamValue>,
}

/// A rule after overrides are applied, ready to build a detector.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedRule {
    pub spec: RuleSpec,
    pub severity: Severity,
    pub params: Params,
}

impl ResolvedRule {
    /// Returns `None` when the rule is disabled or planned.
    pub fn resolve(def: &RuleSpec, ov: Option<&RuleOverride>) -> Result<Option<Self>, ParamError> {
        if def.status == Status::Planned {
            return Ok(None);
        }
        let enabled = ov.and_then(|o| o.enabled).unwrap_or(def.default_enabled);
        if !enabled {
            return Ok(None);
        }
        let mut params = def.params.clone();
        if let Some(ov) = ov {
            for (key, value) in ov.params.iter() {
                let Some(default) = def.params.get(key) else {
                    return Err(ParamError::Unknown {
                        rule: def.id.clone(),
                        key: key.to_owned(),
                    });
                };
                if !default.same_kind(value) {
                    return Err(ParamError::WrongType {
                        rule: def.id.clone(),
                        key: key.to_owned(),
                        expected: default.kind(),
                    });
                }
                params.insert(key, value.clone());
            }
        }
        Ok(Some(Self {
            severity: ov.and_then(|o| o.severity).unwrap_or(def.severity),
            params: Params {
                rule: def.id.clone(),
                values: params,
            },
            spec: def.clone(),
        }))
    }
}

/// Typed access to a rule's parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Params {
    rule: String,
    values: VecMap<ParamValue>,
}

impl Params {
    pub fn new(rule: &str, values: VecMap<ParamValue>) -> Self {
        Self {
            rule: rule.to_owned(),
            values,
        }
    }

    fn get(&self, key: &str) -> Result<&ParamValue, ParamError> {
        self.values.get(key).ok_or_else(|| ParamError::Missing {
            rule: self.rule.clone(),
            key: key.to_owned(),
        })
    }

    fn wrong(&self, key: &str, expected: &'static str) -> ParamError {
        ParamError::WrongType {
            rule: self.rule.clone(),
            key: key.to_owned(),
            expected,
        }
    }

    pub fn u64(&self, key: &str) -> Result<u64, ParamError> {
        match self.get(key)? {
            ParamValue::Int(v) if *v >= 0 => Ok(*v as u64),
            _ => Err(self.wrong(key, "non-negative int")),
        }
    }

    pub fn f64(&self, key: &str) -> Result<f64, ParamError> {
        match self.get(key)? {
            ParamValue::Float(v) => Ok(*v),
            ParamValue::Int(v) => Ok(*v as f64),
            _ => Err(self.wrong(key, "float")),
        }
    }

    pub fn bool(&self, key: &str) -> Result<bool, ParamError> {
        match self.get(key)? {
            ParamValue::Bool(v) => Ok(*v),
            _ => Err(self.wrong(key, "bool")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ParamError {
    #[error("rule `{rule}`: unknown param `{key}`")]
    Unknown { rule: String, key: String },
    #[error("rule `{rule}`: missing param `{key}`")]
    Missing { rule: String, key: String },
    #[error("rule `{rule}`: param `{key}` must be {expected}")]
    WrongType {
        rule: String,
        key: String,
        expected: &'static str,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::rule_def;

    fn def() -> RuleSpec {
        let mut d = rule_def("generic/x", "*", "*").spec();
        d.params.insert("limit", ParamValue::Int(10));
        d.params.insert("ratio", ParamValue::Float(0.5));
        d
    }

    #[test]
    fn override_applies() {
        let ov = RuleOverride {
            severity: Some(Severity::Low),
            params: [("limit".to_owned(), ParamValue::Int(3))].into(),
            ..Default::default()
        };
        let r = ResolvedRule::resolve(&def(), Some(&ov)).unwrap().unwrap();
        assert_eq!(r.severity, Severity::Low);
        assert_eq!(r.params.u64("limit").unwrap(), 3);
        assert_eq!(r.params.f64("ratio").unwrap(), 0.5);
    }

    #[test]
    fn int_accepted_for_float_param() {
        let ov = RuleOverride {
            params: [("ratio".to_owned(), ParamValue::Int(1))].into(),
            ..Default::default()
        };
        let r = ResolvedRule::resolve(&def(), Some(&ov)).unwrap().unwrap();
        assert_eq!(r.params.f64("ratio").unwrap(), 1.0);
    }

    #[test]
    fn rejects_unknown_and_mistyped_params() {
        let unknown = RuleOverride {
            params: [("limt".to_owned(), ParamValue::Int(3))].into(),
            ..Default::default()
        };
        assert!(matches!(
            ResolvedRule::resolve(&def(), Some(&unknown)),
            Err(ParamError::Unknown { .. })
        ));
        let mistyped = RuleOverride {
            params: [("limit".to_owned(), ParamValue::Bool(true))].into(),
            ..Default::default()
        };
        assert!(matches!(
            ResolvedRule::resolve(&def(), Some(&mistyped)),
            Err(ParamError::WrongType { .. })
        ));
    }

    #[test]
    fn disabled_and_planned_resolve_to_none() {
        let off = RuleOverride {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(ResolvedRule::resolve(&def(), Some(&off)).unwrap().is_none());
        let mut planned = def();
        planned.status = Status::Planned;
        assert!(ResolvedRule::resolve(&planned, None).unwrap().is_none());
    }
}
