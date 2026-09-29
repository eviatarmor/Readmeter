use readmeter_core::{Envelope, Op};
use readmeter_rules::detectors::local_hash;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/client-side-bulk-delete";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ClientSideBulkDelete {
        min_deletes: p.u64("min_deletes")?.max(1),
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// A client deletes many documents of one template inside the window.
struct ClientSideBulkDelete {
    min_deletes: u64,
    window_ms: u64,
    /// (session, template hash) -> deletes in that call
    window: KeyedWindow<(u64, u64), u64>,
}

impl Detector for ClientSideBulkDelete {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let n = deletes_in(&env.op);
        if n == 0 {
            return;
        }
        let group = (env.ctx.session, local_hash(env.target.template.as_str()));
        let total = {
            let samples = self.window.push(group, env.ts_ms, n);
            let total = samples
                .iter()
                .fold(0u64, |acc, (_, d)| acc.saturating_add(*d));
            if total < self.min_deletes {
                return;
            }
            total
        };
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{total} documents in `{}` deleted from a client in {} ms",
                env.target.template, self.window_ms
            ),
        )
        .evidence("deletes", total)
        .evidence("window_ms", self.window_ms);
    }
}

fn deletes_in(op: &Op) -> u64 {
    match op {
        Op::Delete => 1,
        Op::Commit { deletes, .. } => u64::from(*deletes),
        _ => 0,
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
            &[("window_ms", int(60_000)), ("min_deletes", int(100))],
        )
    }

    fn delete(ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Delete, "notifications/{id}")
            .at(ts)
            .session(session)
            .key(ts)
            .build()
    }

    fn batch(deletes: u32, ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(
            Op::Commit {
                writes: 0,
                deletes,
                transactional: false,
            },
            "notifications/{id}",
        )
        .at(ts)
        .session(session)
        .build()
    }

    #[test]
    fn fires_once_when_deletes_reach_the_threshold() {
        let mut e = engine();
        let f = run(&mut e, (0..120).map(|i| delete(i * 10, 1)));
        assert_eq!(f.len(), 1);
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn commit_deletes_count_and_one_short_does_not_fire() {
        let mut e = engine();
        let f = run(&mut e, [batch(40, 0, 1), batch(60, 1_000, 1)]);
        assert_eq!(f.len(), 1);
        let mut e = engine();
        assert!(run(&mut e, [batch(99, 0, 1)]).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let split = (0..100).map(|i| delete(i * 10, 1 + (i % 2)));
        assert!(run(&mut e, split).is_empty());
    }
}
