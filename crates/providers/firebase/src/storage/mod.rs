//! Cloud Storage for Firebase.
//!
//! Object identity is the concrete path. Extension, content type, cache
//! control and the resumable flag ride on [`readmeter_core::QueryShape`]
//! filters so they do not change `target.key`.

pub mod billing;
pub mod detectors;
pub mod normalize;
pub mod raw;

pub use normalize::normalize;
pub use raw::RawCall;

pub const SERVICE_ID: &str = "storage";
