//! Provider-agnostic detectors. Each file implements the rule with the same
//! name under `rules/generic/`.

use std::hash::{DefaultHasher, Hash, Hasher};

use readmeter_core::Envelope;

use crate::detector::Registry;

#[cfg(feature = "window")]
pub mod activity_while_hidden;
#[cfg(feature = "window")]
pub mod duplicate_read;
#[cfg(feature = "aggregate")]
pub mod hot_callsite;
#[cfg(feature = "window")]
pub mod listener_leak;
#[cfg(feature = "window")]
pub mod n_plus_one;
#[cfg(feature = "window")]
pub mod one_shot_subscription;
pub mod oversized_payload;
#[cfg(feature = "window")]
pub mod polling;
#[cfg(feature = "window")]
pub mod react_double_mount;
#[cfg(feature = "window")]
pub mod retry_storm;
#[cfg(feature = "window")]
pub mod subscription_churn;
#[cfg(feature = "window")]
pub mod unused_result;

pub fn register(r: &mut Registry) {
    #[cfg(feature = "window")]
    r.register(activity_while_hidden::ID, activity_while_hidden::build);
    #[cfg(feature = "window")]
    r.register(duplicate_read::ID, duplicate_read::build);
    #[cfg(feature = "aggregate")]
    r.register(hot_callsite::ID, hot_callsite::build);
    #[cfg(feature = "window")]
    r.register(listener_leak::ID, listener_leak::build);
    #[cfg(feature = "window")]
    r.register(n_plus_one::ID, n_plus_one::build);
    #[cfg(feature = "window")]
    r.register(one_shot_subscription::ID, one_shot_subscription::build);
    r.register(oversized_payload::ID, oversized_payload::build);
    #[cfg(feature = "window")]
    r.register(polling::ID, polling::build);
    #[cfg(feature = "window")]
    r.register(react_double_mount::ID, react_double_mount::build);
    #[cfg(feature = "window")]
    r.register(retry_storm::ID, retry_storm::build);
    #[cfg(feature = "window")]
    r.register(subscription_churn::ID, subscription_churn::build);
    #[cfg(feature = "window")]
    r.register(unused_result::ID, unused_result::build);
}

/// The call succeeded and was served by the backend, so it was billed.
pub fn billed(env: &Envelope) -> bool {
    !env.from_cache() && !env.outcome.is_error()
}

/// In-process hash for grouping keys. Not stable across processes; never
/// put it on the wire.
pub fn local_hash(v: impl Hash) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// Groups by callsite when known, else by template.
pub fn callsite_key(env: &Envelope) -> u64 {
    match env.ctx.callsite {
        Some(c) => local_hash((1u8, c)),
        None => local_hash((0u8, &env.target.template)),
    }
}
