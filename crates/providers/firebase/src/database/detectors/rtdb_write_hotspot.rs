use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.database/rtdb-write-hotspot";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(WriteHotspot {
        min_writes: p.u64("min_writes")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Many writes to one path from one session.
struct WriteHotspot {
    min_writes: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for WriteHotspot {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !env.op.is_single_write() {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let writes = self.window.push(group, env.ts_ms, ()).len();
        if writes < self.min_writes {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` written {writes} times in {}ms from one session; batch or slow the writes",
                env.target.template, self.window_ms
            ),
        )
        .evidence("writes", writes)
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
            &[("min_writes", int(20)), ("window_ms", int(10_000))],
        )
    }

    fn write(template: &str, session: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Update, template)
            .session(session)
            .at(ts)
            .provider("firebase", "database")
            .build()
    }

    #[test]
    fn flags_a_burst_on_one_path() {
        let mut quiet = engine();
        assert!(
            run(
                &mut quiet,
                (0..19).map(|i| write("counters/online", 1, i * 100))
            )
            .is_empty()
        );
        let mut hot = engine();
        assert_eq!(
            run(
                &mut hot,
                (0..20).map(|i| write("counters/online", 1, i * 100))
            )
            .len(),
            1
        );
    }

    #[test]
    fn sessions_and_paths_do_not_mix() {
        let mut sessions = engine();
        let split = (0..20).map(|i| write("counters/online", (i % 2) + 1, i * 100));
        assert!(run(&mut sessions, split).is_empty());
        let mut paths_engine = engine();
        let paths = (0..20).map(|i| {
            let template = if i % 2 == 0 { "a" } else { "b" };
            write(template, 1, i * 100)
        });
        assert!(run(&mut paths_engine, paths).is_empty());
        let mut spread = engine();
        assert!(
            run(
                &mut spread,
                (0..20).map(|i| write("counters/online", 1, i * 1_000))
            )
            .is_empty()
        );
    }
}
