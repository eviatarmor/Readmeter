use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};

use readmeter_core::{Envelope, Finding};

use crate::config::{ParamError, ResolvedRule, RuleConfig};
#[cfg(feature = "window")]
use crate::def::HOST_PROVIDER;
use crate::def::{Evaluation, RuleSpec};
use crate::detector::{Detector, Emitter, Registry};

/// Upper bound on cooldown entries before stale ones are swept.
const MAX_COOLDOWN_KEYS: usize = 10_000;

struct Slot {
    rule: ResolvedRule,
    detector: Box<dyn Detector>,
    /// Cached [`Detector::host_events`].
    #[cfg(feature = "window")]
    host_events: bool,
}

impl Slot {
    fn accepts(&self, env: &Envelope) -> bool {
        #[cfg(feature = "window")]
        if self.host_events && env.provider == HOST_PROVIDER {
            return true;
        }
        self.rule.spec.applies_to(env)
    }
}

/// Runs a set of detectors over a stream of envelopes.
///
/// One engine per client (SDK), or one window engine and one aggregate
/// engine per project on the backend. The engine throttles repeated
/// findings: the same rule for the same callsite (or template when no
/// callsite is known) fires at most once per `cooldown_ms`. Window rules
/// include the session in that key. Aggregate rules do not, because one
/// finding covers every session of the project.
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
            slots.push(Slot {
                #[cfg(feature = "window")]
                host_events: detector.host_events(),
                rule,
                detector,
            });
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
        // Parallel to `raw` when aggregate rules are linked: those findings
        // omit the session from the cooldown key (see [`Engine`]). The SDK
        // build leaves this off so the extra bookkeeping stays out of wasm.
        #[cfg(feature = "aggregate")]
        let mut aggregate = Vec::new();
        for slot in &mut self.slots {
            if !slot.accepts(env) {
                continue;
            }
            let mut emitter = Emitter::new(&slot.rule, &mut raw);
            slot.detector.observe(env, &mut emitter);
            #[cfg(feature = "aggregate")]
            aggregate.resize(
                raw.len(),
                slot.rule.spec.evaluation == Evaluation::Aggregate,
            );
        }
        if raw.is_empty() {
            return raw;
        }
        self.sweep(env.ts_ms);
        #[cfg(feature = "aggregate")]
        let kept = {
            let mut kept = Vec::with_capacity(raw.len());
            for (finding, is_aggregate) in raw.into_iter().zip(aggregate) {
                if self.admit(&finding, is_aggregate) {
                    kept.push(finding);
                }
            }
            kept
        };
        #[cfg(not(feature = "aggregate"))]
        let kept = {
            raw.retain(|f| self.admit(f));
            raw
        };
        kept
    }

    /// State entries across detectors. Cap tests use this.
    #[cfg(any(test, feature = "testing"))]
    pub fn tracked(&self) -> usize {
        self.slots.iter().map(|s| s.detector.tracked()).sum()
    }

    #[cfg(feature = "aggregate")]
    fn admit(&mut self, f: &Finding, aggregate: bool) -> bool {
        let mut h = DefaultHasher::new();
        f.rule.hash(&mut h);
        if !aggregate {
            f.session.hash(&mut h);
        }
        self.admit_rest(f, h)
    }

    #[cfg(not(feature = "aggregate"))]
    fn admit(&mut self, f: &Finding) -> bool {
        let mut h = DefaultHasher::new();
        f.rule.hash(&mut h);
        f.session.hash(&mut h);
        self.admit_rest(f, h)
    }

    fn admit_rest(&mut self, f: &Finding, mut h: DefaultHasher) -> bool {
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

    #[cfg(feature = "window")]
    #[test]
    fn host_events_reach_provider_rules_only_on_opt_in() {
        struct Host;
        impl Detector for Host {
            fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
                out.emit(env, "hit");
            }
            fn host_events(&self) -> bool {
                true
            }
        }
        fn host(_: &Params) -> Result<Box<dyn Detector>, ParamError> {
            Ok(Box::new(Host))
        }
        let catalog = Catalog::new(vec![
            rule_def("firebase.firestore/host", "firebase", "firestore"),
            rule_def("firebase.firestore/always", "firebase", "firestore"),
        ])
        .unwrap();
        let mut reg = Registry::new();
        reg.register("firebase.firestore/host", host);
        reg.register("firebase.firestore/always", always);
        let config = RuleConfig {
            cooldown_ms: 0,
            ..Default::default()
        };
        let mut engine =
            Engine::build(&catalog.specs(), &config, &reg, &[Evaluation::Local]).unwrap();
        let event = EnvBuilder::get("")
            .provider(HOST_PROVIDER, "connection")
            .connection(false)
            .build();
        let rules: Vec<_> = engine.observe(&event).into_iter().map(|f| f.rule).collect();
        assert_eq!(rules, ["firebase.firestore/host"]);
        let other = EnvBuilder::get("x")
            .provider("supabase", "postgrest")
            .build();
        assert!(engine.observe(&other).is_empty());
    }

    #[cfg(feature = "aggregate")]
    #[test]
    fn aggregate_cooldown_ignores_session() {
        let mut def = rule_def("generic/always-agg", "*", "*");
        def.evaluation = Evaluation::Aggregate;
        let catalog = Catalog::new(vec![def]).unwrap();
        let mut reg = Registry::new();
        reg.register("generic/always-agg", always);
        let mut engine = Engine::build(
            &catalog.specs(),
            &RuleConfig {
                cooldown_ms: 1_000,
                ..Default::default()
            },
            &reg,
            &[Evaluation::Aggregate],
        )
        .unwrap();
        let hit = |session, callsite, ts| {
            EnvBuilder::get("x")
                .session(session)
                .callsite(callsite)
                .at(ts)
                .build()
        };
        assert_eq!(engine.observe(&hit(1, 7, 0)).len(), 1);
        assert!(engine.observe(&hit(2, 7, 500)).is_empty());
        assert_eq!(engine.observe(&hit(3, 8, 500)).len(), 1);
        assert_eq!(engine.observe(&hit(1, 7, 1_000)).len(), 1);
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
