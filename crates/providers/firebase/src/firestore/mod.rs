//! Cloud Firestore.

pub mod billing;
pub mod detectors;
pub mod normalize;
pub mod raw;

pub use normalize::normalize;
pub use raw::RawCall;

pub const SERVICE_ID: &str = "firestore";
