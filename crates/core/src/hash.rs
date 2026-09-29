use std::hash::Hasher;

use siphasher::sip::SipHasher13;

/// Keyed hash used to redact identifiers and values before they leave the
/// process. The key is per project and never sent with events, so hashes of
/// low-entropy values (emails, small ints) cannot be reversed by brute force
/// without it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyedHasher {
    k0: u64,
    k1: u64,
}

impl KeyedHasher {
    pub fn new(k0: u64, k1: u64) -> Self {
        Self { k0, k1 }
    }

    pub fn start(&self) -> HashBuilder {
        HashBuilder(SipHasher13::new_with_keys(self.k0, self.k1))
    }

    pub fn hash_str(&self, s: &str) -> u64 {
        self.start().str(s).finish()
    }
}

/// Incremental hash with unambiguous framing (each part is tagged and
/// length-prefixed), so `("ab", "c")` and `("a", "bc")` hash differently.
#[derive(Clone)]
pub struct HashBuilder(SipHasher13);

impl HashBuilder {
    pub fn str(mut self, s: &str) -> Self {
        self.0.write_u8(b's');
        self.0.write_u64(s.len() as u64);
        self.0.write(s.as_bytes());
        self
    }

    pub fn bytes(mut self, b: &[u8]) -> Self {
        self.0.write_u8(b'b');
        self.0.write_u64(b.len() as u64);
        self.0.write(b);
        self
    }

    pub fn u64(mut self, v: u64) -> Self {
        self.0.write_u8(b'u');
        self.0.write_u64(v);
        self
    }

    pub fn opt_u64(self, v: Option<u64>) -> Self {
        match v {
            Some(v) => self.tag(1).u64(v),
            None => self.tag(0),
        }
    }

    pub fn bool(self, v: bool) -> Self {
        self.tag(u8::from(v))
    }

    pub fn tag(mut self, t: u8) -> Self {
        self.0.write_u8(b't');
        self.0.write_u8(t);
        self
    }

    pub fn finish(self) -> u64 {
        self.0.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_prevents_concatenation_collisions() {
        let h = KeyedHasher::new(1, 2);
        let a = h.start().str("ab").str("c").finish();
        let b = h.start().str("a").str("bc").finish();
        assert_ne!(a, b);
    }

    #[test]
    fn key_changes_output() {
        assert_ne!(
            KeyedHasher::new(1, 2).hash_str("x"),
            KeyedHasher::new(1, 3).hash_str("x")
        );
    }
}
