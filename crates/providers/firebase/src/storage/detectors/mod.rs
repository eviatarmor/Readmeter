//! Cloud Storage detectors. Each file implements the rule with the same
//! name under `rules/firebase/storage/`.

use readmeter_core::Envelope;
use readmeter_rules::DetectorFactory;

#[cfg(feature = "window")]
pub mod download_url_per_render;
pub mod list_all_large_prefix;
pub mod original_size_images;
#[cfg(feature = "window")]
pub mod redownload_without_cache_control;
pub mod unbounded_list_page;
pub mod upload_without_resumable;

pub fn all() -> Vec<(&'static str, DetectorFactory)> {
    vec![
        #[cfg(feature = "window")]
        (download_url_per_render::ID, download_url_per_render::build),
        (list_all_large_prefix::ID, list_all_large_prefix::build),
        (original_size_images::ID, original_size_images::build),
        #[cfg(feature = "window")]
        (
            redownload_without_cache_control::ID,
            redownload_without_cache_control::build,
        ),
        (unbounded_list_page::ID, unbounded_list_page::build),
        (
            upload_without_resumable::ID,
            upload_without_resumable::build,
        ),
    ]
}

fn billed(env: &Envelope) -> bool {
    !env.from_cache() && !env.outcome.is_error()
}

fn named(env: &Envelope, name: &str) -> bool {
    matches!(&env.op, readmeter_core::Op::Other(got) if got == name)
}

fn attr<'a>(env: &'a Envelope, field: &str) -> Option<&'a str> {
    env.query.as_ref().and_then(|q| {
        q.filters
            .iter()
            .find(|f| f.field == field)
            .map(|f| f.op.as_str())
    })
}
