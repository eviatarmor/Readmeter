use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/initial-load-fanout";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(InitialLoadFanout {
        window_ms: p.u64("window_ms")?.max(1),
        max_distinct: p.u64("max_distinct")?.max(1) as usize,
        // TTL is not the fan-out window. The entry has to outlive it so the
        // session is measured from its first envelope and fires at most once.
        sessions: BoundedMap::new(u64::MAX),
    }))
}

/// Many distinct billed reads in the first moments of a session.
struct InitialLoadFanout {
    window_ms: u64,
    max_distinct: usize,
    sessions: BoundedMap<u64, SessionLoad>,
}

struct SessionLoad {
    start_ts: u64,
    keys: Vec<u64>,
    fired: bool,
}

impl Detector for InitialLoadFanout {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        if self.sessions.get(&session, env.ts_ms).is_none() {
            self.sessions.insert(
                session,
                env.ts_ms,
                SessionLoad {
                    start_ts: env.ts_ms,
                    keys: Vec::new(),
                    fired: false,
                },
            );
        }
        let distinct = {
            let Some(state) = self.sessions.get_mut(&session, env.ts_ms) else {
                return;
            };
            if state.fired || env.ts_ms.saturating_sub(state.start_ts) > self.window_ms {
                return;
            }
            if !counts_toward_fanout(env) || state.keys.contains(&env.target.key) {
                return;
            }
            if state.keys.len() >= self.max_distinct {
                return;
            }
            state.keys.push(env.target.key);
            if state.keys.len() < self.max_distinct {
                return;
            }
            state.fired = true;
            state.keys.len()
        };
        out.emit(
            env,
            format!(
                "{distinct} distinct reads in the first {} ms of the session; page load fans out across many documents and queries",
                self.window_ms
            ),
        )
        .evidence("distinct_reads", distinct)
        .evidence("window_ms", self.window_ms);
    }
}

fn counts_toward_fanout(env: &Envelope) -> bool {
    if !billed(env) {
        return false;
    }
    env.op.is_read() || matches!(env.op, Op::Snapshot { initial: true })
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(5_000)), ("max_distinct", int(30))],
        )
    }

    fn got(key: u64, ts: u64, session: u64) -> Envelope {
        EnvBuilder::get("widgets/{id}")
            .key(key)
            .at(ts)
            .session(session)
            .items(1)
            .build()
    }

    #[test]
    fn fires_once_at_thirty_distinct_reads() {
        let mut e = engine();
        let f = run(&mut e, (0..40).map(|i| got(i, i * 100, 1)));
        assert_eq!(f.len(), 1);
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn one_short_repeats_and_cache_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..29).map(|i| got(i, i * 100, 1))).is_empty());
        let mut e = engine();
        assert!(run(&mut e, (0..40).map(|i| got(1, i * 50, 1))).is_empty());
        let mut e = engine();
        let cached = (0..30).map(|i| {
            EnvBuilder::get("widgets/{id}")
                .key(i)
                .at(i * 50)
                .items(1)
                .cached()
                .build()
        });
        assert!(run(&mut e, cached).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let split = (0..30).map(|i| got(i, i * 100, 1 + (i % 2)));
        assert!(run(&mut e, split).is_empty());
    }

    #[test]
    fn the_window_starts_at_the_first_envelope() {
        let mut e = engine();
        let mut envs = vec![EnvBuilder::new(Op::Set, "boot").at(0).build()];
        envs.extend((0..30).map(|i| got(i, 5_001 + i, 1)));
        assert!(run(&mut e, envs).is_empty());

        let mut e = engine();
        let mut envs = vec![EnvBuilder::new(Op::Update, "boot").at(1_000).build()];
        envs.extend((0..30).map(|i| got(i, 1_000 + i * 100, 1)));
        assert_eq!(run(&mut e, envs).len(), 1);
    }

    #[test]
    fn initial_snapshots_count_and_later_snapshots_do_not() {
        let mut e = engine();
        let initial = (0..30).map(|i| {
            EnvBuilder::new(Op::Snapshot { initial: true }, "feeds/{id}")
                .key(i)
                .at(i * 10)
                .listener(1)
                .items(1)
                .build()
        });
        assert_eq!(run(&mut e, initial).len(), 1);

        let mut e = engine();
        let later = (0..30).map(|i| {
            EnvBuilder::new(Op::Snapshot { initial: false }, "feeds/{id}")
                .key(i)
                .at(i * 10)
                .listener(1)
                .items(1)
                .build()
        });
        assert!(run(&mut e, later).is_empty());
    }
}
