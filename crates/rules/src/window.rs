//! Bounded state helpers for windowed detectors.
//!
//! Detectors run inside customer processes, so every map must have a hard
//! size cap. When a cap is hit, stale entries are evicted first; if that is
//! not enough, the whole map is reset. Losing state only means a missed
//! finding, never a crash or unbounded memory.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

/// Default key cap per detector map.
pub const DEFAULT_MAX_KEYS: usize = 4_096;
/// Default per-key sample cap.
pub const DEFAULT_MAX_SAMPLES: usize = 256;

/// Per-key sliding window of timestamped samples.
#[derive(Debug)]
pub struct KeyedWindow<K, V> {
    span_ms: u64,
    max_keys: usize,
    max_samples: usize,
    map: HashMap<K, VecDeque<(u64, V)>>,
}

impl<K: Eq + Hash + Clone, V> KeyedWindow<K, V> {
    pub fn new(span_ms: u64) -> Self {
        Self::with_caps(span_ms, DEFAULT_MAX_KEYS, DEFAULT_MAX_SAMPLES)
    }

    pub fn with_caps(span_ms: u64, max_keys: usize, max_samples: usize) -> Self {
        Self {
            span_ms,
            max_keys: max_keys.max(1),
            max_samples: max_samples.max(1),
            map: HashMap::new(),
        }
    }

    /// Adds a sample and returns the key's window (oldest first), pruned to
    /// `span_ms` before `ts_ms`.
    pub fn push(&mut self, key: K, ts_ms: u64, value: V) -> &mut VecDeque<(u64, V)> {
        if !self.map.contains_key(&key) && self.map.len() >= self.max_keys {
            self.evict(ts_ms);
        }
        let span = self.span_ms;
        let max_samples = self.max_samples;
        let samples = self.map.entry(key).or_default();
        let cutoff = ts_ms.saturating_sub(span);
        while samples.front().is_some_and(|(t, _)| *t < cutoff) {
            samples.pop_front();
        }
        if samples.len() >= max_samples {
            samples.pop_front();
        }
        samples.push_back((ts_ms, value));
        samples
    }

    pub fn remove(&mut self, key: &K) {
        self.map.remove(key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn evict(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(self.span_ms);
        self.map
            .retain(|_, s| s.back().is_some_and(|(t, _)| *t >= cutoff));
        if self.map.len() >= self.max_keys {
            self.map.clear();
        }
    }
}

/// Map with a hard size cap and timestamp-based eviction.
#[derive(Debug)]
pub struct BoundedMap<K, V> {
    ttl_ms: u64,
    max_keys: usize,
    map: HashMap<K, (u64, V)>,
}

impl<K: Eq + Hash, V> BoundedMap<K, V> {
    pub fn new(ttl_ms: u64) -> Self {
        Self::with_cap(ttl_ms, DEFAULT_MAX_KEYS)
    }

    pub fn with_cap(ttl_ms: u64, max_keys: usize) -> Self {
        Self {
            ttl_ms,
            max_keys: max_keys.max(1),
            map: HashMap::new(),
        }
    }

    pub fn insert(&mut self, key: K, ts_ms: u64, value: V) {
        if !self.map.contains_key(&key) && self.map.len() >= self.max_keys {
            let cutoff = ts_ms.saturating_sub(self.ttl_ms);
            self.map.retain(|_, (t, _)| *t >= cutoff);
            if self.map.len() >= self.max_keys {
                self.map.clear();
            }
        }
        self.map.insert(key, (ts_ms, value));
    }

    /// Returns the value if it is younger than the TTL at `now_ms`.
    pub fn get(&self, key: &K, now_ms: u64) -> Option<&V> {
        self.map
            .get(key)
            .filter(|(t, _)| now_ms.saturating_sub(*t) <= self.ttl_ms)
            .map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &K, now_ms: u64) -> Option<&mut V> {
        let ttl = self.ttl_ms;
        self.map
            .get_mut(key)
            .filter(|(t, _)| now_ms.saturating_sub(*t) <= ttl)
            .map(|(_, v)| v)
    }

    pub fn remove(&mut self, key: &K) -> Option<(u64, V)> {
        self.map.remove(key)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.map.values().map(|(_, v)| v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_prunes_by_span_and_caps_samples() {
        let mut w = KeyedWindow::with_caps(100, 10, 3);
        w.push(1u64, 0, ());
        w.push(1, 50, ());
        assert_eq!(w.push(1, 120, ()).len(), 2); // ts 0 pruned
        w.push(1, 121, ());
        assert_eq!(w.push(1, 122, ()).len(), 3); // capped
    }

    #[test]
    fn window_key_cap_evicts() {
        let mut w = KeyedWindow::with_caps(10, 2, 8);
        w.push(1u64, 0, ());
        w.push(2, 0, ());
        w.push(3, 100, ()); // 1 and 2 are stale
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn bounded_map_ttl() {
        let mut m = BoundedMap::with_cap(10, 2);
        m.insert(1u64, 0, "a");
        assert_eq!(m.get(&1, 10), Some(&"a"));
        assert_eq!(m.get(&1, 11), None);
        m.insert(2, 0, "b");
        m.insert(3, 50, "c");
        assert_eq!(m.len(), 1);
    }
}
