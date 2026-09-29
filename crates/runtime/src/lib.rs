//! The in-process Readmeter client.
//!
//! Every SDK binding (wasm, C ABI, PyO3, ...) wraps exactly this type, so all
//! languages share one implementation of redaction, rules and batching. The
//! host is responsible only for intercepting calls, building raw-call JSON,
//! and POSTing the bytes returned by [`Client::flush`].

use readmeter_core::{Batch, Buffer, BufferConfig, Finding, KeyedHasher, Sampler, SdkInfo};
use readmeter_provider_api::json::{self, JsonError};
use readmeter_provider_api::{NormalizeContext, NormalizeError, Provider};
use readmeter_rules::{Bundle, BundleError, CatalogError, Engine, EngineError, Registry};

pub mod config;
mod findings_json;
mod page;

pub use config::ClientConfig;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("invalid config: {0}")]
    Config(String),
    #[error("provider `{0}` is not compiled into this build")]
    UnknownProvider(String),
    #[error(transparent)]
    Bundle(#[from] BundleError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Normalize(#[from] NormalizeError),
    #[error("encode: {0}")]
    Encode(#[from] readmeter_core::WireError),
    #[error("json: {0}")]
    Json(#[from] JsonError),
}

pub struct Client {
    provider: Box<dyn Provider>,
    engine: Engine,
    buffer: Buffer,
    cx: NormalizeContext,
    sdk: SdkInfo,
    /// Session is sampled in: events are uploaded. Findings always are.
    sampled: bool,
}

impl Client {
    pub fn new(
        config: ClientConfig,
        provider: Box<dyn Provider>,
        bundle: &Bundle,
    ) -> Result<Self, ClientError> {
        bundle.validate()?;
        let mut registry = Registry::with_generic();
        registry.extend(provider.detectors());
        let engine = Engine::build(
            &bundle.rules,
            &bundle.config,
            &registry,
            &config.evaluations,
        )?;
        let (k0, k1) = config.hash_key()?;
        Ok(Self {
            provider,
            engine,
            buffer: Buffer::new(BufferConfig {
                max_events: config.max_events,
                max_findings: config.max_findings,
            }),
            cx: NormalizeContext {
                hasher: KeyedHasher::new(k0, k1),
                session: config.session,
                platform: config.platform,
                dev: config.dev,
            },
            sdk: config.sdk,
            sampled: Sampler::new(config.sample_rate).keep(config.session),
        })
    }

    /// Builds a client from JSON config and a binary rule bundle (`bundle.bin`),
    /// picking the provider by `config.provider`. This is the entry point bindings use.
    pub fn from_bytes(config_json: &[u8], bundle: &[u8]) -> Result<Self, ClientError> {
        let config = ClientConfig::from_json(&json::parse(config_json)?)?;
        let bundle = Bundle::decode(bundle)?;
        let provider = provider_by_id(&config.provider)
            .ok_or_else(|| ClientError::UnknownProvider(config.provider.clone()))?;
        Self::new(config, provider, &bundle)
    }

    /// Records one raw call. Returns findings from local rules so the host
    /// can surface them (e.g. `console.warn` in dev).
    pub fn record(&mut self, raw_json: &[u8]) -> Result<Vec<Finding>, ClientError> {
        let value = json::parse(raw_json)?;
        // Page visibility is host state, not a provider call. It is recognized
        // here so providers stay free of it.
        let env = if page::is_page(&value) {
            page::normalize(&value, &self.cx)?
        } else {
            self.provider.normalize_value(&value, &self.cx)?
        };
        let findings = self.engine.observe(&env);
        if self.sampled {
            self.buffer.push_event(env);
        }
        for f in &findings {
            self.buffer.push_finding(f.clone());
        }
        Ok(findings)
    }

    /// Same as [`Client::record`], but returns findings as a JSON array.
    ///
    /// Each object has exactly `rule`, `severity`, `template`, `message` and
    /// `wasted` (unit name to an integer). `evidence` is not included; it is
    /// still stored in the batch.
    pub fn record_json(&mut self, raw_json: &[u8]) -> Result<String, ClientError> {
        Ok(findings_json::findings_json(&self.record(raw_json)?))
    }

    /// Drains the buffer into an encoded batch, or `None` when empty.
    pub fn flush(&mut self, now_ms: u64) -> Result<Option<Vec<u8>>, ClientError> {
        match self.drain(now_ms) {
            Some(batch) => Ok(Some(batch.encode()?)),
            None => Ok(None),
        }
    }

    pub fn drain(&mut self, now_ms: u64) -> Option<Batch> {
        self.buffer.drain(&self.sdk, self.cx.session, now_ms)
    }

    pub fn active_rules(&self) -> Vec<String> {
        self.engine.active().map(str::to_owned).collect()
    }

    /// Enabled rules this build cannot evaluate (no detector linked in).
    pub fn unavailable_rules(&self) -> &[String] {
        self.engine.unavailable()
    }
}

/// Providers compiled into this build.
pub fn provider_by_id(id: &str) -> Option<Box<dyn Provider>> {
    match id {
        #[cfg(feature = "firebase")]
        readmeter_provider_firebase::PROVIDER_ID => {
            Some(Box::new(readmeter_provider_firebase::FirebaseProvider))
        }
        _ => None,
    }
}
