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
///
/// `ctx.mount` (set by `@readmeter/react`) identifies the component instance.
/// A read carries no unmount signal, so two reads from different mounts are
/// two components that each fetch once, not a remount: reads only pair up
/// when their mounts match (or neither has one). A subscription is closed
/// before it is reopened, so it fires either way; the `mount` evidence says
/// whether the same instance re-ran its effect (StrictMode) or a new
/// instance replaced it.
struct DoubleMount {
    max_gap_ms: u64,
    /// (session, listener) -> the open subscription; the map keeps its time
    listeners: BoundedMap<(u64, u64), OpenListener>,
    /// (session, target key, callsite) -> mount of the closed subscription
    recent_unsubs: BoundedMap<(u64, u64, u64), Option<u64>>,
    /// (session, target key, callsite, mount) -> read at
    recent_reads: BoundedMap<(u64, u64, u64, Option<u64>), u64>,
}

struct OpenListener {
    key: u64,
    callsite: u64,
    mount: Option<u64>,
}

/// `same` or `different` when both calls carry a mount id.
fn mount_relation(before: Option<u64>, now: Option<u64>) -> Option<&'static str> {
    match (before, now) {
        (Some(a), Some(b)) if a == b => Some("same"),
        (Some(_), Some(_)) => Some("different"),
        _ => None,
    }
}

impl Detector for DoubleMount {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        let key = env.target.key;
        let now = env.ts_ms;
        let mount = env.ctx.mount;
        match env.op {
            Op::Subscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                let callsite = env.ctx.callsite.unwrap_or(0);
                let group = (session, key, callsite);
                if let Some(closed) = self.recent_unsubs.remove(&group).and_then(|(at, closed)| {
                    (now.saturating_sub(at) <= self.max_gap_ms).then_some(closed)
                }) {
                    let relation = mount_relation(closed, mount);
                    let who = match relation {
                        Some("same") => " by the same component instance",
                        Some(_) => " by a new component instance",
                        None => "",
                    };
                    let finding = out
                        .emit(
                            env,
                            format!(
                                "subscription on `{}` was opened, closed and re-opened{who} within {}ms; dedupe it in a shared store or hook",
                                env.target.template, self.max_gap_ms
                            ),
                        )
                        .evidence("kind", "subscription")
                        .evidence("dev", env.ctx.dev);
                    if let Some(relation) = relation {
                        finding.evidence("mount", relation);
                    }
                }
                self.listeners.insert(
                    (session, listener),
                    now,
                    OpenListener {
                        key,
                        callsite,
                        mount,
                    },
                );
            }
            Op::Unsubscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                if let Some((opened, open)) = self.listeners.remove(&(session, listener)) {
                    if now.saturating_sub(opened) <= self.max_gap_ms {
                        self.recent_unsubs.insert(
                            (session, open.key, open.callsite),
                            now,
                            open.mount,
                        );
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
                let group = (session, key, callsite, mount);
                if self.recent_reads.get(&group, now).is_some() {
                    self.recent_reads.remove(&group);
                    let finding = out
                        .emit(
                            env,
                            format!(
                                "`{}` was read twice from the same callsite within {}ms; dedupe the request",
                                env.target.template, self.max_gap_ms
                            ),
                        )
                        .evidence("kind", "read")
                        .evidence("dev", env.ctx.dev)
                        .wasted_units(&env.units);
                    if mount.is_some() {
                        finding.evidence("mount", "same");
                    }
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
    use readmeter_core::Scalar;

    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn ev(op: Op, listener: u64, ts: u64) -> Envelope {
        EnvBuilder::new(op, "todos")
            .callsite(9)
            .listener(listener)
            .at(ts)
            .build()
    }

    fn mounted(op: Op, listener: u64, ts: u64, mount: u64) -> Envelope {
        EnvBuilder::new(op, "todos")
            .callsite(9)
            .listener(listener)
            .mount(mount)
            .at(ts)
            .build()
    }

    fn engine() -> crate::Engine {
        single_rule_engine(ID, build, &[("max_gap_ms", int(200))])
    }

    fn mount_evidence(f: &readmeter_core::Finding) -> Option<&Scalar> {
        f.evidence.get("mount")
    }

    #[test]
    fn strict_mode_subscribe_pattern() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                ev(Op::Subscribe, 1, 0),
                ev(Op::Unsubscribe, 1, 2),
                ev(Op::Subscribe, 2, 3),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(mount_evidence(&f[0]), None);
    }

    #[test]
    fn long_lived_listener_then_resubscribe_is_fine() {
        let mut e = engine();
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
    fn same_mount_resubscribe_is_confirmed_as_one_instance() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                mounted(Op::Subscribe, 1, 0, 7),
                mounted(Op::Unsubscribe, 1, 2, 7),
                mounted(Op::Subscribe, 2, 3, 7),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(mount_evidence(&f[0]), Some(&Scalar::from("same")));
        assert!(f[0].message.contains("same component instance"));
    }

    #[test]
    fn new_instance_replacing_the_old_one_still_fires() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                mounted(Op::Subscribe, 1, 0, 7),
                mounted(Op::Unsubscribe, 1, 2, 7),
                mounted(Op::Subscribe, 2, 3, 8),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(mount_evidence(&f[0]), Some(&Scalar::from("different")));
    }

    #[test]
    fn two_mounted_listeners_without_an_unsubscribe_do_not_fire() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                mounted(Op::Subscribe, 1, 0, 7),
                mounted(Op::Subscribe, 2, 1, 8),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn double_read_from_same_callsite() {
        let mut e = engine();
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

    #[test]
    fn reads_pair_only_within_one_mount() {
        let r = |ts, mount| {
            EnvBuilder::query("todos")
                .callsite(4)
                .items(10)
                .mount(mount)
                .at(ts)
                .build()
        };
        // StrictMode: one instance runs its effect twice.
        let mut e = engine();
        let f = run(&mut e, [r(0, 3), r(5, 3)]);
        assert_eq!(f.len(), 1);
        assert_eq!(mount_evidence(&f[0]), Some(&Scalar::from("same")));
        assert_eq!(f[0].wasted.get("reads"), 10);

        // Two sibling components each read once: not a remount.
        let mut e = engine();
        assert!(run(&mut e, [r(0, 3), r(5, 4)]).is_empty());
    }
}
