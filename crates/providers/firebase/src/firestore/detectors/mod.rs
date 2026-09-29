//! Firestore-specific detectors. Each file implements the rule with the same
//! name under `rules/firebase/firestore/`.

use readmeter_core::Envelope;
use readmeter_rules::DetectorFactory;

pub mod blob_in_document;
#[cfg(feature = "window")]
pub mod client_side_bulk_delete;
#[cfg(feature = "window")]
pub mod count_then_fetch;
#[cfg(feature = "window")]
pub mod count_via_fetch;
#[cfg(feature = "window")]
pub mod emptiness_check_without_limit;
pub mod expensive_aggregation;
pub mod fanout_writes;
#[cfg(feature = "window")]
pub mod force_server_read;
#[cfg(feature = "window")]
pub mod get_then_listen;
#[cfg(feature = "window")]
pub mod get_while_listening;
#[cfg(feature = "window")]
pub mod growing_document;
#[cfg(feature = "window")]
pub mod hot_listener;
#[cfg(feature = "window")]
pub mod initial_load_fanout;
pub mod large_docs_in_list;
pub mod large_listener_result;
#[cfg(feature = "window")]
pub mod listener_per_item;
#[cfg(feature = "window")]
pub mod manual_ttl_cleanup;
#[cfg(feature = "window")]
pub mod missing_cursor;
#[cfg(feature = "window")]
pub mod monotonic_document_ids;
pub mod multi_tab_without_shared_cache;
#[cfg(feature = "window")]
pub mod no_op_write;
pub mod offset_pagination;
#[cfg(feature = "window")]
pub mod overfetch;
pub mod oversized_limit;
pub mod persistence_disabled;
#[cfg(feature = "window")]
pub mod polled_aggregation;
#[cfg(feature = "window")]
pub mod query_per_keystroke;
#[cfg(feature = "window")]
pub mod read_after_write;
#[cfg(feature = "window")]
pub mod read_modify_write_counter;
#[cfg(feature = "window")]
pub mod tiny_batches;
pub mod transaction_contention;
pub mod unbounded_list;
pub mod unused_projection;
#[cfg(feature = "window")]
pub mod write_hotspot;
#[cfg(feature = "window")]
pub mod write_per_keystroke;

pub fn all() -> Vec<(&'static str, DetectorFactory)> {
    vec![
        (blob_in_document::ID, blob_in_document::build),
        #[cfg(feature = "window")]
        (client_side_bulk_delete::ID, client_side_bulk_delete::build),
        #[cfg(feature = "window")]
        (count_then_fetch::ID, count_then_fetch::build),
        #[cfg(feature = "window")]
        (count_via_fetch::ID, count_via_fetch::build),
        #[cfg(feature = "window")]
        (
            emptiness_check_without_limit::ID,
            emptiness_check_without_limit::build,
        ),
        (expensive_aggregation::ID, expensive_aggregation::build),
        (fanout_writes::ID, fanout_writes::build),
        #[cfg(feature = "window")]
        (force_server_read::ID, force_server_read::build),
        #[cfg(feature = "window")]
        (get_then_listen::ID, get_then_listen::build),
        #[cfg(feature = "window")]
        (get_while_listening::ID, get_while_listening::build),
        #[cfg(feature = "window")]
        (growing_document::ID, growing_document::build),
        #[cfg(feature = "window")]
        (hot_listener::ID, hot_listener::build),
        #[cfg(feature = "window")]
        (initial_load_fanout::ID, initial_load_fanout::build),
        (large_docs_in_list::ID, large_docs_in_list::build),
        (large_listener_result::ID, large_listener_result::build),
        #[cfg(feature = "window")]
        (listener_per_item::ID, listener_per_item::build),
        #[cfg(feature = "window")]
        (manual_ttl_cleanup::ID, manual_ttl_cleanup::build),
        #[cfg(feature = "window")]
        (missing_cursor::ID, missing_cursor::build),
        #[cfg(feature = "window")]
        (monotonic_document_ids::ID, monotonic_document_ids::build),
        (
            multi_tab_without_shared_cache::ID,
            multi_tab_without_shared_cache::build,
        ),
        #[cfg(feature = "window")]
        (no_op_write::ID, no_op_write::build),
        (offset_pagination::ID, offset_pagination::build),
        (oversized_limit::ID, oversized_limit::build),
        #[cfg(feature = "window")]
        (overfetch::ID, overfetch::build),
        (persistence_disabled::ID, persistence_disabled::build),
        #[cfg(feature = "window")]
        (polled_aggregation::ID, polled_aggregation::build),
        #[cfg(feature = "window")]
        (query_per_keystroke::ID, query_per_keystroke::build),
        #[cfg(feature = "window")]
        (read_after_write::ID, read_after_write::build),
        #[cfg(feature = "window")]
        (
            read_modify_write_counter::ID,
            read_modify_write_counter::build,
        ),
        #[cfg(feature = "window")]
        (tiny_batches::ID, tiny_batches::build),
        (transaction_contention::ID, transaction_contention::build),
        (unbounded_list::ID, unbounded_list::build),
        (unused_projection::ID, unused_projection::build),
        #[cfg(feature = "window")]
        (write_hotspot::ID, write_hotspot::build),
        #[cfg(feature = "window")]
        (write_per_keystroke::ID, write_per_keystroke::build),
    ]
}

fn billed(env: &Envelope) -> bool {
    !env.from_cache() && !env.outcome.is_error()
}
