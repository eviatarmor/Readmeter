//! Pricing. Backend/tooling only; SDKs never price anything.
//!
//! Tables live in `pricing/<provider>/<service>.toml`. Prices change, so
//! every table records its source and the date it was last checked.

use std::collections::BTreeMap;

use readmeter_core::Units;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PriceTable {
    pub provider: String,
    pub service: String,
    pub currency: String,
    /// Where the numbers come from.
    pub source: String,
    /// `YYYY-MM-DD` the table was last checked against `source`.
    pub checked_on: String,
    /// Region used when the project's region is unknown.
    pub default_region: String,
    pub regions: BTreeMap<String, BTreeMap<String, UnitPrice>>,
    /// Daily free quota per unit, if any.
    #[serde(default)]
    pub free_per_day: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitPrice {
    /// Price of `per` units.
    pub price: f64,
    pub per: u64,
}

impl UnitPrice {
    pub fn of(&self, amount: u64) -> f64 {
        if self.per == 0 {
            return 0.0;
        }
        self.price * amount as f64 / self.per as f64
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PricingError {
    #[error("pricing TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("default region `{0}` missing from regions")]
    MissingDefaultRegion(String),
}

/// Cost of a set of units, with units that have no price listed separately
/// so callers can tell "free" from "unknown".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Estimate {
    pub total: f64,
    pub by_unit: BTreeMap<String, f64>,
    pub unpriced: Vec<String>,
}

impl PriceTable {
    pub fn from_toml(text: &str) -> Result<Self, PricingError> {
        let table: Self = toml::from_str(text)?;
        if !table.regions.contains_key(&table.default_region) {
            return Err(PricingError::MissingDefaultRegion(table.default_region));
        }
        Ok(table)
    }

    /// Prices units in `region`, falling back to the default region.
    /// Free tier is not applied: this is the marginal cost of the units.
    pub fn estimate(&self, units: &Units, region: Option<&str>) -> Estimate {
        let prices = region
            .and_then(|r| self.regions.get(r))
            .or_else(|| self.regions.get(&self.default_region));
        let mut est = Estimate::default();
        for (unit, amount) in units.iter() {
            match prices.and_then(|p| p.get(unit)) {
                Some(price) => {
                    let cost = price.of(amount);
                    est.total += cost;
                    est.by_unit.insert(unit.to_owned(), cost);
                }
                None => est.unpriced.push(unit.to_owned()),
            }
        }
        est
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = r#"
provider = "firebase"
service = "firestore"
currency = "USD"
source = "test"
checked_on = "2026-01-01"
default_region = "a"

[regions.a]
reads = { price = 0.06, per = 100000 }

[regions.b]
reads = { price = 0.03, per = 100000 }
"#;

    #[test]
    fn estimates_with_region_fallback() {
        let t = PriceTable::from_toml(TABLE).unwrap();
        let u = Units::new().with("reads", 1_000_000).with("mystery", 1);
        let a = t.estimate(&u, None);
        assert!((a.total - 0.6).abs() < 1e-9);
        assert_eq!(a.unpriced, ["mystery"]);
        let b = t.estimate(&u, Some("b"));
        assert!((b.total - 0.3).abs() < 1e-9);
        let fallback = t.estimate(&u, Some("zz"));
        assert!((fallback.total - 0.6).abs() < 1e-9);
    }

    #[test]
    fn repository_tables_parse() {
        let t = PriceTable::from_toml(include_str!("../../../pricing/firebase/firestore.toml"))
            .unwrap();
        assert_eq!(
            (t.provider.as_str(), t.service.as_str()),
            ("firebase", "firestore")
        );
        let db =
            PriceTable::from_toml(include_str!("../../../pricing/firebase/database.toml")).unwrap();
        assert_eq!(
            (db.provider.as_str(), db.service.as_str()),
            ("firebase", "database")
        );
        let storage =
            PriceTable::from_toml(include_str!("../../../pricing/firebase/storage.toml")).unwrap();
        assert_eq!(
            (storage.provider.as_str(), storage.service.as_str()),
            ("firebase", "storage")
        );
        assert_eq!(storage.checked_on, "2026-09-30");
    }

    #[test]
    fn rejects_missing_default_region() {
        let bad = TABLE.replace("default_region = \"a\"", "default_region = \"x\"");
        assert!(PriceTable::from_toml(&bad).is_err());
    }
}
