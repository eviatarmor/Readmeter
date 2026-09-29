use readmeter_core::Envelope;

use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::KeyedWindow;

pub const ID: &str = "generic/retry-storm";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(RetryStorm {
        min_errors: p.u64("min_errors")?.max(2) as usize,
        max_attempts: u32::try_from(p.u64("max_attempts")?).unwrap_or(u32::MAX),
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// A failing request retried in a tight loop, or an SDK retrying far beyond
/// a sane backoff.
struct RetryStorm {
    min_errors: usize,
    max_attempts: u32,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for RetryStorm {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.ctx.attempt >= self.max_attempts {
            out.emit(
                env,
                format!(
                    "call on `{}` reached attempt {}; cap retries and back off exponentially",
                    env.target.template, env.ctx.attempt
                ),
            )
            .evidence("attempt", env.ctx.attempt)
            .wasted_units(&env.units);
            return;
        }
        if !env.outcome.is_error() {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let errors = self.window.push(group, env.ts_ms, ()).len();
        if errors < self.min_errors {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{errors} failed calls on `{}` within {}ms; stop retrying on non-transient errors",
                env.target.template, self.window_ms
            ),
        )
        .evidence("errors", errors);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(10_000)),
                ("min_errors", int(3)),
                ("max_attempts", int(5)),
            ],
        )
    }

    #[test]
    fn fires_on_error_burst() {
        let mut e = engine();
        let envs = (0..3).map(|i| {
            EnvBuilder::get("x/{id}")
                .error("permission-denied")
                .at(i * 100)
                .build()
        });
        assert_eq!(run(&mut e, envs).len(), 1);
    }

    #[test]
    fn fires_on_high_attempt() {
        let mut e = engine();
        assert_eq!(
            run(&mut e, [EnvBuilder::get("x/{id}").attempt(5).build()]).len(),
            1
        );
        assert!(run(&mut e, [EnvBuilder::get("x/{id}").attempt(2).build()]).is_empty());
    }
}
