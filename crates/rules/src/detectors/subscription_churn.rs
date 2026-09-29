use readmeter_core::{Envelope, Op, Units};

use super::billed;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::KeyedWindow;

pub const ID: &str = "generic/subscription-churn";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(SubscriptionChurn {
        min_initial: p.u64("min_initial_snapshots")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// The same subscription is torn down and re-opened repeatedly; every
/// re-open bills the full initial result again.
struct SubscriptionChurn {
    min_initial: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), Units>,
}

impl Detector for SubscriptionChurn {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != (Op::Snapshot { initial: true }) || !billed(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let samples = self.window.push(group, env.ts_ms, env.units.clone());
        if samples.len() < self.min_initial {
            return;
        }
        let reopens = samples.len();
        let mut wasted = Units::new();
        for (_, u) in samples.iter().skip(1) {
            wasted.merge(u);
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "subscription on `{}` re-opened {reopens} times within {}ms; keep one long-lived subscription",
                env.target.template, self.window_ms
            ),
        )
        .evidence("initial_snapshots", reopens)
        .wasted_units(&wasted);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    #[test]
    fn fires_and_counts_rebilled_reads() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(60_000)),
                ("min_initial_snapshots", int(3)),
            ],
        );
        let envs = (0..3).map(|i| {
            EnvBuilder::new(Op::Snapshot { initial: true }, "chats")
                .items(50)
                .listener(i)
                .at(i * 5_000)
                .build()
        });
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 100);
    }

    #[test]
    fn incremental_snapshots_do_not_count() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(60_000)),
                ("min_initial_snapshots", int(3)),
            ],
        );
        let envs = (0..5).map(|i| {
            EnvBuilder::new(Op::Snapshot { initial: false }, "chats")
                .items(1)
                .at(i)
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }
}
