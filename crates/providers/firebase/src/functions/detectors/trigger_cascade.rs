use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::named;

pub const ID: &str = "firebase.functions/trigger-cascade";

pub fn build(params: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(TriggerCascade {
        min_writes: params.u64("min_writes")?.max(1),
    }))
}

/// A Firestore-triggered invocation wrote documents that match its own
/// trigger. The shim counts those writes in memory and sends only the count
/// as the `trigger_writes` attribute, so one invoke envelope is enough.
struct TriggerCascade {
    min_writes: u64,
}

impl Detector for TriggerCascade {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "invoke") {
            return;
        }
        let writes = trigger_writes(env);
        if writes < self.min_writes {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` wrote {writes} documents matching its own trigger; each write invokes it again",
                env.target.template
            ),
        )
        .evidence("writes", writes)
        // Each matching write bills one more invocation of this function.
        .wasted("invocations", writes);
    }
}

fn trigger_writes(env: &Envelope) -> u64 {
    env.query
        .as_ref()
        .and_then(|query| {
            query
                .filters
                .iter()
                .find(|filter| filter.field == "trigger_writes")
        })
        .and_then(|filter| filter.op.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Op};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_writes", int(1))])
    }

    fn call(op: &str, writes: Option<u64>) -> Envelope {
        let mut builder = EnvBuilder::new(Op::Other(op.into()), "functions/onPost")
            .provider("firebase", "functions");
        if let Some(writes) = writes {
            builder = builder.with_query(|query| {
                query.filters.push(FilterShape {
                    field: "trigger_writes".into(),
                    op: writes.to_string(),
                });
            });
        }
        builder.build()
    }

    #[test]
    fn flags_writes_that_match_the_trigger_and_wastes_one_invocation_each() {
        let findings = run(&mut engine(), [call("invoke", Some(3))]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].wasted.get("invocations"), 3);
        assert!(findings[0].message.contains("wrote 3 documents"));
    }

    #[test]
    fn ignores_zero_missing_and_callables() {
        assert!(
            run(
                &mut engine(),
                [
                    call("invoke", Some(0)),
                    call("invoke", None),
                    call("callable", Some(5)),
                ]
            )
            .is_empty()
        );
    }

    #[test]
    fn respects_a_higher_threshold() {
        let mut engine = single_rule_engine(ID, build, &[("min_writes", int(3))]);
        assert!(run(&mut engine, [call("invoke", Some(2))]).is_empty());
        assert_eq!(run(&mut engine, [call("invoke", Some(3))]).len(), 1);
    }
}
