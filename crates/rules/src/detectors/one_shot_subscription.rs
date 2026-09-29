use readmeter_core::{Envelope, Op};

use super::callsite_key;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::{BoundedMap, KeyedWindow};

pub const ID: &str = "generic/one-shot-subscription";

/// How far back one-shot occurrences are counted per callsite.
const OCCURRENCE_WINDOW_MS: u64 = 10 * 60 * 1_000;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(OneShot {
        max_lifetime_ms: p.u64("max_lifetime_ms")?,
        min_occurrences: p.u64("min_occurrences")?.max(1) as usize,
        listeners: BoundedMap::new(60 * 60 * 1_000),
        occurrences: KeyedWindow::new(OCCURRENCE_WINDOW_MS),
    }))
}

/// A subscription that receives its first snapshot and is closed right
/// away: a one-time read would do, without keeping a stream open.
struct OneShot {
    max_lifetime_ms: u64,
    min_occurrences: usize,
    /// (session, listener) -> (callsite group, opened at, snapshots)
    listeners: BoundedMap<(u64, u64), (u64, u64, u32)>,
    occurrences: KeyedWindow<(u64, u64), ()>,
}

impl Detector for OneShot {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Some(listener) = env.ctx.listener else {
            return;
        };
        let id = (env.ctx.session, listener);
        let now = env.ts_ms;
        match env.op {
            Op::Subscribe => self.listeners.insert(id, now, (callsite_key(env), now, 0)),
            Op::Snapshot { .. } => {
                if let Some(state) = self.listeners.get_mut(&id, now) {
                    state.2 = state.2.saturating_add(1);
                }
            }
            Op::Unsubscribe => {
                let Some((_, (group, opened, snapshots))) = self.listeners.remove(&id) else {
                    return;
                };
                if snapshots != 1 || now.saturating_sub(opened) > self.max_lifetime_ms {
                    return;
                }
                let key = (env.ctx.session, group);
                let count = self.occurrences.push(key, now, ()).len();
                if count < self.min_occurrences {
                    return;
                }
                self.occurrences.remove(&key);
                out.emit(
                    env,
                    format!(
                        "subscriptions on `{}` close right after the first snapshot; use a one-time read",
                        env.target.template
                    ),
                )
                .evidence("occurrences", count);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn cycle(l: u64, snapshots: u32, life: u64) -> Vec<Envelope> {
        let t0 = l * 100_000;
        let mut v = vec![
            EnvBuilder::new(Op::Subscribe, "cfg")
                .listener(l)
                .callsite(3)
                .at(t0)
                .build(),
        ];
        for i in 0..snapshots {
            v.push(
                EnvBuilder::new(Op::Snapshot { initial: i == 0 }, "cfg")
                    .listener(l)
                    .items(1)
                    .at(t0 + 1)
                    .build(),
            );
        }
        v.push(
            EnvBuilder::new(Op::Unsubscribe, "cfg")
                .listener(l)
                .callsite(3)
                .at(t0 + life)
                .build(),
        );
        v
    }

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[("max_lifetime_ms", int(5_000)), ("min_occurrences", int(2))],
        )
    }

    #[test]
    fn fires_after_repeated_one_shots() {
        let mut e = engine();
        let f = run(&mut e, cycle(1, 1, 100).into_iter().chain(cycle(2, 1, 100)));
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn real_subscriptions_are_fine() {
        let mut e = engine();
        let envs = cycle(1, 3, 100).into_iter().chain(cycle(2, 1, 60_000));
        assert!(run(&mut e, envs).is_empty());
    }
}
