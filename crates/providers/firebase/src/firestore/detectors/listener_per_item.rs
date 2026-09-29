use std::collections::HashMap;

use readmeter_core::{Envelope, Op};
use readmeter_rules::detectors::local_hash;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/listener-per-item";

/// Hard cap on tracked open listeners; state resets beyond it.
const MAX_TRACKED: usize = 16_384;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ListenerPerItem {
        max_active: p.u64("max_active")?.max(1),
        open: HashMap::new(),
        active: HashMap::new(),
    }))
}

/// Many single-document listeners open at once on one document template.
struct ListenerPerItem {
    max_active: u64,
    /// (session, listener) -> template group
    open: HashMap<(u64, u64), u64>,
    /// (session, template group) -> open doc listeners
    active: HashMap<(u64, u64), u64>,
}

impl Detector for ListenerPerItem {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        // A document listener has no query shape. Collection listeners always do.
        if env.query.is_some() {
            return;
        }
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
                let group = local_hash(&env.target.template);
                if self.open.insert((session, listener), group).is_some() {
                    return;
                }
                let count = self.active.entry((session, group)).or_insert(0);
                *count = count.saturating_add(1);
                let count = *count;
                if count == self.max_active {
                    out.emit(
                        env,
                        format!(
                            "{count} single-document listeners open on `{}`; one query listener over the set bills the same documents with one listener",
                            env.target.template
                        ),
                    )
                    .evidence("active", count);
                }
            }
            Op::Unsubscribe => {
                let Some(group) = self.open.remove(&(session, listener)) else {
                    return;
                };
                let Some(count) = self.active.get_mut(&(session, group)) else {
                    return;
                };
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.active.remove(&(session, group));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::QueryShape;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("max_active", int(25))])
    }

    fn doc(listener: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Subscribe, "posts/{id}")
            .listener(listener)
            .session(session)
            .build()
    }

    fn unsub(listener: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Unsubscribe, "posts/{id}")
            .listener(listener)
            .session(session)
            .build()
    }

    #[test]
    fn fires_when_doc_listeners_reach_the_cap() {
        let mut e = engine();
        let f = run(&mut e, (0..25).map(|i| doc(i, 1)));
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn twenty_four_does_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..24).map(|i| doc(i, 1))).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let envs = (0..25).map(|i| doc(i, 1 + (i % 2)));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn unsubscribe_lowers_the_count() {
        let mut e = engine();
        let mut envs = (0..25).map(|i| doc(i, 1)).collect::<Vec<_>>();
        envs.push(unsub(0, 1));
        envs.push(doc(100, 1));
        assert_eq!(run(&mut e, envs).len(), 2);
    }

    #[test]
    fn collection_listeners_do_not_count() {
        let mut e = engine();
        let envs = (0..30).map(|i| {
            EnvBuilder::new(Op::Subscribe, "posts")
                .listener(i)
                .shape(QueryShape::default())
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }
}
