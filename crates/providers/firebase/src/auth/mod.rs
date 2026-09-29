//! Firebase Authentication.
//!
//! The target key hashes the method only. Force, persistence, and the
//! provider id ride on [`readmeter_core::QueryShape`] filters so they do
//! not change `target.key`. Emails, phone numbers, uids, and tokens are
//! dropped at this boundary.

pub mod billing;
pub mod detectors;
pub mod normalize;
pub mod raw;

mod error_codes;

pub use normalize::normalize;
pub use raw::RawCall;

pub const SERVICE_ID: &str = "auth";
