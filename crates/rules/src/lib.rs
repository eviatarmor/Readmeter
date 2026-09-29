//! Rule model and evaluation engine.
//!
//! A rule has two halves:
//! - a **definition** (`rules/**/*.toml`): id, severity, docs, default params.
//!   This is data and can change without an SDK release.
//! - a **detector**: Rust code registered under the rule id that inspects
//!   envelopes. Generic detectors live in [`detectors`]; provider-specific
//!   detectors live in the provider crate and are registered through the
//!   provider.

pub mod catalog;
pub mod config;
pub mod def;
pub mod detector;
pub mod detectors;
pub mod engine;
pub mod window;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use catalog::{BUNDLE_VERSION, Bundle, BundleError, Catalog, CatalogError};
pub use config::{ParamError, Params, ResolvedRule, RuleConfig, RuleOverride};
pub use def::{Category, Evaluation, Example, ParamValue, RuleDef, RuleSpec, Status};
pub use detector::{Detector, DetectorFactory, Emitter, Registry};
pub use engine::{Engine, EngineError};
