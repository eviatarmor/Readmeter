use std::collections::HashMap;

use readmeter_core::{Envelope, Finding, Scalar, Units, VecMap};

use crate::config::{ParamError, Params, ResolvedRule};

/// Detector for one rule. Implementations must keep bounded state (see
/// [`crate::window`]) and must never panic.
pub trait Detector: Send {
    /// Called for every envelope the rule's scope matches, in arrival order.
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>);
}

/// Builds a detector from resolved params. Parse params here, once, so bad
/// config fails at engine build time rather than per event.
pub type DetectorFactory = fn(&Params) -> Result<Box<dyn Detector>, ParamError>;

/// Maps rule ids to detector factories.
#[derive(Default)]
pub struct Registry {
    factories: HashMap<&'static str, DetectorFactory>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registry pre-populated with every generic detector.
    pub fn with_generic() -> Self {
        let mut r = Self::new();
        crate::detectors::register(&mut r);
        r
    }

    pub fn register(&mut self, rule_id: &'static str, factory: DetectorFactory) {
        self.factories.insert(rule_id, factory);
    }

    pub fn extend(&mut self, entries: impl IntoIterator<Item = (&'static str, DetectorFactory)>) {
        for (id, f) in entries {
            self.register(id, f);
        }
    }

    pub fn get(&self, rule_id: &str) -> Option<DetectorFactory> {
        self.factories.get(rule_id).copied()
    }

    pub fn ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.factories.keys().copied()
    }
}

/// Collects findings for one rule while a detector runs.
pub struct Emitter<'a> {
    rule: &'a ResolvedRule,
    findings: &'a mut Vec<Finding>,
}

impl<'a> Emitter<'a> {
    pub(crate) fn new(rule: &'a ResolvedRule, findings: &'a mut Vec<Finding>) -> Self {
        Self { rule, findings }
    }

    /// Emits a finding anchored on `env`. Chain `.evidence()` / `.wasted()`
    /// on the returned handle.
    pub fn emit(&mut self, env: &Envelope, message: impl Into<String>) -> FindingMut<'_> {
        self.findings.push(Finding {
            rule: self.rule.spec.id.clone(),
            severity: self.rule.severity,
            ts_ms: env.ts_ms,
            provider: env.provider.clone(),
            service: env.service.clone(),
            template: env.target.template.clone(),
            session: env.ctx.session,
            callsite: env.ctx.callsite,
            message: message.into(),
            evidence: VecMap::new(),
            wasted: Units::new(),
        });
        let last = self.findings.len() - 1;
        FindingMut(&mut self.findings[last])
    }
}

pub struct FindingMut<'a>(&'a mut Finding);

impl FindingMut<'_> {
    pub fn evidence(self, key: &str, value: impl Into<Scalar>) -> Self {
        self.0.evidence.insert(key, value.into());
        self
    }

    pub fn wasted(self, unit: &str, amount: u64) -> Self {
        self.0.wasted.add(unit, amount);
        self
    }

    pub fn wasted_units(self, units: &Units) -> Self {
        self.0.wasted.merge(units);
        self
    }
}
