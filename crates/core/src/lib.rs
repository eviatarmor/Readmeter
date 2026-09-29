//! Provider-agnostic data model shared by every Readmeter component.
//!
//! Nothing in this crate knows about Firebase, Supabase or any other provider.
//! Providers translate their raw calls into an [`Envelope`]; rules consume
//! envelopes and produce [`Finding`]s; the [`Buffer`] batches both for the
//! wire.

pub mod buffer;
pub mod envelope;
pub mod finding;
pub mod hash;
pub mod map;
pub mod units;
pub mod wire;

pub use buffer::{Buffer, BufferConfig, Sampler};
pub use envelope::{
    CacheKind, CallContext, ClientSetup, Envelope, FilterShape, IdShape, Op, OrderShape, Outcome,
    Platform, QueryShape, ReadSource, ResultStats, ResultUsage, SCHEMA_VERSION, Target, WriteStats,
};
pub use finding::{Finding, Scalar, Severity};
pub use hash::{HashBuilder, KeyedHasher};
pub use map::VecMap;
pub use units::Units;
pub use wire::{Batch, SdkInfo, WireError};
