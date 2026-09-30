//! Server-side batch processing.
//!
//! The ingest service (TypeScript, via `bindings/wasm-server`) hands each
//! authenticated request body to [`Evaluator::ingest`], which decodes it,
//! enforces [`Limits`], runs `window` and `aggregate` rules and returns
//! JSON-safe rows to store in Postgres. SDKs run `local` rules in-process.
//! `window` rules also run here (and in SDK dev builds). `aggregate` rules
//! run only here.
//!
//! Ingest keeps one [`Evaluator`] for the process and feeds every project
//! through it. Each project has two engines: `window` (detector state keyed
//! by session) and `aggregate` (state shared across that project's
//! sessions, still keyed by project-local hashes). Projects do not share
//! engines. A restart drops both; the next batches start from empty
//! windows. That is acceptable: a missed cross-session finding is
//! re-detected once the pattern shows up again.
//!
//! Memory is capped in two places. [`Limits::max_projects`] is the total
//! number of projects kept; past it the least recently active project is
//! evicted, engines included. Each detector caps its own maps
//! (`BoundedMap`, `KeyedWindow`), which is the per-project bound. The
//! detector trait does not take [`Limits`], so those map caps stay inside
//! the detectors.
//!
//! One project's batches must reach this same instance, or window and
//! aggregate rules miss patterns split across processes.
//!
//! Findings may duplicate ones an SDK already produced in dev mode (dev
//! builds can run window rules too). Storage dedupes on
//! `(project, rule, session, callsite, template)`. Aggregate findings use
//! session `"*"` so that key collapses every session into one row.

use std::collections::{HashMap, HashSet};

use readmeter_core::{Batch, Finding, WireError};
use readmeter_provider_api::Provider;
use readmeter_rules::{
    Bundle, CatalogError, Engine, EngineError, Evaluation, Registry, RuleConfig,
};
use serde::Serialize;

pub mod rows;

use rows::{BatchRow, EventRow, FindingRow};

/// Upper bound on projects held in memory by one instance. Beyond it the
/// least recently used engine is dropped (losing only in-flight windows).
const DEFAULT_MAX_PROJECTS: usize = 1_024;

#[derive(Debug, thiserror::Error)]
pub enum EvaluatorError {
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error(transparent)]
    Engine(#[from] EngineError),
}

/// Per-batch caps, checked after decoding and before any rule runs, plus
/// the total number of projects whose detector state is kept in memory.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_events: usize,
    pub max_findings: usize,
    /// Projects held at once. The least recently active project is evicted
    /// past this, which drops its window and aggregate state.
    pub max_projects: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_events: 10_000,
            max_findings: 1_000,
            max_projects: DEFAULT_MAX_PROJECTS,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("{0}")]
    Decode(#[from] WireError),
    #[error("batch has {count} {what}, limit is {limit}")]
    TooLarge {
        what: &'static str,
        count: usize,
        limit: usize,
    },
    #[error(transparent)]
    Evaluator(#[from] EvaluatorError),
}

impl IngestError {
    /// Stable machine-readable code for HTTP error bodies.
    pub fn code(&self) -> &'static str {
        match self {
            IngestError::Decode(_) => "bad_batch",
            IngestError::TooLarge { .. } => "batch_too_large",
            IngestError::Evaluator(_) => "internal",
        }
    }
}

/// Everything to store for one accepted batch.
#[derive(Debug, Serialize)]
pub struct Ingested {
    pub batch: BatchRow,
    pub events: Vec<EventRow>,
    /// SDK findings from the batch, then evaluator findings.
    pub findings: Vec<FindingRow>,
}

struct ProjectEngines {
    last_used: u64,
    /// Override revision this pair was built from. A different revision
    /// rebuilds both engines and drops that project's window state.
    revision: String,
    window: Engine,
    aggregate: Engine,
}

pub struct Evaluator {
    bundle: Bundle,
    registry: Registry,
    /// Rule ids with `evaluation = "aggregate"`. Their rows use session `"*"`.
    aggregate_rules: HashSet<String>,
    engines: HashMap<String, ProjectEngines>,
    max_projects: usize,
    clock: u64,
}

impl Evaluator {
    /// `providers` contribute their detectors; generic detectors are always
    /// included.
    pub fn new(bundle: Bundle, providers: &[&dyn Provider]) -> Result<Self, EvaluatorError> {
        bundle.validate()?;
        let mut registry = Registry::with_generic();
        for p in providers {
            registry.extend(p.detectors());
        }
        let aggregate_rules = bundle
            .rules
            .iter()
            .filter(|r| r.evaluation == Evaluation::Aggregate)
            .map(|r| r.id.clone())
            .collect();
        let evaluator = Self {
            bundle,
            registry,
            aggregate_rules,
            engines: HashMap::new(),
            max_projects: DEFAULT_MAX_PROJECTS,
            clock: 0,
        };
        // Fail at startup, not on the first batch, if the bundle is unusable.
        evaluator.build_engine(&[Evaluation::Window])?;
        evaluator.build_engine(&[Evaluation::Aggregate])?;
        Ok(evaluator)
    }

    /// Evaluator with every provider compiled into this binary.
    pub fn with_all_providers(bundle: Bundle) -> Result<Self, EvaluatorError> {
        Self::new(bundle, &[&readmeter_provider_firebase::FirebaseProvider])
    }

    pub fn with_max_projects(mut self, max: usize) -> Self {
        self.max_projects = max.max(1);
        self
    }

    fn build_engine(&self, evaluations: &[Evaluation]) -> Result<Engine, EngineError> {
        Engine::build(
            &self.bundle.rules,
            &self.bundle.config,
            &self.registry,
            evaluations,
        )
    }

    /// Bundle defaults. Overrides are layered on a clone of this.
    pub fn config(&self) -> &RuleConfig {
        &self.bundle.config
    }

    /// Runs window rules, then aggregate rules, over every event in order.
    /// Uses the bundle's default config and a stable revision, so repeated
    /// calls keep the project's window state.
    pub fn process(
        &mut self,
        project: &str,
        batch: &Batch,
    ) -> Result<Vec<Finding>, EvaluatorError> {
        let config = self.bundle.config.clone();
        self.process_configured(project, batch, "", &config)
    }

    /// Like [`process`](Self::process), but builds this project's engines
    /// from `config` and rebuilds them when `revision` changes.
    pub fn process_configured(
        &mut self,
        project: &str,
        batch: &Batch,
        revision: &str,
        config: &RuleConfig,
    ) -> Result<Vec<Finding>, EvaluatorError> {
        self.ensure(project, revision, config)?;
        let Some(slot) = self.engines.get_mut(project) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for event in &batch.events {
            out.extend(slot.window.observe(event));
            out.extend(slot.aggregate.observe(event));
        }
        Ok(out)
    }

    /// Decodes `bytes`, checks `limits`, runs window and aggregate rules
    /// for `project` and returns rows for storage. Rejected batches do not
    /// touch detector state. Aggregate findings are stored with session
    /// `"*"`. Uses the bundle's default config.
    pub fn ingest(
        &mut self,
        project: &str,
        bytes: &[u8],
        limits: Limits,
    ) -> Result<Ingested, IngestError> {
        let config = self.bundle.config.clone();
        self.ingest_with_overrides(project, bytes, limits, "", &config)
    }

    /// Like [`ingest`](Self::ingest), with project overrides applied when
    /// `revision` differs from the engines already held for `project`.
    pub fn ingest_with_overrides(
        &mut self,
        project: &str,
        bytes: &[u8],
        limits: Limits,
        revision: &str,
        config: &RuleConfig,
    ) -> Result<Ingested, IngestError> {
        let batch = Batch::decode(bytes)?;
        for (what, count, limit) in [
            ("events", batch.events.len(), limits.max_events),
            ("findings", batch.findings.len(), limits.max_findings),
        ] {
            if count > limit {
                return Err(IngestError::TooLarge { what, count, limit });
            }
        }
        self.max_projects = limits.max_projects.max(1);
        let found = self.process_configured(project, &batch, revision, config)?;
        let findings = batch
            .findings
            .iter()
            .map(|f| FindingRow::from_finding(f, "sdk"))
            .chain(found.iter().map(|f| self.finding_row(f)))
            .collect();
        Ok(Ingested {
            batch: BatchRow {
                schema: batch.schema,
                sdk: batch.sdk.clone(),
                session: rows::hex(batch.session),
                sent_at_ms: batch.sent_at_ms,
                dropped_events: batch.dropped_events,
                dropped_findings: batch.dropped_findings,
            },
            events: batch.events.iter().map(EventRow::from_envelope).collect(),
            findings,
        })
    }

    /// Builds engines before inserting them. A bad config leaves the
    /// previous pair in place.
    fn ensure(
        &mut self,
        project: &str,
        revision: &str,
        config: &RuleConfig,
    ) -> Result<(), EngineError> {
        self.clock += 1;
        let clock = self.clock;
        let rebuild = match self.engines.get(project) {
            Some(slot) => slot.revision != revision,
            None => true,
        };
        if !rebuild {
            if let Some(slot) = self.engines.get_mut(project) {
                slot.last_used = clock;
            }
            return Ok(());
        }
        let window = Engine::build(
            &self.bundle.rules,
            config,
            &self.registry,
            &[Evaluation::Window],
        )?;
        let aggregate = Engine::build(
            &self.bundle.rules,
            config,
            &self.registry,
            &[Evaluation::Aggregate],
        )?;
        if !self.engines.contains_key(project) && self.engines.len() >= self.max_projects {
            self.evict_oldest();
        }
        self.engines.insert(
            project.to_owned(),
            ProjectEngines {
                last_used: clock,
                revision: revision.to_owned(),
                window,
                aggregate,
            },
        );
        Ok(())
    }

    pub fn projects(&self) -> usize {
        self.engines.len()
    }

    fn finding_row(&self, f: &Finding) -> FindingRow {
        if self.aggregate_rules.contains(&f.rule) {
            FindingRow::with_session(f, "evaluator", "*".to_owned())
        } else {
            FindingRow::from_finding(f, "evaluator")
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(oldest) = self
            .engines
            .iter()
            .min_by_key(|(_, slot)| slot.last_used)
            .map(|(k, _)| k.clone())
        {
            self.engines.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::Path;

    use readmeter_rules::Catalog;
    use readmeter_runtime::Client;
    use serde_json::json;

    use super::*;

    fn bundle() -> Bundle {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rules");
        Catalog::load_dir(&dir)
            .unwrap()
            .bundle("test", Default::default())
    }

    /// A production-like client (local rules only) produces a batch; the
    /// evaluator finds the window pattern in it.
    fn batch_with_growing_limits(session: u64) -> Batch {
        let config = json!({
            "provider": "firebase",
            "sdk": {"name": "t", "version": "0"},
            "session": session,
            "hash_key": "000102030405060708090a0b0c0d0e0f",
        });
        let bundle = bundle().encode().unwrap();
        let mut client = Client::from_bytes(config.to_string().as_bytes(), &bundle).unwrap();
        for (i, limit) in [20u64, 40, 60].into_iter().enumerate() {
            let call = json!({
                "service": "firestore", "op": "query", "ts_ms": 1_000 * i as u64, "path": "feed",
                "query": {"order_by": [{"field": "ts"}], "limit": limit},
                "result": {"docs": limit}
            });
            let local = client.record(call.to_string().as_bytes()).unwrap();
            assert!(
                local.is_empty(),
                "local-only client must not run window rules"
            );
        }
        client.drain(10_000).unwrap()
    }

    #[test]
    fn finds_window_patterns_in_sdk_batches() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let findings = ev.process("proj_a", &batch_with_growing_limits(1)).unwrap();
        let rules: Vec<&str> = findings.iter().map(|f| f.rule.as_str()).collect();
        assert_eq!(rules, ["firebase.firestore/missing-cursor"]);
    }

    #[test]
    fn projects_are_isolated_and_bounded() {
        let mut ev = Evaluator::with_all_providers(bundle())
            .unwrap()
            .with_max_projects(2);
        let batch = batch_with_growing_limits(1);
        let (first, rest) = batch.events.split_at(2);
        let part = |events: &[readmeter_core::Envelope]| Batch {
            events: events.to_vec(),
            ..batch.clone()
        };
        // Two pages in project a, the third page in project b: no pattern in either.
        assert!(ev.process("a", &part(first)).unwrap().is_empty());
        assert!(ev.process("b", &part(rest)).unwrap().is_empty());
        ev.process("c", &part(rest)).unwrap();
        assert_eq!(ev.projects(), 2);
    }

    #[test]
    fn ingest_returns_js_safe_rows() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let bytes = batch_with_growing_limits(u64::MAX).encode().unwrap();
        let out = ev.ingest("p", &bytes, Limits::default()).unwrap();
        assert_eq!(out.batch.session, "ffffffffffffffff");
        assert_eq!(out.events.len(), 3);
        assert_eq!(out.events[0].op, "query");
        assert_eq!(out.events[0].target_key.len(), 16);
        assert_eq!(out.findings.len(), 1);
        assert_eq!(out.findings[0].source, "evaluator");
        let json = serde_json::to_value(&out).unwrap();
        assert_eq!(json["events"][0]["query"]["limit"], 20);
        assert_eq!(json["findings"][0]["severity"], "high");
    }

    #[test]
    fn ingest_rejects_before_touching_state() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let err = ev.ingest("p", b"garbage", Limits::default()).unwrap_err();
        assert_eq!(err.code(), "bad_batch");
        let bytes = batch_with_growing_limits(1).encode().unwrap();
        let tight = Limits {
            max_events: 2,
            ..Limits::default()
        };
        let err = ev.ingest("p", &bytes, tight).unwrap_err();
        assert_eq!(err.code(), "batch_too_large");
        assert_eq!(ev.projects(), 0);
    }

    fn listen_batch(session: u64) -> Batch {
        let config = json!({
            "provider": "firebase",
            "sdk": {"name": "t", "version": "0"},
            "session": session,
            "hash_key": "000102030405060708090a0b0c0d0e0f",
            "evaluations": ["local"],
        });
        let bundle = bundle().encode().unwrap();
        let mut client = Client::from_bytes(config.to_string().as_bytes(), &bundle).unwrap();
        let query = json!({"order_by": [{"field": "at", "direction": "desc"}], "limit": 20});
        let subscribe = json!({
            "service": "firestore", "op": "subscribe", "ts_ms": session * 1_000,
            "call_id": 1, "listener": 1, "path": "rooms/general/messages", "query": query,
        });
        let snapshot = json!({
            "service": "firestore", "op": "snapshot", "initial": false,
            "ts_ms": session * 1_000 + 100, "call_id": 2, "listener": 1,
            "path": "rooms/general/messages", "query": query,
            "result": {"docs": 1, "bytes": 100},
        });
        for call in [subscribe, snapshot] {
            let local = client.record(call.to_string().as_bytes()).unwrap();
            assert!(
                local.is_empty(),
                "fixture must not trip a local rule: {local:?}"
            );
        }
        client.drain(10_000).unwrap()
    }

    #[test]
    fn aggregate_findings_span_sessions_and_not_projects() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let broadcast = |ev: &mut Evaluator, project: &str, session: u64| {
            let bytes = listen_batch(session).encode().unwrap();
            ev.ingest(project, &bytes, Limits::default())
                .unwrap()
                .findings
                .into_iter()
                .filter(|f| f.rule == "firebase.firestore/broadcast-listener")
                .collect::<Vec<_>>()
        };
        for session in 1..=40 {
            assert!(broadcast(&mut ev, "a", session).is_empty());
            assert!(broadcast(&mut ev, "b", session).is_empty());
        }
        for session in 41..50 {
            assert!(broadcast(&mut ev, "a", session).is_empty());
        }
        let found = broadcast(&mut ev, "a", 50);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session, "*");
        assert_eq!(found[0].source, "evaluator");
        assert!(broadcast(&mut ev, "b", 41).is_empty());
        assert!(broadcast(&mut ev, "a", 51).is_empty());
    }

    fn page(batch: &Batch, index: usize) -> Batch {
        Batch {
            events: vec![batch.events[index].clone()],
            ..batch.clone()
        }
    }

    fn cursor_rule(
        enabled: Option<bool>,
        severity: Option<readmeter_core::Severity>,
        min_pages: Option<i64>,
    ) -> readmeter_rules::RuleOverride {
        let mut params = readmeter_core::VecMap::new();
        if let Some(n) = min_pages {
            params.insert("min_pages", readmeter_rules::ParamValue::Int(n));
        }
        readmeter_rules::RuleOverride {
            enabled,
            severity,
            params,
        }
    }

    fn config_with(ev: &Evaluator, ov: readmeter_rules::RuleOverride) -> RuleConfig {
        let mut config = ev.config().clone();
        config
            .overrides
            .insert("firebase.firestore/missing-cursor", ov);
        config
    }

    #[test]
    fn same_revision_keeps_window_state() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let batch = batch_with_growing_limits(1);
        let config = ev.config().clone();
        assert!(
            ev.process_configured("p", &page(&batch, 0), "r1", &config)
                .unwrap()
                .is_empty()
        );
        assert!(
            ev.process_configured("p", &page(&batch, 1), "r1", &config)
                .unwrap()
                .is_empty()
        );
        let third = ev
            .process_configured("p", &page(&batch, 2), "r1", &config)
            .unwrap();
        assert!(
            third
                .iter()
                .any(|f| f.rule == "firebase.firestore/missing-cursor")
        );
    }

    #[test]
    fn revision_change_rebuilds_and_drops_the_window() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let batch = batch_with_growing_limits(1);
        let config = ev.config().clone();
        assert!(
            ev.process_configured("p", &page(&batch, 0), "r1", &config)
                .unwrap()
                .is_empty()
        );
        assert!(
            ev.process_configured("p", &page(&batch, 1), "r1", &config)
                .unwrap()
                .is_empty()
        );
        let disabled = config_with(&ev, cursor_rule(Some(false), None, None));
        let third = ev
            .process_configured("p", &page(&batch, 2), "r2", &disabled)
            .unwrap();
        assert!(
            third
                .iter()
                .all(|f| f.rule != "firebase.firestore/missing-cursor")
        );
    }

    #[test]
    fn disabled_override_emits_no_backend_finding() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let batch = batch_with_growing_limits(1);
        let config = config_with(&ev, cursor_rule(Some(false), None, None));
        let found = ev.process_configured("p", &batch, "off", &config).unwrap();
        assert!(
            found
                .iter()
                .all(|f| f.rule != "firebase.firestore/missing-cursor")
        );
    }

    #[test]
    fn param_override_changes_the_threshold() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let batch = batch_with_growing_limits(1);
        let config = config_with(&ev, cursor_rule(None, None, Some(10)));
        let found = ev
            .process_configured("p", &batch, "pages", &config)
            .unwrap();
        assert!(
            found
                .iter()
                .all(|f| f.rule != "firebase.firestore/missing-cursor")
        );
    }

    #[test]
    fn severity_override_is_what_gets_stored() {
        let mut ev = Evaluator::with_all_providers(bundle()).unwrap();
        let batch = batch_with_growing_limits(1);
        let config = config_with(
            &ev,
            cursor_rule(None, Some(readmeter_core::Severity::Low), None),
        );
        let found = ev.process_configured("p", &batch, "sev", &config).unwrap();
        let hit = found
            .iter()
            .find(|f| f.rule == "firebase.firestore/missing-cursor")
            .unwrap();
        assert_eq!(hit.severity, readmeter_core::Severity::Low);
    }
}
