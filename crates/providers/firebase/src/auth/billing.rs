//! Firebase Authentication billable units.
//!
//! Verified 2026-09-30 against
//! <https://firebase.google.com/pricing> and
//! <https://cloud.google.com/identity-platform/pricing>.
//!
//! Phone authentication bills one SMS per successful verification send
//! (`signInWithPhoneNumber`, `PhoneAuthProvider.verifyPhoneNumber`).
//! `ConfirmationResult.confirm` is a sign-in and does not send a second
//! SMS. Prices are per country in `pricing/firebase/auth.toml`. The
//! country is not on the envelope, so estimates use the default region.
//! The first 10 SMS per day are free; [`readmeter_cost`] does not apply
//! that allowance (marginal cost).
//!
//! Monthly active users are not a per-call charge. `sign_ins` and
//! `anonymous_sign_ins` are observations so a monthly estimate can be
//! made outside this table. They are unpriced. Anonymous success counts
//! only as `anonymous_sign_ins`. Every other successful sign-in, including
//! `createUserWithEmailAndPassword`, counts as `sign_ins`.
//!
//! Token refresh, sign-out, listeners, password reset, email verification,
//! and admin lookups (`verifyIdToken`, `getUser`, `listUsers`,
//! `createCustomToken`, `setCustomUserClaims`) have no priced unit.
//! Failed calls and results marked `from_cache` are unbilled.

use readmeter_core::{Envelope, Op, Units};

pub const SMS: &str = "sms";
pub const SIGN_INS: &str = "sign_ins";
pub const ANONYMOUS_SIGN_INS: &str = "anonymous_sign_ins";

pub fn units(env: &Envelope) -> Units {
    let mut u = Units::new();
    if env.outcome.is_error() || env.from_cache() {
        return u;
    }
    match &env.op {
        Op::Other(name) if name == "sign_in_anonymous" => u.add(ANONYMOUS_SIGN_INS, 1),
        Op::Other(name) if name == "sign_in" => u.add(SIGN_INS, 1),
        Op::Other(name) if name == "phone" => u.add(SMS, 1),
        _ => {}
    }
    u
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::EnvBuilder;

    use super::*;

    fn call(op: &str) -> EnvBuilder {
        EnvBuilder::new(Op::Other(op.into()), "auth/method").provider("firebase", "auth")
    }

    #[test]
    fn sign_ins_are_partitioned_and_sms_is_its_own_unit() {
        assert_eq!(
            units(&call("sign_in_anonymous").build()).get(ANONYMOUS_SIGN_INS),
            1
        );
        assert_eq!(units(&call("sign_in_anonymous").build()).get(SIGN_INS), 0);
        assert_eq!(units(&call("sign_in").build()).get(SIGN_INS), 1);
        assert_eq!(units(&call("sign_in").build()).get(ANONYMOUS_SIGN_INS), 0);
        assert_eq!(units(&call("phone").build()).get(SMS), 1);
        assert_eq!(units(&call("phone").build()).get(SIGN_INS), 0);
        assert!(units(&call("token_refresh").build()).is_empty());
        assert!(units(&call("list_users").build()).is_empty());
        assert!(units(&EnvBuilder::new(Op::Init, "auth/initializeAuth").build()).is_empty());
        assert!(
            units(&EnvBuilder::new(Op::Subscribe, "auth/onAuthStateChanged").build()).is_empty()
        );
    }

    #[test]
    fn failures_and_cache_are_free() {
        assert!(units(&call("phone").error("too-many-requests").build()).is_empty());
        assert!(units(&call("sign_in").cached().build()).is_empty());
        assert!(
            units(
                &call("sign_in_anonymous")
                    .error("network-request-failed")
                    .build()
            )
            .is_empty()
        );
    }
}
