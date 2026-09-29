use readmeter_core::{Envelope, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::named;

pub const ID: &str = "firebase.functions/cold-start-heavy";

pub fn build(params: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ColdStartHeavy {
        min_cold_ms: params.u64("min_cold_ms")?.max(1),
    }))
}

/// A cold server invocation that spent seconds before it could run.
/// One sample is enough: the window tier is where server envelopes are judged.
struct ColdStartHeavy {
    min_cold_ms: u64,
}

impl Detector for ColdStartHeavy {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "invoke") || env.ctx.platform != Platform::Server || !cold(env) {
            return;
        }
        let duration_ms = env.duration_us.unwrap_or(0) / 1_000;
        if duration_ms < self.min_cold_ms {
            return;
        }
        let finding = out
            .emit(
                env,
                format!(
                    "`{}` cold start took {duration_ms}ms; set a minimum instance count or move heavy imports inside the handler",
                    env.target.template
                ),
            )
            .evidence("duration_ms", duration_ms);
        let compute = env.units.get("gb_seconds");
        if compute > 0 {
            finding.wasted("gb_seconds", compute);
        }
    }
}

fn cold(env: &Envelope) -> bool {
    env.query.as_ref().is_some_and(|query| {
        query
            .filters
            .iter()
            .any(|filter| filter.field == "cold" && filter.op == "true")
    })
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Op, Platform};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_cold_ms", int(3_000))])
    }

    fn invoke(ms: u64, platform: Platform, is_cold: bool) -> Envelope {
        let mut builder = EnvBuilder::new(Op::Other("invoke".into()), "functions/coldStart")
            .provider("firebase", "functions")
            .platform(platform)
            .duration_us(ms.saturating_mul(1_000));
        if is_cold {
            builder = builder.with_query(|query| {
                query.filters.push(FilterShape {
                    field: "cold".into(),
                    op: "true".into(),
                });
            });
        }
        builder.build()
    }

    #[test]
    fn flags_a_slow_cold_start_on_the_server() {
        let findings = run(&mut engine(), [invoke(3_000, Platform::Server, true)]);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].wasted.is_empty());
    }

    #[test]
    fn ignores_warm_fast_and_browser_calls() {
        assert!(
            run(
                &mut engine(),
                [
                    invoke(2_999, Platform::Server, true),
                    invoke(9_000, Platform::Server, false),
                    invoke(9_000, Platform::Browser, true),
                ]
            )
            .is_empty()
        );
    }
}
