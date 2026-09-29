use std::collections::HashMap;

use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/get-while-listening";

/// Hard cap on tracked open listeners; state resets beyond it.
const MAX_TRACKED: usize = 16_384;

pub fn build(_p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(GetWhileListening {
        open: HashMap::new(),
        active: HashMap::new(),
    }))
}

/// A billed read of a target that already has an open listener in this session.
struct GetWhileListening {
    /// (session, listener) -> target key
    open: HashMap<(u64, u64), u64>,
    /// (session, target key) -> open listeners
    active: HashMap<(u64, u64), u64>,
}

impl Detector for GetWhileListening {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        match env.op {
            Op::Subscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                if self.open.len() >= MAX_TRACKED {
                    self.open.clear();
                    self.active.clear();
                }
                let key = env.target.key;
                if self.open.insert((session, listener), key).is_some() {
                    return;
                }
                let count = self.active.entry((session, key)).or_insert(0);
                *count = count.saturating_add(1);
            }
            Op::Unsubscribe => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                let Some(key) = self.open.remove(&(session, listener)) else {
                    return;
                };
                let Some(count) = self.active.get_mut(&(session, key)) else {
                    return;
                };
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.active.remove(&(session, key));
                }
            }
            Op::Get | Op::Query if billed(env) => {
                let Some(&n) = self.active.get(&(session, env.target.key)) else {
                    return;
                };
                if n == 0 {
                    return;
                }
                out.emit(
                    env,
                    format!(
                        "`{}` read from the server while a listener on the same query is open; read the listener's data instead",
                        env.target.template
                    ),
                )
                .evidence("active_listeners", n)
                .wasted_units(&env.units);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Units;
    use readmeter_rules::testing::{EnvBuilder, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[])
    }

    fn listen(key: u64, listener: u64) -> EnvBuilder {
        EnvBuilder::new(Op::Subscribe, "inbox")
            .key(key)
            .listener(listener)
    }

    fn unlisten(key: u64, listener: u64) -> EnvBuilder {
        EnvBuilder::new(Op::Unsubscribe, "inbox")
            .key(key)
            .listener(listener)
    }

    fn read(key: u64) -> EnvBuilder {
        EnvBuilder::query("inbox")
            .key(key)
            .units(Units::new().with("reads", 4).with("egress_bytes", 800))
    }

    #[test]
    fn fires_while_a_listener_is_open() {
        let mut e = engine();
        let f = run(&mut e, [listen(7, 1).build(), read(7).at(500).build()]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 4);
        assert_eq!(f[0].wasted.get("egress_bytes"), 800);
    }

    #[test]
    fn unsubscribe_and_cache_do_not_fire() {
        let mut e = engine();
        let after_unsub = [
            listen(7, 1).build(),
            unlisten(7, 1).at(100).build(),
            read(7).at(200).build(),
        ];
        assert!(run(&mut e, after_unsub).is_empty());

        let mut e = engine();
        let cached = [listen(7, 1).build(), read(7).cached().at(200).build()];
        assert!(run(&mut e, cached).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let envs = [listen(7, 1).session(1).build(), read(7).session(2).build()];
        assert!(run(&mut e, envs).is_empty());
    }
}
