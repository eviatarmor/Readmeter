//! Cloud Functions for Firebase.
//!
//! The target key hashes the function name only. Cold start, memory, CPU,
//! and per-invocation call counts ride on query filters so they do not
//! change `target.key`. Payloads, URLs, and project ids are dropped here.

pub mod billing;
pub mod detectors;
pub mod normalize;
pub mod raw;

pub use normalize::normalize;
pub use raw::RawCall;

pub const SERVICE_ID: &str = "functions";
