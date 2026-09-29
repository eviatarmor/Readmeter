use std::collections::HashMap;

use readmeter_core::{Envelope, Op};

use super::callsite_key;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};

pub const ID: &str = "generic/listener-leak";

/// Hard cap on tracked open listeners; state resets beyond it.
const MAX_TRACKED: usize = 16_384;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ListenerLeak {
        max_active: p.u64("max_active_per_callsite")?.max(1),
        open: HashMap::new(),
        active: HashMap::new(),
    }))
}

/// Open subscriptions from one callsite keep growing.
struct ListenerLeak {
    max_active: u64,
    /// (session, listener) -> callsite group
    open: HashMap<(u64, u64), u64>,
    /// (session, callsite group) -> open count
    active: HashMap<(u64, u64), u64>,
}

impl Detector for ListenerLeak {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Some(listener) = env.ctx.listener else {
            return;
        };
        let session = env.ctx.session;
        match env.op {
            Op::Subscribe => {
                if self.open.len() >= MAX_TRACKED {
                    self.open.clear();
                    self.active.clear();
                }
                let group = callsite_key(env);
                if self.open.insert((session, listener), group).is_some() {
                    return;
                }
                let count = self.active.entry((session, group)).or_insert(0);
                *count += 1;
                if *count >= self.max_active {
                    let count = *count;
                    out.emit(
                        env,
                        format!(
                            "{count} subscriptions on `{}` open at once from one callsite; unsubscribe on cleanup",
                            env.target.template
                        ),
                    )
                    .evidence("active", count);
                }
            }
            Op::Unsubscribe => {
                if let Some(group) = self.open.remove(&(session, listener)) {
                    if let Some(count) = self.active.get_mut(&(session, group)) {
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            self.active.remove(&(session, group));
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn sub(l: u64) -> Envelope {
        EnvBuilder::new(Op::Subscribe, "rooms/{id}/messages")
            .callsite(1)
            .listener(l)
            .build()
    }
    fn unsub(l: u64) -> Envelope {
        EnvBuilder::new(Op::Unsubscribe, "rooms/{id}/messages")
            .callsite(1)
            .listener(l)
            .build()
    }

    #[test]
    fn fires_when_open_count_reaches_threshold() {
        let mut e = single_rule_engine(ID, build, &[("max_active_per_callsite", int(3))]);
        let f = run(&mut e, (0..3).map(sub));
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn balanced_subscribe_unsubscribe_is_fine() {
        let mut e = single_rule_engine(ID, build, &[("max_active_per_callsite", int(3))]);
        let envs = (0..10).flat_map(|l| [sub(l), unsub(l)]);
        assert!(run(&mut e, envs).is_empty());
    }
}
