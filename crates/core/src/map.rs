//! Sorted-vector map for the small string-keyed maps on the SDK path
//! (units, evidence, rule params). A `BTreeMap` per value type costs several
//! KB of wasm each; these maps hold a handful of entries, where a sorted
//! `Vec` is both smaller and faster.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct VecMap<V>(Vec<(String, V)>);

impl<V> Default for VecMap<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V> VecMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    fn find(&self, key: &str) -> Result<usize, usize> {
        self.0.binary_search_by(|(k, _)| k.as_str().cmp(key))
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.find(key).ok().map(|i| &self.0[i].1)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match self.find(key) {
            Ok(i) => Some(&mut self.0[i].1),
            Err(_) => None,
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.find(key).is_ok()
    }

    /// Inserts or replaces; returns the previous value.
    pub fn insert(&mut self, key: impl Into<String>, value: V) -> Option<V> {
        let key = key.into();
        match self.find(&key) {
            Ok(i) => Some(std::mem::replace(&mut self.0[i].1, value)),
            Err(i) => {
                self.0.insert(i, (key, value));
                None
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<V> {
        self.find(key).ok().map(|i| self.0.remove(i).1)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Entries in key order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }
}

impl<V: fmt::Debug> fmt::Debug for VecMap<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl<K: Into<String>, V> FromIterator<(K, V)> for VecMap<V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut m = Self::new();
        for (k, v) in iter {
            m.insert(k, v);
        }
        m
    }
}

impl<K: Into<String>, V, const N: usize> From<[(K, V); N]> for VecMap<V> {
    fn from(entries: [(K, V); N]) -> Self {
        entries.into_iter().collect()
    }
}

impl<V: Serialize> Serialize for VecMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for VecMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct MapVisitor<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for MapVisitor<V> {
            type Value = VecMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<VecMap<V>, A::Error> {
                let mut m = VecMap::new();
                while let Some((k, v)) = access.next_entry::<String, V>()? {
                    m.insert(k, v);
                }
                Ok(m)
            }
        }
        d.deserialize_map(MapVisitor(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_insert_replace_remove() {
        let mut m = VecMap::new();
        m.insert("b", 2);
        m.insert("a", 1);
        assert_eq!(m.insert("b", 3), Some(2));
        assert_eq!(m.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(m.get("b"), Some(&3));
        assert_eq!(m.remove("a"), Some(1));
        assert!(!m.contains_key("a"));
    }

    #[test]
    fn postcard_roundtrip() {
        let m: VecMap<u64> = [("x", 1u64), ("a", 2)].into();
        let bytes = postcard::to_allocvec(&m).unwrap();
        assert_eq!(postcard::from_bytes::<VecMap<u64>>(&bytes).unwrap(), m);
    }
}
