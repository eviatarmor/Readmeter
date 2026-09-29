use readmeter_core::{Envelope, Op, Units};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/get-then-listen";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(GetThenListen {
        window_ms,
        reads: BoundedMap::new(window_ms),
    }))
}

/// A one-time read followed by a subscribe on the same target within the window.
struct GetThenListen {
    window_ms: u64,
    /// (session, target key) -> units of the billed read
    reads: BoundedMap<(u64, u64), Units>,
}

impl Detector for GetThenListen {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let group = (env.ctx.session, env.target.key);
        match env.op {
            Op::Get | Op::Query if billed(env) => {
                self.reads.insert(group, env.ts_ms, env.units.clone());
            }
            Op::Subscribe => {
                let Some((ts, units)) = self.reads.remove(&group) else {
                    return;
                };
                let gap = env.ts_ms.saturating_sub(ts);
                if gap > self.window_ms {
                    return;
                }
                out.emit(
                    env,
                    format!(
                        "`{}` fetched with a one-time read, then subscribed within {gap} ms; the listener's first snapshot bills the same documents again",
                        env.target.template
                    ),
                )
                .evidence("gap_ms", gap)
                .wasted_units(&units);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("window_ms", int(10_000))])
    }

    fn read(key: u64, ts: u64) -> Envelope {
        EnvBuilder::query("feed")
            .key(key)
            .at(ts)
            .units(Units::new().with("reads", 6).with("egress_bytes", 900))
            .build()
    }

    fn listen(key: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Subscribe, "feed")
            .key(key)
            .listener(1)
            .at(ts)
            .build()
    }

    #[test]
    fn fires_when_subscribe_follows_a_read() {
        let mut e = engine();
        let f = run(&mut e, [read(3, 1_000), listen(3, 4_000)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 6);
        assert_eq!(f[0].wasted.get("egress_bytes"), 900);
    }

    #[test]
    fn late_subscribe_and_different_query_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, [read(3, 1_000), listen(3, 1_000 + 10_001)]).is_empty());
        let mut e = engine();
        assert!(run(&mut e, [read(3, 1_000), listen(4, 2_000)]).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let envs = [
            EnvBuilder::query("feed").key(3).session(1).items(2).build(),
            EnvBuilder::new(Op::Subscribe, "feed")
                .key(3)
                .listener(1)
                .session(2)
                .at(500)
                .build(),
        ];
        assert!(run(&mut e, envs).is_empty());
    }
}
