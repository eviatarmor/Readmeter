//! Test helpers shared by detector tests in this and provider crates.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use readmeter_core::{
    CallContext, ClientSetup, Envelope, Finding, IdShape, Op, Outcome, Platform, QueryShape,
    ReadSource, ResultStats, ResultUsage, Severity, Target, Units, VecMap, WriteStats,
};

use crate::catalog::Catalog;
use crate::config::{Params, RuleConfig};
use crate::def::{Category, Evaluation, ParamValue, RuleDef, Status};
use crate::detector::{DetectorFactory, Registry};
use crate::engine::Engine;

/// Minimal valid rule definition.
pub fn rule_def(id: &str, provider: &str, service: &str) -> RuleDef {
    RuleDef {
        id: id.to_owned(),
        title: "t".into(),
        provider: provider.to_owned(),
        service: service.to_owned(),
        severity: Severity::Medium,
        category: Category::Reads,
        evaluation: Evaluation::Local,
        status: Status::Stable,
        default_enabled: true,
        summary: "s".into(),
        description: "d".into(),
        fix: "f".into(),
        docs: vec![],
        params: VecMap::new(),
        examples: vec![],
    }
}

/// Engine running exactly one detector with the given params, cooldown 0.
pub fn single_rule_engine(
    id: &'static str,
    factory: DetectorFactory,
    params: &[(&str, ParamValue)],
) -> Engine {
    let mut def = rule_def(id, "*", "*");
    if let Some((scope, _)) = id.split_once('/') {
        if let Some((p, s)) = scope.split_once('.') {
            def.provider = p.to_owned();
            def.service = s.to_owned();
        }
    }
    def.params = params.iter().map(|(k, v)| (*k, v.clone())).collect();
    // Validate params build eagerly so tests fail loudly.
    factory(&Params::new(id, def.params.clone())).expect("params");
    let catalog = Catalog::new(vec![def]).expect("catalog");
    let mut reg = Registry::new();
    reg.register(id, factory);
    let config = RuleConfig {
        cooldown_ms: 0,
        ..Default::default()
    };
    Engine::build(
        &catalog.specs(),
        &config,
        &reg,
        &[Evaluation::Local, Evaluation::Window, Evaluation::Aggregate],
    )
    .expect("engine")
}

/// Runs envelopes through an engine and collects every finding.
pub fn run(engine: &mut Engine, envs: impl IntoIterator<Item = Envelope>) -> Vec<Finding> {
    envs.into_iter().flat_map(|e| engine.observe(&e)).collect()
}

pub fn int(v: i64) -> ParamValue {
    ParamValue::Int(v)
}

pub fn float(v: f64) -> ParamValue {
    ParamValue::Float(v)
}

/// Fluent envelope builder. Defaults: provider `firebase`, service
/// `firestore`, session 1, attempt 1, ok outcome.
pub struct EnvBuilder(Envelope);

impl EnvBuilder {
    pub fn new(op: Op, template: &str) -> Self {
        Self(Envelope {
            ts_ms: 0,
            provider: "firebase".into(),
            service: "firestore".into(),
            op,
            target: Target {
                template: template.to_owned(),
                key: fnv(template),
                id_shape: None,
                collection_group: false,
            },
            query: None,
            result: None,
            usage: None,
            source: ReadSource::default(),
            write: None,
            setup: None,
            outcome: Outcome::Ok,
            duration_us: None,
            ctx: CallContext {
                session: 1,
                attempt: 1,
                ..Default::default()
            },
            units: Units::new(),
        })
    }

    pub fn get(template: &str) -> Self {
        Self::new(Op::Get, template)
    }

    pub fn query(template: &str) -> Self {
        Self::new(Op::Query, template).shape(QueryShape::default())
    }

    pub fn provider(mut self, provider: &str, service: &str) -> Self {
        self.0.provider = provider.to_owned();
        self.0.service = service.to_owned();
        self
    }

    pub fn at(mut self, ts_ms: u64) -> Self {
        self.0.ts_ms = ts_ms;
        self
    }

    pub fn key(mut self, key: u64) -> Self {
        self.0.target.key = key;
        self
    }

    pub fn id_shape(mut self, shape: IdShape) -> Self {
        self.0.target.id_shape = Some(shape);
        self
    }

    pub fn shape(mut self, shape: QueryShape) -> Self {
        self.0.query = Some(shape);
        self
    }

    pub fn with_query(mut self, f: impl FnOnce(&mut QueryShape)) -> Self {
        f(self.0.query.get_or_insert_with(QueryShape::default));
        self
    }

    /// Sets a non-cached result and bills `items` reads (minimum 1).
    pub fn items(mut self, items: u64) -> Self {
        self.0.result = Some(ResultStats {
            items,
            bytes: items * 1_000,
            ..Default::default()
        });
        self.0.units = Units::new().with("reads", items.max(1));
        self
    }

    pub fn bytes(mut self, bytes: u64) -> Self {
        self.0.result.get_or_insert_with(ResultStats::default).bytes = bytes;
        self
    }

    pub fn cached(mut self) -> Self {
        self.0
            .result
            .get_or_insert_with(ResultStats::default)
            .from_cache = true;
        self.0.units = Units::new();
        self
    }

    pub fn units(mut self, units: Units) -> Self {
        self.0.units = units;
        self
    }

    pub fn usage(mut self, of_call: u64, usage: ResultUsage) -> Self {
        self.0.op = Op::Usage;
        self.0.ctx.call_id = of_call;
        self.0.usage = Some(usage);
        self
    }

    pub fn source(mut self, source: ReadSource) -> Self {
        self.0.source = source;
        self
    }

    pub fn write(mut self, write: WriteStats) -> Self {
        self.0.write = Some(write);
        self
    }

    pub fn transaction(mut self, id: u64) -> Self {
        self.0.ctx.transaction = Some(id);
        self
    }

    /// Sets `op` to [`Op::Init`] and records the client setup.
    pub fn init(mut self, setup: ClientSetup) -> Self {
        self.0.op = Op::Init;
        self.0.setup = Some(setup);
        self
    }

    /// Sets `op` to a page-visibility event.
    pub fn page(mut self, visible: bool) -> Self {
        self.0.op = Op::Page { visible };
        self
    }

    /// Sets `usage.items_used`, inserting a default usage report when absent.
    pub fn items_used(mut self, n: u32) -> Self {
        self.0
            .usage
            .get_or_insert_with(ResultUsage::default)
            .items_used = Some(n);
        self
    }

    pub fn error(mut self, code: &str) -> Self {
        self.0.outcome = Outcome::Error {
            code: code.to_owned(),
        };
        self
    }

    pub fn session(mut self, s: u64) -> Self {
        self.0.ctx.session = s;
        self
    }

    pub fn call_id(mut self, id: u64) -> Self {
        self.0.ctx.call_id = id;
        self
    }

    pub fn callsite(mut self, c: u64) -> Self {
        self.0.ctx.callsite = Some(c);
        self
    }

    pub fn listener(mut self, l: u64) -> Self {
        self.0.ctx.listener = Some(l);
        self
    }

    pub fn attempt(mut self, a: u32) -> Self {
        self.0.ctx.attempt = a;
        self
    }

    pub fn platform(mut self, p: Platform) -> Self {
        self.0.ctx.platform = p;
        self
    }

    pub fn build(self) -> Envelope {
        self.0
    }
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}
