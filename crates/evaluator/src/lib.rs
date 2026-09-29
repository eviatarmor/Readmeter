//! Server-side batch processing.
//!
//! The ingest service (TypeScript, via `bindings/wasm-server`) hands each
//! authenticated request body to [`Evaluator::ingest`], which decodes it,
//! enforces [`Limits`], runs `window` rules and returns JSON-safe rows to
//! store in Postgres. SDKs run `local` rules in-process; everything that
//! needs a sequence of calls runs here.
//!
//! One [`Engine`] per project keeps detector state; detectors key their
//! state by session, so sessions of one project never mix. One project's
//! batches must reach one evaluator instance, or window rules miss patterns
//! split across instances.
//!
//! Findings may duplicate ones an SDK already produced in dev mode (dev
//! builds can run window rules too). Storage dedupes on
//! `(project, rule, session, callsite, template)`.

use std::collections::HashMap;

use readmeter_core::{Batch, Finding, WireError};
use readmeter_provider_api::Provider;
use readmeter_rules::{Bundle, CatalogError, Engine, EngineError, Evaluation, Registry};
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

/// Per-batch caps, checked after decoding and before any rule runs.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_events: usize,
    pub max_findings: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_events: 10_000,
            max_findings: 1_000,
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

pub struct Evaluator {
    bundle: Bundle,
    registry: Registry,
    engines: HashMap<String, (u64, Engine)>,
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
        let evaluator = Self {
            bundle,
            registry,
            engines: HashMap::new(),
            max_projects: DEFAULT_MAX_PROJECTS,
            clock: 0,
        };
        // Fail at startup, not on the first batch, if the bundle is unusable.
        evaluator.build_engine()?;
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

    fn build_engine(&self) -> Result<Engine, EngineError> {
        Engine::build(
            &self.bundle.rules,
            &self.bundle.config,
            &self.registry,
            &[Evaluation::Window],
        )
    }

    /// Runs window rules over every event in the batch, in order.
    pub fn process(
        &mut self,
        project: &str,
        batch: &Batch,
    ) -> Result<Vec<Finding>, EvaluatorError> {
        self.clock += 1;
        let clock = self.clock;
        if !self.engines.contains_key(project) {
            if self.engines.len() >= self.max_projects {
                self.evict_oldest();
            }
            let engine = self.build_engine()?;
            self.engines.insert(project.to_owned(), (clock, engine));
        }
        let Some((last_used, engine)) = self.engines.get_mut(project) else {
            return Ok(Vec::new());
        };
        *last_used = clock;
        Ok(batch
            .events
            .iter()
            .flat_map(|e| engine.observe(e))
            .collect())
    }

    /// Decodes `bytes`, checks `limits`, runs window rules for `project`
    /// and returns rows for storage. Rejected batches do not touch detector
    /// state.
    pub fn ingest(
        &mut self,
        project: &str,
        bytes: &[u8],
        limits: Limits,
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
        let found = self.process(project, &batch)?;
        let findings = batch
            .findings
            .iter()
            .map(|f| FindingRow::from_finding(f, "sdk"))
            .chain(
                found
                    .iter()
                    .map(|f| FindingRow::from_finding(f, "evaluator")),
            )
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

    pub fn projects(&self) -> usize {
        self.engines.len()
    }

    fn evict_oldest(&mut self) {
        if let Some(oldest) = self
            .engines
            .iter()
            .min_by_key(|(_, (used, _))| *used)
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
}
