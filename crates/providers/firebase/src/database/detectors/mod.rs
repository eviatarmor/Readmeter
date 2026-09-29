//! Realtime Database detectors. Each file implements the rule with the same
//! name under `rules/firebase/database/`.

use readmeter_core::Envelope;
use readmeter_rules::DetectorFactory;

pub mod download_whole_list;
#[cfg(feature = "window")]
pub mod duplicate_listeners;
pub mod listen_on_root;
#[cfg(feature = "window")]
pub mod rtdb_write_hotspot;
#[cfg(feature = "window")]
pub mod value_listener_on_list;

pub fn all() -> Vec<(&'static str, DetectorFactory)> {
    vec![
        (download_whole_list::ID, download_whole_list::build),
        #[cfg(feature = "window")]
        (duplicate_listeners::ID, duplicate_listeners::build),
        (listen_on_root::ID, listen_on_root::build),
        #[cfg(feature = "window")]
        (rtdb_write_hotspot::ID, rtdb_write_hotspot::build),
        #[cfg(feature = "window")]
        (value_listener_on_list::ID, value_listener_on_list::build),
    ]
}

fn billed(env: &Envelope) -> bool {
    !env.from_cache() && !env.outcome.is_error()
}
