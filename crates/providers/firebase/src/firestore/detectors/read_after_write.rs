use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/read-after-write";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ReadAfterWrite {
        window_ms,
        writes: BoundedMap::new(window_ms),
    }))
}

/// A document get billed shortly after this client created, set, or updated it.
struct ReadAfterWrite {
    window_ms: u64,
    /// (session, target key) -> write timestamp
    writes: BoundedMap<(u64, u64), u64>,
}

impl Detector for ReadAfterWrite {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let group = (env.ctx.session, env.target.key);
        match env.op {
            Op::Create | Op::Set | Op::Update => {
                self.writes.insert(group, env.ts_ms, env.ts_ms);
            }
            Op::Get if billed(env) => {
                let Some((ts, _)) = self.writes.remove(&group) else {
                    return;
                };
                let gap = env.ts_ms.saturating_sub(ts);
                if gap > self.window_ms {
                    return;
                }
                out.emit(
                    env,
                    format!(
                        "`{}` document read back {gap} ms after this client wrote it; keep the written data in local state",
                        env.target.template
                    ),
                )
                .evidence("gap_ms", gap)
                .wasted_units(&env.units);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Units;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("window_ms", int(2_000))])
    }

    fn wrote(ts: u64) -> Envelope {
        EnvBuilder::new(Op::Update, "profiles/{id}")
            .key(9)
            .at(ts)
            .build()
    }

    fn got(ts: u64) -> Envelope {
        EnvBuilder::get("profiles/{id}")
            .key(9)
            .at(ts)
            .units(Units::new().with("reads", 1).with("egress_bytes", 400))
            .build()
    }

    #[test]
    fn fires_on_get_soon_after_a_write() {
        let mut e = engine();
        let f = run(&mut e, [wrote(5_000), got(5_600)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 1);
        assert_eq!(f[0].wasted.get("egress_bytes"), 400);
    }

    #[test]
    fn late_get_and_delete_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, [wrote(5_000), got(5_000 + 2_001)]).is_empty());
        let mut e = engine();
        let deleted = [
            EnvBuilder::new(Op::Delete, "profiles/{id}")
                .key(9)
                .at(1_000)
                .build(),
            got(1_200),
        ];
        assert!(run(&mut e, deleted).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let envs = [
            EnvBuilder::new(Op::Set, "profiles/{id}")
                .key(9)
                .session(1)
                .build(),
            EnvBuilder::get("profiles/{id}")
                .key(9)
                .session(2)
                .at(100)
                .items(1)
                .build(),
        ];
        assert!(run(&mut e, envs).is_empty());
    }
}
