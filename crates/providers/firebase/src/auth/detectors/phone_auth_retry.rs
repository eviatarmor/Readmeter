use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.auth/phone-auth-retry";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(PhoneAuthRetry {
        min_sends: p.u64("min_sends")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Phone verification SMS sent again and again in one session.
struct PhoneAuthRetry {
    min_sends: usize,
    window_ms: u64,
    window: KeyedWindow<u64, ()>,
}

impl Detector for PhoneAuthRetry {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "phone") || !billed(env) {
            return;
        }
        let session = env.ctx.session;
        let sends = self.window.push(session, env.ts_ms, ()).len();
        if sends < self.min_sends {
            return;
        }
        self.window.remove(&session);
        let wasted = (sends as u64).saturating_sub(1);
        let finding = out
            .emit(
                env,
                format!(
                    "`{}` sent {sends} verification SMS in {}ms; wait before sending another code",
                    env.target.template, self.window_ms
                ),
            )
            .evidence("sends", sends)
            .evidence("window_ms", self.window_ms);
        if wasted > 0 {
            finding.wasted("sms", wasted);
        }
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
            &[("min_sends", int(3)), ("window_ms", int(600_000))],
        )
    }

    fn send(session: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Other("phone".into()), "auth/signInWithPhoneNumber")
            .provider("firebase", "auth")
            .session(session)
            .at(ts)
            .build()
    }

    #[test]
    fn flags_the_third_send_and_wastes_the_retries() {
        let mut quiet = engine();
        assert!(run(&mut quiet, (0..2).map(|i| send(1, i * 1000))).is_empty());
        let mut hot = engine();
        let findings = run(&mut hot, (0..3).map(|i| send(1, i * 1000)));
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].wasted.get("sms"), 2);
    }

    #[test]
    fn sessions_gaps_and_failures_do_not_mix() {
        let mut sessions = engine();
        assert!(run(&mut sessions, (0..3).map(|i| send((i % 2) + 1, i * 1000))).is_empty());
        let mut spread = engine();
        assert!(run(&mut spread, (0..3).map(|i| send(1, i * 600_000))).is_empty());
        let failed = EnvBuilder::new(Op::Other("phone".into()), "auth/signInWithPhoneNumber")
            .provider("firebase", "auth")
            .error("too-many-requests");
        assert!(run(&mut engine(), [failed.build(), send(1, 0), send(1, 1)]).is_empty());
    }
}
