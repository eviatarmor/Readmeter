use std::collections::HashMap;

use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.database/duplicate-listeners";

/// Hard cap on tracked open listeners; state resets beyond it.
const MAX_TRACKED: usize = 16_384;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(DuplicateListeners {
        min_listeners: p.u64("min_listeners")?.max(1),
        open: HashMap::new(),
        counts: HashMap::new(),
    }))
}

/// The same path and query subscribed several times at once from one session.
struct DuplicateListeners {
    min_listeners: u64,
    /// (session, listener) -> target key
    open: HashMap<(u64, u64), u64>,
    /// (session, target key) -> open count
    counts: HashMap<(u64, u64), u64>,
}

impl Detector for DuplicateListeners {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Some(listener) = env.ctx.listener else {
            return;
        };
        let session = env.ctx.session;
        match env.op {
            Op::Subscribe => {
                if self.open.len() >= MAX_TRACKED {
                    self.open.clear();
                    self.counts.clear();
                }
                if self
                    .open
                    .insert((session, listener), env.target.key)
                    .is_some()
                {
                    return;
                }
                let count = self.counts.entry((session, env.target.key)).or_insert(0);
                *count += 1;
                if *count >= self.min_listeners {
                    let count = *count;
                    out.emit(
                        env,
                        format!(
                            "{count} listeners on `{}` open at once from one session; share one subscription",
                            env.target.template
                        ),
                    )
                    .evidence("listeners", count);
                }
            }
            Op::Unsubscribe => {
                if let Some(key) = self.open.remove(&(session, listener)) {
                    if let Some(count) = self.counts.get_mut(&(session, key)) {
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            self.counts.remove(&(session, key));
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
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_listeners", int(3))])
    }

    fn sub(listener: u64, session: u64, key: u64) -> Envelope {
        EnvBuilder::new(Op::Subscribe, "posts")
            .listener(listener)
            .session(session)
            .key(key)
            .provider("firebase", "database")
            .build()
    }

    fn unsub(listener: u64, session: u64, key: u64) -> Envelope {
        EnvBuilder::new(Op::Unsubscribe, "posts")
            .listener(listener)
            .session(session)
            .key(key)
            .provider("firebase", "database")
            .build()
    }

    #[test]
    fn flags_three_open_listeners_on_one_query() {
        let mut quiet = engine();
        assert!(run(&mut quiet, [sub(1, 1, 9), sub(2, 1, 9)]).is_empty());
        let mut hot = engine();
        assert_eq!(
            run(&mut hot, [sub(1, 1, 9), sub(2, 1, 9), sub(3, 1, 9)]).len(),
            1
        );
    }

    #[test]
    fn unsubscribe_queries_and_sessions_stay_separate() {
        let mut balanced_engine = engine();
        let balanced = [sub(1, 1, 9), unsub(1, 1, 9), sub(2, 1, 9), sub(3, 1, 9)];
        assert!(run(&mut balanced_engine, balanced).is_empty());
        let mut queries_engine = engine();
        assert!(
            run(
                &mut queries_engine,
                [sub(1, 1, 1), sub(2, 1, 2), sub(3, 1, 3)]
            )
            .is_empty()
        );
        let mut sessions = engine();
        assert!(run(&mut sessions, [sub(1, 1, 9), sub(2, 2, 9), sub(3, 3, 9)]).is_empty());
    }
}
