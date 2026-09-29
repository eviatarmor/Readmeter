//! Server-side core for the TypeScript backend. Not shipped to customers,
//! so size is not a concern here; the SDK artifact is `bindings/wasm`.
//!
//! ```js
//! const ev = new Evaluator(bundleJson, 10000, 1000);
//! try {
//!   const { batch, events, findings } = JSON.parse(ev.ingest(projectId, body));
//! } catch (e) {
//!   // e.message is "<code>: <detail>", code in bad_batch | batch_too_large | internal
//! }
//! ```

use readmeter_evaluator::{Evaluator as Inner, Limits};
use readmeter_rules::Bundle;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Evaluator {
    inner: Inner,
    limits: Limits,
}

#[wasm_bindgen]
impl Evaluator {
    #[wasm_bindgen(constructor)]
    pub fn new(
        bundle_json: &str,
        max_events: u32,
        max_findings: u32,
    ) -> Result<Evaluator, JsError> {
        let bundle: Bundle =
            serde_json::from_str(bundle_json).map_err(|e| JsError::new(&format!("bundle: {e}")))?;
        let inner = Inner::with_all_providers(bundle).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Evaluator {
            inner,
            limits: Limits {
                max_events: max_events as usize,
                max_findings: max_findings as usize,
            },
        })
    }

    /// Decodes one SDK batch, runs window rules for `project` and returns
    /// `{batch, events, findings}` as JSON. Hashes are 16-char hex strings.
    pub fn ingest(&mut self, project: &str, body: &[u8]) -> Result<String, JsError> {
        let out = self
            .inner
            .ingest(project, body, self.limits)
            .map_err(|e| JsError::new(&format!("{}: {e}", e.code())))?;
        serde_json::to_string(&out).map_err(|e| JsError::new(&format!("internal: {e}")))
    }

    /// Projects with detector state in memory.
    pub fn projects(&self) -> u32 {
        u32::try_from(self.inner.projects()).unwrap_or(u32::MAX)
    }
}
