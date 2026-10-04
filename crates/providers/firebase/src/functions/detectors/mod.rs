//! Cloud Functions detectors. Each file implements the rule with the same
//! name under `rules/firebase/functions/`. Callable retry storms reuse
//! `generic/retry-storm`.

use readmeter_core::{Envelope, Op};
use readmeter_rules::DetectorFactory;

#[cfg(feature = "window")]
pub mod callable_in_loop;
#[cfg(feature = "window")]
pub mod cold_start_heavy;
pub mod large_callable_payload;
#[cfg(feature = "window")]
pub mod reads_per_invocation;
pub mod trigger_cascade;

pub fn all() -> Vec<(&'static str, DetectorFactory)> {
    vec![
        #[cfg(feature = "window")]
        (callable_in_loop::ID, callable_in_loop::build),
        #[cfg(feature = "window")]
        (cold_start_heavy::ID, cold_start_heavy::build),
        (large_callable_payload::ID, large_callable_payload::build),
        #[cfg(feature = "window")]
        (reads_per_invocation::ID, reads_per_invocation::build),
        (trigger_cascade::ID, trigger_cascade::build),
    ]
}

fn named(env: &Envelope, name: &str) -> bool {
    matches!(&env.op, Op::Other(got) if got == name)
}
