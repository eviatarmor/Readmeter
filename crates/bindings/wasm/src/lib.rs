//! JS-facing API. Kept string/bytes-only so the generated glue stays small.
//!
//! ```js
//! const rm = new Readmeter(JSON.stringify(config), bundle);
//! // `bundle` is the Uint8Array contents of bundle.bin
//! const findings = JSON.parse(rm.record(JSON.stringify(rawCall)));
//! const batch = rm.flush(Date.now()); // Uint8Array | undefined
//! ```

use readmeter_runtime::Client;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Readmeter(Client);

#[wasm_bindgen]
impl Readmeter {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, bundle: &[u8]) -> Result<Readmeter, JsError> {
        Client::from_bytes(config_json.as_bytes(), bundle)
            .map(Readmeter)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Records one raw call. Returns a JSON array of local findings.
    ///
    /// Each object has `rule`, `severity`, `template`, `message` and `wasted`
    /// (unit name to an integer). `evidence` is not included; it stays in the batch.
    pub fn record(&mut self, raw_json: &str) -> Result<String, JsError> {
        self.0
            .record_json(raw_json.as_bytes())
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Encoded batch to POST to ingest, or `undefined` when empty.
    pub fn flush(&mut self, now_ms: f64) -> Result<Option<Vec<u8>>, JsError> {
        let now = if now_ms.is_finite() && now_ms > 0.0 {
            now_ms as u64
        } else {
            0
        };
        self.0.flush(now).map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(js_name = activeRules)]
    pub fn active_rules(&self) -> Vec<String> {
        self.0.active_rules()
    }
}
