use serde::{Deserialize, Serialize};

use crate::map::VecMap;

/// Billable unit counts keyed by provider-defined unit name
/// (e.g. `reads`, `writes`, `egress_bytes`). Pricing lives elsewhere.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Units(VecMap<u64>);

impl Units {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, unit: &str, amount: u64) -> Self {
        self.add(unit, amount);
        self
    }

    pub fn add(&mut self, unit: &str, amount: u64) {
        if amount == 0 {
            return;
        }
        match self.0.get_mut(unit) {
            Some(slot) => *slot = slot.saturating_add(amount),
            None => {
                self.0.insert(unit, amount);
            }
        }
    }

    pub fn merge(&mut self, other: &Units) {
        for (unit, amount) in other.0.iter() {
            self.add(unit, *amount);
        }
    }

    pub fn get(&self, unit: &str) -> u64 {
        self.0.get(unit).copied().unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, u64)> {
        self.0.iter().map(|(k, v)| (k, *v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_amounts_are_not_stored() {
        let u = Units::new().with("reads", 0);
        assert!(u.is_empty());
    }

    #[test]
    fn merge_adds_and_saturates() {
        let mut a = Units::new().with("reads", u64::MAX - 1);
        a.merge(&Units::new().with("reads", 5).with("writes", 2));
        assert_eq!(a.get("reads"), u64::MAX);
        assert_eq!(a.get("writes"), 2);
    }
}
