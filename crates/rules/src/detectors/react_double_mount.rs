use readmeter_core::{Envelope, Op};

use super::billed;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::BoundedMap;

pub const ID: &str = "generic/react-double-mount";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let max_gap_ms = p.u64("max_gap_ms")?;
    Ok(Box::new(DoubleMount {
        max_gap_ms,
        listeners: BoundedMap::new(60 * 60 * 1_000),
        recent_unsubs: BoundedMap::new(max_gap_ms),
        recent_reads: BoundedMap::new(max_gap_ms),
    }))
}

/// Mount, unmount, mount: the same callsite opens a subscription (or issues a
/// read) twice within a few milliseconds. Typical of effects without a
/// shared cache, surfaced by React StrictMode in development and by
/// remounts (route changes, `key` changes, Suspense retries) in production.
struct DoubleMount {
    max_gap_ms: u64,
    /// (session, listener) -> (target key, callsite, subscribed at)
    listeners: BoundedMap<(u64, u64), (u64, u64, u64)>,
    /// (session, target key, callsite) -> unsubscribed at
    recent_unsubs: BoundedMap<(u64, u64, u64), u64>,
    /// (session, target key, callsite) -> read at
    recent_reads: BoundedMap<(u64, u64, u64), u64>,
}

impl Detector for DoubleMount {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        let key = env.target.key;
        let now = env.ts_ms;
        match env.op {
            Op::Subscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                let callsite = env.ctx.callsite.unwrap_or(0);
                let group = (session, key, callsite);
                if self.recent_unsubs.get(&group, now).is_some() {
                    self.recent_unsubs.remove(&group);
                    out.emit(
                        env,
                        format!(
                            "subscription on `{}` was opened, closed and re-opened within {}ms; dedupe it in a shared store or hook",
                            env.target.template, self.max_gap_ms
                        ),
                    )
                    .evidence("kind", "subscription")
                    .evidence("dev", env.ctx.dev);
                }
                self.listeners
                    .insert((session, listener), now, (key, callsite, now));
            }
            Op::Unsubscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                if let Some((_, (key, callsite, opened))) =
                    self.listeners.remove(&(session, listener))
                {
                    if now.saturating_sub(opened) <= self.max_gap_ms {
                        self.recent_unsubs
                            .insert((session, key, callsite), now, now);
                    }
                }
            }
            Op::Get | Op::Query => {
                let Some(callsite) = env.ctx.callsite else {
                    return;
                };
                if !billed(env) {
                    return;
                }
                let group = (session, key, callsite);
                if self.recent_reads.get(&group, now).is_some() {
                    self.recent_reads.remove(&group);
                    out.emit(
                        env,
                        format!(
                            "`{}` was read twice from the same callsite within {}ms; dedupe the request",
                            env.target.template, self.max_gap_ms
                        ),
                    )
                    .evidence("kind", "read")
                    .evidence("dev", env.ctx.dev)
                    .wasted_units(&env.units);
                    return;
                }
                self.recent_reads.insert(group, now, now);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn ev(op: Op, listener: u64, ts: u64) -> Envelope {
        EnvBuilder::new(op, "todos")
            .callsite(9)
            .listener(listener)
            .at(ts)
            .build()
    }

    #[test]
    fn strict_mode_subscribe_pattern() {
        let mut e = single_rule_engine(ID, build, &[("max_gap_ms", int(200))]);
        let f = run(
            &mut e,
            [
                ev(Op::Subscribe, 1, 0),
                ev(Op::Unsubscribe, 1, 2),
                ev(Op::Subscribe, 2, 3),
            ],
        );
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn long_lived_listener_then_resubscribe_is_fine() {
        let mut e = single_rule_engine(ID, build, &[("max_gap_ms", int(200))]);
        let f = run(
            &mut e,
            [
                ev(Op::Subscribe, 1, 0),
                ev(Op::Unsubscribe, 1, 10_000),
                ev(Op::Subscribe, 2, 10_001),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn double_read_from_same_callsite() {
        let mut e = single_rule_engine(ID, build, &[("max_gap_ms", int(200))]);
        let r = |ts| {
            EnvBuilder::query("todos")
                .callsite(4)
                .items(10)
                .at(ts)
                .build()
        };
        let f = run(&mut e, [r(0), r(5)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 10);
        assert!(run(&mut e, [r(1_000), r(2_000)]).is_empty());
    }
}
