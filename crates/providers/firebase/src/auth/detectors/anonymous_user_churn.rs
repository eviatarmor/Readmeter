use std::collections::HashMap;

use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use super::named;

pub const ID: &str = "firebase.auth/anonymous-user-churn";

/// Hard cap on sessions remembered. State resets past it.
const MAX_TRACKED: usize = 16_384;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(AnonymousUserChurn {
        min_sign_ins: p.u64("min_sign_ins")?.max(1),
        counts: HashMap::new(),
    }))
}

#[derive(Default)]
struct SessionCount {
    n: u64,
    fired: bool,
}

/// Successful `signInAnonymously` calls in one session, with no time window.
/// A new page load is a new session, so "every load without persistence" is
/// `memory-persistence`, not a second condition here.
struct AnonymousUserChurn {
    min_sign_ins: u64,
    counts: HashMap<u64, SessionCount>,
}

impl Detector for AnonymousUserChurn {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "sign_in_anonymous") || !billed(env) {
            return;
        }
        let session = env.ctx.session;
        if self.counts.len() >= MAX_TRACKED && !self.counts.contains_key(&session) {
            self.counts.clear();
        }
        let entry = self.counts.entry(session).or_default();
        if entry.fired {
            return;
        }
        entry.n = entry.n.saturating_add(1);
        if entry.n < self.min_sign_ins {
            return;
        }
        let count = entry.n;
        entry.fired = true;
        let wasted = count.saturating_sub(1);
        let finding = out
            .emit(
                env,
                format!(
                    "`{}` signed in anonymously {count} times in this session; keep one anonymous user",
                    env.target.template
                ),
            )
            .evidence("sign_ins", count);
        if wasted > 0 {
            finding.wasted("anonymous_sign_ins", wasted);
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_sign_ins", int(2))])
    }

    fn anon(session: u64, ts: u64) -> Envelope {
        EnvBuilder::new(
            Op::Other("sign_in_anonymous".into()),
            "auth/signInAnonymously",
        )
        .provider("firebase", "auth")
        .session(session)
        .at(ts)
        .build()
    }

    #[test]
    fn flags_the_second_sign_in_once_per_session() {
        let mut once = engine();
        assert!(run(&mut once, [anon(1, 1)]).is_empty());
        let mut twice = engine();
        let findings = run(&mut twice, [anon(1, 1), anon(1, 50_000), anon(1, 90_000)]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].wasted.get("anonymous_sign_ins"), 1);
    }

    #[test]
    fn sessions_and_password_sign_ins_do_not_mix() {
        let mut sessions = engine();
        assert!(run(&mut sessions, [anon(1, 1), anon(2, 2)]).is_empty());
        let password = || {
            EnvBuilder::new(Op::Other("sign_in".into()), "auth/signInWithPassword")
                .provider("firebase", "auth")
        };
        let failed = EnvBuilder::new(
            Op::Other("sign_in_anonymous".into()),
            "auth/signInAnonymously",
        )
        .provider("firebase", "auth")
        .error("operation-not-allowed");
        assert!(
            run(
                &mut engine(),
                [password().build(), password().build(), failed.build()]
            )
            .is_empty()
        );
    }
}
