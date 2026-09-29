use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};

use readmeter_core::{Envelope, Finding};

use crate::config::{ParamError, ResolvedRule, RuleConfig};
use crate::def::{Evaluation, RuleSpec};
use crate::detector::{Detector, Emitter, Registry};

/// Upper bound on cooldown entries before stale ones are swept.
const MAX_COOLDOWN_KEYS: usize = 10_000;

struct Slot {
    rule: ResolvedRule,
    detector: Box<dyn Detector>,
}

/// Runs a set of detectors over a stream of envelopes.
///
/// One engine per client (SDK) or per evaluator shard (backend). The engine
/// throttles repeated findings: the same rule for the same callsite (or
/// template when no callsite is known) in one session fires at most once per
/// `cooldown_ms`.
pub struct Engine {
    slots: Vec<Slot>,
    cooldown_ms: u64,
    last_fired: HashMap<u64, u64>,
    unavailable: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Param(#[from] ParamError),
    #[error("override for unknown rule `{0}`")]
    UnknownRule(String),
}

impl Engine {
    /// Builds an engine with every enabled rule whose evaluation is in
    /// `evaluations` and whose detector is registered. Enabled rules without a
    /// detector are listed in [`Engine::unavailable`] (e.g. a provider crate
    /// not linked into this build).
    pub fn build(
        rules: &[RuleSpec],
        config: &RuleConfig,
        registry: &Registry,
        evaluations: &[Evaluation],
    ) -> Result<Self, EngineError> {
        if let Some(id) = config
            .overrides
            .keys()
            .find(|id| !rules.iter().any(|r| r.id == *id))
        {
            return Err(EngineError::UnknownRule(id.to_owned()));
        }
        let mut slots = Vec::new();
        let mut unavailable = Vec::new();
        for def in rules {
            if !evaluations.contains(&def.evaluation) {
                continue;
            }
            let Some(rule) = ResolvedRule::resolve(def, config.overrides.get(&def.id))? else {
                continue;
            };
            let Some(factory) = registry.get(&def.id) else {
                unavailable.push(def.id.clone());
                continue;
            };
            let detector = factory(&rule.params)?;
            slots.push(Slot { rule, detector });
        }
        Ok(Self {
            slots,
            cooldown_ms: config.cooldown_ms,
            last_fired: HashMap::new(),
            unavailable,
        })
    }

    /// Ids of active rules, in catalog order.
    pub fn active(&self) -> impl Iterator<Item = &str> {
        self.slots.iter().map(|s| s.rule.spec.id.as_str())
    }

    pub fn unavailable(&self) -> &[String] {
        &self.unavailable
    }

    /// Feeds one envelope to every matching detector and returns new findings.
    pub fn observe(&mut self, env: &Envelope) -> Vec<Finding> {
        let mut raw = Vec::new();
        for slot in &mut self.slots {
            if !slot.rule.spec.applies_to(env) {
                continue;
            }
            let mut emitter = Emitter::new(&slot.rule, &mut raw);
            slot.detector.observe(env, &mut emitter);
        }
        if raw.is_empty() {
            return raw;
        }
        self.sweep(env.ts_ms);
        raw.retain(|f| self.admit(f));
        raw
    }

    fn admit(&mut self, f: &Finding) -> bool {
        let mut h = DefaultHasher::new();
        f.rule.hash(&mut h);
        f.session.hash(&mut h);
        match f.callsite {
            Some(c) => c.hash(&mut h),
            None => f.template.hash(&mut h),
        }
        let key = h.finish();
        match self.last_fired.get(&key) {
            Some(&t) if f.ts_ms.saturating_sub(t) < self.cooldown_ms => false,
            _ => {
                self.last_fired.insert(key, f.ts_ms);
                true
            }
        }
    }

    fn sweep(&mut self, now_ms: u64) {
        if self.last_fired.len() < MAX_COOLDOWN_KEYS {
            return;
        }
        let cooldown = self.cooldown_ms;
        self.last_fired
            .retain(|_, t| now_ms.saturating_sub(*t) < cooldown);
        if self.last_fired.len() >= MAX_COOLDOWN_KEYS {
            self.last_fired.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Catalog;
    use crate::def::ParamValue;
    use crate::testing::{EnvBuilder, rule_def};
    use crate::{Params, RuleOverride};

    struct Always;
    impl Detector for Always {
        fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
            out.emit(env, "hit");
        }
    }
    fn always(_: &Params) -> Result<Box<dyn Detector>, ParamError> {
        Ok(Box::new(Always))
    }

    fn setup(config: RuleConfig) -> Result<Engine, EngineError> {
        let mut def = rule_def("firebase.firestore/always", "firebase", "firestore");
        def.params.insert("n", ParamValue::Int(1));
        let planned = {
            let mut d = rule_def("generic/planned", "*", "*");
            d.status = crate::Status::Planned;
            d
        };
        let missing = rule_def("generic/no-detector", "*", "*");
        let catalog = Catalog::new(vec![def, planned, missing]).unwrap();
        let mut reg = Registry::new();
        reg.register("firebase.firestore/always", always);
        Engine::build(&catalog.specs(), &config, &reg, &[Evaluation::Local])
    }

    #[test]
    fn scope_and_cooldown() {
        let mut engine = setup(RuleConfig {
            cooldown_ms: 1_000,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            engine.active().collect::<Vec<_>>(),
            ["firebase.firestore/always"]
        );
        assert_eq!(engine.unavailable(), ["generic/no-detector"]);

        let other = EnvBuilder::get("x/1")
            .provider("supabase", "postgrest")
            .at(0)
            .build();
        assert!(engine.observe(&other).is_empty());

        let e = |ts| EnvBuilder::get("x/1").callsite(7).at(ts).build();
        assert_eq!(engine.observe(&e(0)).len(), 1);
        assert!(engine.observe(&e(500)).is_empty());
        assert_eq!(engine.observe(&e(1_000)).len(), 1);
    }

    #[test]
    fn unknown_override_is_rejected() {
        let config = RuleConfig {
            overrides: [("generic/nope".to_owned(), RuleOverride::default())].into(),
            ..Default::default()
        };
        assert!(matches!(setup(config), Err(EngineError::UnknownRule(_))));
    }
}
