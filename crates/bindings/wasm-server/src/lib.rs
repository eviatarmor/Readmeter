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

use std::collections::BTreeMap;

use readmeter_cost::PriceTable;
use readmeter_evaluator::{Evaluator as Inner, Limits};
use readmeter_rules::{Bundle, Catalog, RuleOverride};
use serde::Serialize;
use wasm_bindgen::prelude::*;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}

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

/// Full rule catalog (definitions, params, docs, examples) compiled from
/// the rules directory TOML files, the same files `readmeter-rulec` reads.
#[wasm_bindgen]
pub fn catalog_json() -> Result<String, JsError> {
    catalog_json_inner().map_err(|e| JsError::new(&e))
}

/// Prices `units_json` (`{"reads": n, ...}`) with the embedded table for
/// `provider`/`service`. Unknown units are `0` micros and `"unknown": true`.
/// Money is integer USD micros. No price constants live in TypeScript.
#[wasm_bindgen]
pub fn price_json(units_json: &str, provider: &str, service: &str) -> Result<String, JsError> {
    price_json_inner(units_json, provider, service).map_err(|e| JsError::new(&e))
}

/// Decodes an SDK `bundle.bin`, merges project overrides, and re-encodes it.
/// `overrides_json` is a map of rule id to `{enabled?, severity?, params?}`.
#[wasm_bindgen]
pub fn bundle_with_overrides(bundle: &[u8], overrides_json: &str) -> Result<Vec<u8>, JsError> {
    bundle_with_overrides_inner(bundle, overrides_json).map_err(|e| JsError::new(&e))
}

fn catalog_json_inner() -> Result<String, String> {
    let catalog = load_catalog()?;
    serde_json::to_string(&catalog).map_err(|e| e.to_string())
}

fn load_catalog() -> Result<Catalog, String> {
    let mut rules = Vec::with_capacity(embedded::RULES.len());
    for file in embedded::RULES {
        rules.push(Catalog::parse_rule(file.path, file.text).map_err(|e| e.to_string())?);
    }
    rules.sort_by(|a, b| a.id.cmp(&b.id));
    Catalog::new(rules).map_err(|e| e.to_string())
}

fn load_prices() -> Result<Vec<PriceTable>, String> {
    embedded::PRICES
        .iter()
        .map(|file| PriceTable::from_toml(file.text).map_err(|e| format!("{}: {e}", file.path)))
        .collect()
}

#[derive(Serialize)]
struct PriceOut {
    currency: String,
    micros: i64,
    lines: Vec<PriceLine>,
}

#[derive(Serialize)]
struct PriceLine {
    unit: String,
    amount: u64,
    micros: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    unknown: Option<bool>,
}

fn price_json_inner(units_json: &str, provider: &str, service: &str) -> Result<String, String> {
    let units: BTreeMap<String, u64> =
        serde_json::from_str(units_json).map_err(|e| format!("units: {e}"))?;
    let tables = load_prices()?;
    let table = tables
        .iter()
        .find(|t| t.provider == provider && t.service == service);
    let mut lines = Vec::with_capacity(units.len());
    let mut total: i64 = 0;
    for (unit, amount) in units {
        let (micros, unknown) = match table.and_then(|t| price_unit(t, &unit, amount)) {
            Some(micros) => (micros, None),
            None => (0, Some(true)),
        };
        total = total.saturating_add(micros);
        lines.push(PriceLine {
            unit,
            amount,
            micros,
            unknown,
        });
    }
    let out = PriceOut {
        currency: table
            .map(|t| t.currency.clone())
            .unwrap_or_else(|| "USD".to_owned()),
        micros: total,
        lines,
    };
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Marginal price of `amount` of `unit` in the table's default region.
/// `None` when the table has no price for that unit.
fn price_unit(table: &PriceTable, unit: &str, amount: u64) -> Option<i64> {
    let region = table.regions.get(&table.default_region)?;
    let price = region.get(unit)?;
    Some(dollars_to_micros(price.of(amount)))
}

fn dollars_to_micros(dollars: f64) -> i64 {
    if !dollars.is_finite() || dollars <= 0.0 {
        return 0;
    }
    let micros = dollars * 1_000_000.0;
    if micros >= i64::MAX as f64 {
        i64::MAX
    } else {
        micros.round() as i64
    }
}

fn bundle_with_overrides_inner(bytes: &[u8], overrides_json: &str) -> Result<Vec<u8>, String> {
    let incoming: BTreeMap<String, RuleOverride> =
        serde_json::from_str(overrides_json).map_err(|e| format!("overrides: {e}"))?;
    // Re-encoding is not byte-identical. An empty override set keeps the
    // caller's bytes so the ETag of the default bundle stays stable.
    if incoming.is_empty() {
        return Ok(bytes.to_vec());
    }
    let mut bundle = Bundle::decode(bytes).map_err(|e| e.to_string())?;
    for (id, ov) in incoming {
        bundle.config.overrides.insert(id, ov);
    }
    bundle.encode().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Severity, VecMap};
    use readmeter_rules::{Evaluation, RuleSpec, Status};

    use super::*;

    #[test]
    fn catalog_includes_docs_params_and_examples() {
        let json = catalog_json_inner().unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let rules = v["rules"].as_array().unwrap();
        let rule = rules
            .iter()
            .find(|r| r["id"] == "firebase.firestore/unbounded-list")
            .unwrap();
        assert_eq!(rule["title"], "Query or listener without a limit");
        assert_eq!(rule["severity"], "critical");
        assert_eq!(rule["params"]["min_docs"], 100);
        assert!(!rule["examples"].as_array().unwrap().is_empty());
        assert!(rule["fix"].as_str().unwrap().contains("limit()"));
    }

    #[test]
    fn prices_known_units_and_marks_unknown() {
        // Firestore nam5: reads are $0.06 per 100_000 -> 60_000 micros.
        let json =
            price_json_inner(r#"{"reads":100000,"mystery":4}"#, "firebase", "firestore").unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["currency"], "USD");
        assert_eq!(v["micros"], 60_000);
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines[0]["unit"], "mystery");
        assert_eq!(lines[0]["amount"], 4);
        assert_eq!(lines[0]["micros"], 0);
        assert_eq!(lines[0]["unknown"], true);
        assert_eq!(lines[1]["unit"], "reads");
        assert_eq!(lines[1]["micros"], 60_000);
        assert!(lines[1].get("unknown").is_none());
    }

    #[test]
    fn missing_price_table_marks_every_unit_unknown() {
        let json = price_json_inner(r#"{"reads":10}"#, "other", "svc").unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["currency"], "USD");
        assert_eq!(v["micros"], 0);
        assert_eq!(v["lines"][0]["unknown"], true);
    }

    fn sample_bundle() -> Vec<u8> {
        let bundle = Bundle {
            revision: "test".into(),
            rules: vec![RuleSpec {
                id: "generic/example".into(),
                provider: "*".into(),
                service: "*".into(),
                severity: Severity::Medium,
                evaluation: Evaluation::Local,
                status: Status::Stable,
                default_enabled: true,
                params: VecMap::new(),
            }],
            config: readmeter_rules::RuleConfig::default(),
        };
        bundle.encode().unwrap()
    }

    #[test]
    fn overrides_change_the_bundle_and_empty_overrides_do_not() {
        let bytes = sample_bundle();
        let same = bundle_with_overrides_inner(&bytes, "{}").unwrap();
        assert_eq!(same, bytes);
        let changed = bundle_with_overrides_inner(
            &bytes,
            r#"{"generic/example":{"enabled":false,"severity":"low"}}"#,
        )
        .unwrap();
        assert_ne!(changed, bytes);
        let decoded = Bundle::decode(&changed).unwrap();
        let ov = decoded.config.overrides.get("generic/example").unwrap();
        assert_eq!(ov.enabled, Some(false));
        assert_eq!(ov.severity, Some(Severity::Low));
    }
}
