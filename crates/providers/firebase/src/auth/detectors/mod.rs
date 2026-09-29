//! Authentication detectors. Each file implements the rule with the same
//! name under `rules/firebase/auth/`. Listener leaks reuse
//! `generic/listener-leak`; there is no auth-specific listener rule.

#[cfg(feature = "window")]
use readmeter_core::Envelope;
use readmeter_rules::DetectorFactory;

#[cfg(feature = "window")]
pub mod anonymous_user_churn;
#[cfg(feature = "window")]
pub mod id_token_refresh_storm;
pub mod memory_persistence;
#[cfg(feature = "window")]
pub mod phone_auth_retry;
#[cfg(feature = "window")]
pub mod server_list_users_in_request;

pub fn all() -> Vec<(&'static str, DetectorFactory)> {
    vec![
        #[cfg(feature = "window")]
        (anonymous_user_churn::ID, anonymous_user_churn::build),
        #[cfg(feature = "window")]
        (id_token_refresh_storm::ID, id_token_refresh_storm::build),
        (memory_persistence::ID, memory_persistence::build),
        #[cfg(feature = "window")]
        (phone_auth_retry::ID, phone_auth_retry::build),
        #[cfg(feature = "window")]
        (
            server_list_users_in_request::ID,
            server_list_users_in_request::build,
        ),
    ]
}

#[cfg(feature = "window")]
fn billed(env: &Envelope) -> bool {
    !env.from_cache() && !env.outcome.is_error()
}

#[cfg(feature = "window")]
fn named(env: &Envelope, name: &str) -> bool {
    matches!(&env.op, readmeter_core::Op::Other(got) if got == name)
}
