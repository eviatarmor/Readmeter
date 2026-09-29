use readmeter_core::{Envelope, Op};
use readmeter_rules::detectors::callsite_key;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use crate::firestore::billing::WRITES;

pub const ID: &str = "firebase.firestore/write-per-keystroke";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(WritePerKeystroke {
        min_writes: p.u64("min_writes")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// One document set or updated many times from one callsite inside the window.
struct WritePerKeystroke {
    min_writes: usize,
    window_ms: u64,
    /// (session, target key, callsite)
    window: KeyedWindow<(u64, u64, u64), ()>,
}

impl Detector for WritePerKeystroke {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Set | Op::Update) || env.outcome.is_error() {
            return;
        }
        let group = (env.ctx.session, env.target.key, callsite_key(env));
        let writes = self.window.push(group, env.ts_ms, ()).len();
        if writes < self.min_writes {
            return;
        }
        self.window.remove(&group);
        let writes = writes as u64;
        out.emit(
            env,
            format!(
                "one `{}` document written {writes} times in {} ms from one callsite; each keystroke or drag event is a billed write",
                env.target.template, self.window_ms
            ),
        )
        .evidence("writes", writes)
        .evidence("window_ms", self.window_ms)
        .wasted(WRITES, writes.saturating_sub(1));
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
            &[("window_ms", int(5_000)), ("min_writes", int(5))],
        )
    }

    fn wrote(op: Op, key: u64, ts: u64, session: u64, callsite: u64) -> EnvBuilder {
        EnvBuilder::new(op, "drafts/{id}")
            .key(key)
            .at(ts)
            .session(session)
            .callsite(callsite)
    }

    #[test]
    fn fires_and_wastes_every_write_but_one() {
        let mut e = engine();
        let f = run(
            &mut e,
            (0..5).map(|i| wrote(Op::Update, 9, i * 200, 1, 3).build()),
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("writes"), 4);
    }

    #[test]
    fn one_short_creates_and_errors_do_not_fire() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                (0..4).map(|i| wrote(Op::Update, 9, i * 200, 1, 3).build())
            )
            .is_empty()
        );
        let mut e = engine();
        assert!(
            run(
                &mut e,
                (0..5).map(|i| wrote(Op::Create, 9, i * 200, 1, 3).build())
            )
            .is_empty()
        );
        let mut e = engine();
        let errors = (0..5).map(|i| wrote(Op::Set, 9, i * 200, 1, 3).error("aborted").build());
        assert!(run(&mut e, errors).is_empty());
    }

    #[test]
    fn sessions_callsites_and_documents_do_not_mix() {
        let mut e = engine();
        let sessions = (0..6).map(|i| wrote(Op::Update, 9, i * 100, 1 + (i % 2), 3).build());
        assert!(run(&mut e, sessions).is_empty());
        let mut e = engine();
        let callsites = (0..6).map(|i| wrote(Op::Set, 9, i * 100, 1, 1 + (i % 2)).build());
        assert!(run(&mut e, callsites).is_empty());
        let mut e = engine();
        let docs = (0..5).map(|i| wrote(Op::Update, i, i * 100, 1, 3).build());
        assert!(run(&mut e, docs).is_empty());
    }
}
