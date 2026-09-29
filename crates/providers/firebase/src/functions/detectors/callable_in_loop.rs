use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::named;

pub const ID: &str = "firebase.functions/callable-in-loop";

pub fn build(params: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = params.u64("window_ms")?.max(1);
    Ok(Box::new(CallableInLoop {
        min_calls: params.u64("min_calls")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// One callsite invokes the same callable again and again in a short burst.
struct CallableInLoop {
    min_calls: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64, u64), ()>,
}

impl Detector for CallableInLoop {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "callable") {
            return;
        }
        let Some(callsite) = env.ctx.callsite else {
            return;
        };
        let group = (env.ctx.session, callsite, env.target.key);
        let calls = self.window.push(group, env.ts_ms, ()).len();
        if calls < self.min_calls {
            return;
        }
        self.window.remove(&group);
        let wasted = (calls as u64).saturating_sub(1);
        let finding = out
            .emit(
                env,
                format!(
                    "`{}` was called {calls} times from one callsite in {}ms; batch the work into one call",
                    env.target.template, self.window_ms
                ),
            )
            .evidence("calls", calls)
            .evidence("window_ms", self.window_ms);
        if wasted > 0 {
            finding.wasted("invocations", wasted);
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("min_calls", int(10)), ("window_ms", int(5_000))],
        )
    }

    fn call(session: u64, callsite: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Other("callable".into()), "functions/echo")
            .provider("firebase", "functions")
            .session(session)
            .callsite(callsite)
            .at(ts)
            .build()
    }

    #[test]
    fn flags_the_tenth_call_and_wastes_the_extras() {
        let mut quiet = engine();
        assert!(run(&mut quiet, (0..9).map(|i| call(1, 7, i * 10))).is_empty());
        let mut hot = engine();
        let findings = run(&mut hot, (0..10).map(|i| call(1, 7, i * 10)));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].wasted.get("invocations"), 9);
    }

    #[test]
    fn callsites_sessions_and_gaps_do_not_mix() {
        let mut split = engine();
        assert!(run(&mut split, (0..10).map(|i| call(1, (i % 2) + 1, i * 10))).is_empty());
        let mut sessions = engine();
        assert!(run(&mut sessions, (0..10).map(|i| call((i % 2) + 1, 7, i * 10))).is_empty());
        let mut spread = engine();
        assert!(run(&mut spread, (0..10).map(|i| call(1, 7, i * 5_000))).is_empty());
        let missing = EnvBuilder::new(Op::Other("callable".into()), "functions/echo")
            .provider("firebase", "functions")
            .at(1);
        assert!(run(&mut engine(), [missing.build()]).is_empty());
        assert!(
            run(
                &mut engine(),
                (0..10).map(|i| {
                    EnvBuilder::new(Op::Other("invoke".into()), "functions/echo")
                        .provider("firebase", "functions")
                        .callsite(7)
                        .at(i)
                        .build()
                })
            )
            .is_empty()
        );
    }
}
