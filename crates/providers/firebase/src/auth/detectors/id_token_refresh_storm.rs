use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.auth/id-token-refresh-storm";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(IdTokenRefreshStorm {
        min_refreshes: p.u64("min_refreshes")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// `getIdToken(true)` many times in one session.
struct IdTokenRefreshStorm {
    min_refreshes: usize,
    window_ms: u64,
    window: KeyedWindow<u64, ()>,
}

impl Detector for IdTokenRefreshStorm {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "token_refresh") || !billed(env) {
            return;
        }
        let session = env.ctx.session;
        let refreshes = self.window.push(session, env.ts_ms, ()).len();
        if refreshes < self.min_refreshes {
            return;
        }
        self.window.remove(&session);
        out.emit(
            env,
            format!(
                "`{}` force-refreshed {refreshes} times in {}ms; refresh the ID token on demand",
                env.target.template, self.window_ms
            ),
        )
        .evidence("refreshes", refreshes)
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
            &[("min_refreshes", int(5)), ("window_ms", int(60_000))],
        )
    }

    fn refresh(session: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Other("token_refresh".into()), "auth/getIdToken")
            .provider("firebase", "auth")
            .session(session)
            .at(ts)
            .build()
    }

    #[test]
    fn flags_the_fifth_refresh_and_then_starts_over() {
        let mut quiet = engine();
        assert!(run(&mut quiet, (0..4).map(|i| refresh(1, i * 1000))).is_empty());
        let mut hot = engine();
        let findings = run(&mut hot, (0..5).map(|i| refresh(1, i * 1000)));
        assert_eq!(findings.len(), 1);
        assert!(findings[0].wasted.is_empty());
        let mut again = engine();
        assert_eq!(
            run(&mut again, (0..10).map(|i| refresh(1, i * 1000))).len(),
            2
        );
    }

    #[test]
    fn sessions_gaps_and_other_ops_do_not_mix() {
        let mut sessions = engine();
        assert!(
            run(
                &mut sessions,
                (0..5).map(|i| refresh((i % 2) + 1, i * 1000))
            )
            .is_empty()
        );
        let mut spread = engine();
        assert!(run(&mut spread, (0..5).map(|i| refresh(1, i * 60_000))).is_empty());
        let sign_in = EnvBuilder::new(Op::Other("sign_in".into()), "auth/signInWithPassword")
            .provider("firebase", "auth");
        let failed = EnvBuilder::new(Op::Other("token_refresh".into()), "auth/getIdToken")
            .provider("firebase", "auth")
            .error("network-request-failed");
        assert!(run(&mut engine(), [sign_in.build(), failed.build()]).is_empty());
    }
}
