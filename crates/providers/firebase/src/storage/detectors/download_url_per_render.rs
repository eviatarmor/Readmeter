use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.storage/download-url-per-render";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(DownloadUrlPerRender {
        min_calls: p.u64("min_calls")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// The same object’s download URL fetched again and again in one session.
struct DownloadUrlPerRender {
    min_calls: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for DownloadUrlPerRender {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "download_url") || !billed(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let calls = self.window.push(group, env.ts_ms, ()).len();
        if calls < self.min_calls {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` getDownloadURL called {calls} times in {}ms; cache the download URL",
                env.target.template, self.window_ms
            ),
        )
        .evidence("calls", calls)
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
            &[("min_calls", int(5)), ("window_ms", int(60_000))],
        )
    }

    fn url(session: u64, key: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Other("download_url".into()), "photos/hero.png")
            .provider("firebase", "storage")
            .session(session)
            .key(key)
            .at(ts)
            .build()
    }

    #[test]
    fn flags_the_fifth_call_and_then_starts_over() {
        let mut quiet = engine();
        assert!(run(&mut quiet, (0..4).map(|i| url(1, 1, i * 1000))).is_empty());
        let mut hot = engine();
        assert_eq!(run(&mut hot, (0..5).map(|i| url(1, 1, i * 1000))).len(), 1);
        let mut again = engine();
        assert_eq!(
            run(&mut again, (0..10).map(|i| url(1, 1, i * 1000))).len(),
            2
        );
    }

    #[test]
    fn sessions_objects_and_gaps_do_not_mix() {
        let mut sessions = engine();
        assert!(run(&mut sessions, (0..5).map(|i| url((i % 2) + 1, 1, i * 1000))).is_empty());
        let mut objects = engine();
        assert!(run(&mut objects, (0..5).map(|i| url(1, (i % 2) + 1, i * 1000))).is_empty());
        let mut spread = engine();
        assert!(run(&mut spread, (0..5).map(|i| url(1, 1, i * 60_000))).is_empty());
        let failed = EnvBuilder::new(Op::Other("download_url".into()), "photos/hero.png")
            .provider("firebase", "storage")
            .error("network");
        assert!(run(&mut engine(), [failed.build()]).is_empty());
    }
}
