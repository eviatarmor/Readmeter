use readmeter_core::{Envelope, Op};
use readmeter_rules::detectors::callsite_key;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/tiny-batches";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(TinyBatches {
        min_commits: p.u64("min_commits")?.max(2) as usize,
        max_writes_per_commit: p.u64("max_writes_per_commit")?.max(1),
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Many non-transactional commits of one or two operations from one callsite.
struct TinyBatches {
    min_commits: usize,
    max_writes_per_commit: u64,
    window_ms: u64,
    /// (session, callsite)
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for TinyBatches {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Op::Commit {
            writes,
            deletes,
            transactional,
        } = env.op
        else {
            return;
        };
        if transactional {
            return;
        }
        let ops = u64::from(writes).saturating_add(u64::from(deletes));
        if ops > self.max_writes_per_commit {
            return;
        }
        let group = (env.ctx.session, callsite_key(env));
        let commits = self.window.push(group, env.ts_ms, ()).len();
        if commits < self.min_commits {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{commits} batches of at most {} writes each from one callsite in {} ms; combine them into one `writeBatch`",
                self.max_writes_per_commit, self.window_ms
            ),
        )
        .evidence("commits", commits)
        .evidence("window_ms", self.window_ms);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(2_000)),
                ("min_commits", int(10)),
                ("max_writes_per_commit", int(2)),
            ],
        )
    }

    fn commit(writes: u32, deletes: u32, transactional: bool, ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(
            Op::Commit {
                writes,
                deletes,
                transactional,
            },
            "outbox",
        )
        .at(ts)
        .session(session)
        .callsite(4)
        .build()
    }

    #[test]
    fn fires_on_a_burst_of_tiny_commits() {
        let mut e = engine();
        let f = run(&mut e, (0..10).map(|i| commit(1, 0, false, i * 100, 1)));
        assert_eq!(f.len(), 1);
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn one_short_wide_and_transactional_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..9).map(|i| commit(1, 1, false, i * 100, 1))).is_empty());
        let mut e = engine();
        assert!(run(&mut e, (0..10).map(|i| commit(3, 0, false, i * 100, 1))).is_empty());
        let mut e = engine();
        assert!(run(&mut e, (0..10).map(|i| commit(1, 0, true, i * 100, 1))).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let split = (0..10).map(|i| commit(1, 0, false, i * 50, 1 + (i % 2)));
        assert!(run(&mut e, split).is_empty());
    }
}
