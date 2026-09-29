use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/hot-listener";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(HotListener {
        window_ms,
        max_changed_docs: p.u64("max_changed_docs")?.max(1),
        window: KeyedWindow::new(window_ms),
    }))
}

/// One listener billed for too many changed documents inside the window.
struct HotListener {
    window_ms: u64,
    max_changed_docs: u64,
    /// (session, listener) -> changed documents in that snapshot
    window: KeyedWindow<(u64, u64), u64>,
}

impl Detector for HotListener {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != (Op::Snapshot { initial: false }) || !billed(env) {
            return;
        }
        let Some(listener) = env.ctx.listener else {
            return;
        };
        let group = (env.ctx.session, listener);
        let changed = {
            let samples = self.window.push(group, env.ts_ms, env.items());
            let changed = samples
                .iter()
                .fold(0u64, |acc, (_, n)| acc.saturating_add(*n));
            if changed < self.max_changed_docs {
                return;
            }
            changed
        };
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "listener on `{}` received {changed} changed documents in {} ms; every change bills a read on every client listening",
                env.target.template, self.window_ms
            ),
        )
        .evidence("changed_docs", changed)
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
            &[("window_ms", int(60_000)), ("max_changed_docs", int(200))],
        )
    }

    fn changed(listener: u64, session: u64, docs: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Snapshot { initial: false }, "rooms/{id}/messages")
            .listener(listener)
            .session(session)
            .items(docs)
            .at(ts)
            .build()
    }

    #[test]
    fn fires_when_changed_docs_reach_the_cap() {
        let mut e = engine();
        let f = run(&mut e, (0..4).map(|i| changed(1, 1, 50, i * 1_000)));
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn one_short_does_not_fire() {
        let mut e = engine();
        let envs = [changed(1, 1, 100, 0), changed(1, 1, 99, 1_000)];
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn sessions_and_listeners_do_not_mix() {
        let mut e = engine();
        let split_sessions = [changed(1, 1, 150, 0), changed(1, 2, 150, 1_000)];
        assert!(run(&mut e, split_sessions).is_empty());
        let mut e = engine();
        let split_listeners = [changed(1, 1, 150, 0), changed(2, 1, 150, 1_000)];
        assert!(run(&mut e, split_listeners).is_empty());
    }

    #[test]
    fn initial_and_cached_snapshots_do_not_count() {
        let mut e = engine();
        let envs = [
            EnvBuilder::new(Op::Snapshot { initial: true }, "rooms/{id}/messages")
                .listener(1)
                .items(1_000)
                .build(),
            EnvBuilder::new(Op::Snapshot { initial: false }, "rooms/{id}/messages")
                .listener(1)
                .items(500)
                .cached()
                .at(1_000)
                .build(),
        ];
        assert!(run(&mut e, envs).is_empty());
    }
}
