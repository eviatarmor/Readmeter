use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.database/value-listener-on-list";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ValueListenerOnList {
        min_updates: p.u64("min_updates")?.max(1) as usize,
        min_bytes: p.u64("min_bytes")?,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// `onValue` on a list re-downloads every child on each update.
struct ValueListenerOnList {
    min_updates: usize,
    min_bytes: u64,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for ValueListenerOnList {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != (Op::Snapshot { initial: false }) || !billed(env) {
            return;
        }
        if env.bytes() < self.min_bytes || env.items() < 1 {
            return;
        }
        let listener = env.ctx.listener.unwrap_or(0);
        let group = (env.ctx.session, listener);
        let updates = self.window.push(group, env.ts_ms, ()).len();
        if updates < self.min_updates {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "onValue on `{}` delivered {updates} full-list snapshots in {}ms; use child events",
                env.target.template, self.window_ms
            ),
        )
        .evidence("updates", updates)
        .evidence("window_ms", self.window_ms);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("min_updates", int(10)),
                ("window_ms", int(60_000)),
                ("min_bytes", int(102_400)),
            ],
        )
    }

    fn snap(session: u64, listener: u64, ts: u64, bytes: u64, items: u64) -> Envelope {
        EnvBuilder::new(Op::Snapshot { initial: false }, "chats/lobby/messages")
            .session(session)
            .listener(listener)
            .at(ts)
            .items(items)
            .bytes(bytes)
            .provider("firebase", "database")
            .build()
    }

    #[test]
    fn flags_repeated_full_list_updates() {
        let mut quiet = engine();
        assert!(
            run(
                &mut quiet,
                (0..9).map(|i| snap(1, 7, i * 1_000, 102_400, 20))
            )
            .is_empty()
        );
        let mut hot = engine();
        assert_eq!(
            run(
                &mut hot,
                (0..10).map(|i| snap(1, 7, i * 1_000, 102_400, 20))
            )
            .len(),
            1
        );
    }

    #[test]
    fn sessions_listeners_and_small_payloads_do_not_mix() {
        let mut sessions = engine();
        let mixed = (0..10).map(|i| snap((i % 2) + 1, 7, i * 100, 102_400, 20));
        assert!(run(&mut sessions, mixed).is_empty());
        let mut listeners = engine();
        let other_listener = (0..10).map(|i| snap(1, (i % 2) + 1, i * 100, 102_400, 20));
        assert!(run(&mut listeners, other_listener).is_empty());
        let mut rest = engine();
        let tiny = (0..10).map(|i| snap(1, 7, i * 100, 100, 20));
        let scalar = (0..10).map(|i| snap(1, 8, i * 100, 200_000, 0));
        let initial = (0..10).map(|i| {
            EnvBuilder::new(Op::Snapshot { initial: true }, "chats/lobby/messages")
                .listener(9)
                .at(i * 100)
                .items(20)
                .bytes(200_000)
                .provider("firebase", "database")
                .build()
        });
        assert!(run(&mut rest, tiny.chain(scalar).chain(initial)).is_empty());
    }
}
