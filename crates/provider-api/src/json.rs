//! JSON for the SDK path: a small value, a parser, and field helpers.
//!
//! Objects keep the order keys were written. Hashing sorts keys, so that
//! order does not change `target.key`. Integer literals become [`JsonValue::Uint`]
//! or [`JsonValue::Int`]; everything else is a finite [`JsonValue::Float`].
//! That matches the serde visitor below, which is what `target.key` was hashed
//! with. [`serde_json`](https://docs.rs/serde_json) stays off this path.

use std::fmt;

/// Minimal JSON value for filter and cursor values in raw calls. Only
/// hashed, never inspected. Avoids `serde_json::Value`, whose `BTreeMap`
/// adds wasm weight.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum JsonValue {
    #[default]
    Null,
    Bool(bool),
    Uint(u64),
    Int(i64),
    Float(f64),
    Str(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

/// Parse failure. `description` is static; the byte offset is separate so
/// errors never format a number that was in the input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    InvalidUtf8 { offset: usize },
    Unexpected { offset: usize },
    Truncated { offset: usize },
    Trailing { offset: usize },
    TooDeep { offset: usize },
    BadEscape { offset: usize },
    LoneSurrogate { offset: usize },
    NonFinite { offset: usize },
}

impl JsonError {
    pub fn offset(self) -> usize {
        match self {
            Self::InvalidUtf8 { offset }
            | Self::Unexpected { offset }
            | Self::Truncated { offset }
            | Self::Trailing { offset }
            | Self::TooDeep { offset }
            | Self::BadEscape { offset }
            | Self::LoneSurrogate { offset }
            | Self::NonFinite { offset } => offset,
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::InvalidUtf8 { .. } => "invalid UTF-8",
            Self::Unexpected { .. } => "unexpected byte",
            Self::Truncated { .. } => "truncated JSON",
            Self::Trailing { .. } => "trailing data",
            Self::TooDeep { .. } => "nesting deeper than 64",
            Self::BadEscape { .. } => "bad escape",
            Self::LoneSurrogate { .. } => "lone surrogate",
            Self::NonFinite { .. } => "non-finite number",
        }
    }

    fn invalid_utf8(offset: usize) -> Self {
        Self::InvalidUtf8 { offset }
    }
    fn unexpected(offset: usize) -> Self {
        Self::Unexpected { offset }
    }
    fn truncated(offset: usize) -> Self {
        Self::Truncated { offset }
    }
    fn trailing(offset: usize) -> Self {
        Self::Trailing { offset }
    }
    fn too_deep(offset: usize) -> Self {
        Self::TooDeep { offset }
    }
    fn bad_escape(offset: usize) -> Self {
        Self::BadEscape { offset }
    }
    fn lone_surrogate(offset: usize) -> Self {
        Self::LoneSurrogate { offset }
    }
    fn non_finite(offset: usize) -> Self {
        Self::NonFinite { offset }
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.description(), self.offset())
    }
}

impl std::error::Error for JsonError {}

/// A field was present but not the type the caller asked for, or the value
/// was not an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonTypeError {
    NotObject,
    WrongType,
    OutOfRange,
}

impl fmt::Display for JsonTypeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotObject => "expected an object",
            Self::WrongType => "wrong type",
            Self::OutOfRange => "out of range",
        })
    }
}

impl std::error::Error for JsonTypeError {}

/// Arrays and objects nest at most this deep. One more is [`JsonError::TooDeep`].
const MAX_DEPTH: usize = 64;

/// Parses RFC 8259 JSON.
///
/// Rejects trailing bytes, invalid UTF-8, bad escapes and lone surrogates.
/// An integer with no `.` or exponent that fits in `u64` is [`JsonValue::Uint`];
/// a negative one that fits in `i64` (and is actually negative) is
/// [`JsonValue::Int`]. `-0` is [`JsonValue::Float`] of negative zero, matching
/// serde_json. Any other number is `str::parse::<f64>`, and non-finite
/// results are rejected. Object keys keep written order; a repeated key
/// keeps the later value.
pub fn parse(input: &[u8]) -> Result<JsonValue, JsonError> {
    let mut p = Parser { input, i: 0 };
    p.skip_ws();
    if p.eof() {
        return Err(JsonError::truncated(0));
    }
    let value = p.value(0)?;
    p.skip_ws();
    if !p.eof() {
        return Err(JsonError::trailing(p.i));
    }
    Ok(value)
}

struct Parser<'a> {
    input: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn eof(&self) -> bool {
        self.i >= self.input.len()
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.i).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.i += 1;
        Some(b)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<JsonValue, JsonError> {
        self.skip_ws();
        let at = self.i;
        let b = self.peek().ok_or(JsonError::truncated(at))?;
        match b {
            b'n' => {
                self.i += 1;
                self.literal(b"ull")?;
                Ok(JsonValue::Null)
            }
            b't' => {
                self.i += 1;
                self.literal(b"rue")?;
                Ok(JsonValue::Bool(true))
            }
            b'f' => {
                self.i += 1;
                self.literal(b"alse")?;
                Ok(JsonValue::Bool(false))
            }
            b'"' => {
                self.i += 1;
                Ok(JsonValue::Str(self.string()?))
            }
            b'[' => {
                self.i += 1;
                self.array(depth, at)
            }
            b'{' => {
                self.i += 1;
                self.object(depth, at)
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(JsonError::unexpected(at)),
        }
    }

    fn literal(&mut self, rest: &[u8]) -> Result<(), JsonError> {
        for &expected in rest {
            match self.bump() {
                Some(b) if b == expected => {}
                Some(_) => return Err(JsonError::unexpected(self.i - 1)),
                None => return Err(JsonError::truncated(self.i)),
            }
        }
        Ok(())
    }

    fn array(&mut self, depth: usize, at: usize) -> Result<JsonValue, JsonError> {
        if depth >= MAX_DEPTH {
            return Err(JsonError::too_deep(at));
        }
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(JsonValue::Array(Vec::new()));
        }
        let mut items = Vec::new();
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_ws();
            match self.bump() {
                Some(b',') => {}
                Some(b']') => return Ok(JsonValue::Array(items)),
                Some(_) => return Err(JsonError::unexpected(self.i - 1)),
                None => return Err(JsonError::truncated(self.i)),
            }
        }
    }

    fn object(&mut self, depth: usize, at: usize) -> Result<JsonValue, JsonError> {
        if depth >= MAX_DEPTH {
            return Err(JsonError::too_deep(at));
        }
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(JsonValue::Object(Vec::new()));
        }
        let mut entries = Vec::new();
        loop {
            self.skip_ws();
            let key_at = self.i;
            if self.bump() != Some(b'"') {
                return Err(JsonError::unexpected(key_at));
            }
            let key = self.string()?;
            self.skip_ws();
            let colon_at = self.i;
            if self.bump() != Some(b':') {
                return Err(JsonError::unexpected(colon_at));
            }
            let val = self.value(depth + 1)?;
            if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = val;
            } else {
                entries.push((key, val));
            }
            self.skip_ws();
            match self.bump() {
                Some(b',') => {}
                Some(b'}') => return Ok(JsonValue::Object(entries)),
                Some(_) => return Err(JsonError::unexpected(self.i - 1)),
                None => return Err(JsonError::truncated(self.i)),
            }
        }
    }

    fn string(&mut self) -> Result<String, JsonError> {
        let mut out = String::new();
        loop {
            let at = self.i;
            let b = self.bump().ok_or(JsonError::truncated(at))?;
            match b {
                b'"' => return Ok(out),
                b'\\' => self.escape(&mut out)?,
                0x00..=0x1F => return Err(JsonError::unexpected(at)),
                0x20..=0x7F => out.push(b as char),
                _ => self.push_utf8(&mut out, b, at)?,
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), JsonError> {
        let at = self.i - 1;
        let b = self.bump().ok_or(JsonError::truncated(self.i))?;
        match b {
            b'"' | b'\\' | b'/' => out.push(b as char),
            b'b' => out.push('\u{0008}'),
            b'f' => out.push('\u{000c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                let cp = self.hex4()?;
                if (0xD800..=0xDBFF).contains(&cp) {
                    let low = self.low_surrogate()?;
                    let u = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
                    out.push(char::from_u32(u).ok_or(JsonError::bad_escape(at))?);
                } else if (0xDC00..=0xDFFF).contains(&cp) {
                    return Err(JsonError::lone_surrogate(at));
                } else {
                    out.push(char::from_u32(cp).ok_or(JsonError::bad_escape(at))?);
                }
            }
            _ => return Err(JsonError::bad_escape(at)),
        }
        Ok(())
    }

    /// A high surrogate must be followed by `\u` and a low surrogate.
    fn low_surrogate(&mut self) -> Result<u32, JsonError> {
        let at = self.i;
        if self.bump() != Some(b'\\') {
            return Err(JsonError::lone_surrogate(at));
        }
        if self.bump() != Some(b'u') {
            return Err(JsonError::lone_surrogate(at));
        }
        let low = self.hex4()?;
        if !(0xDC00..=0xDFFF).contains(&low) {
            return Err(JsonError::lone_surrogate(at));
        }
        Ok(low)
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let start = self.i;
        let mut n = 0u32;
        for _ in 0..4 {
            let b = self.bump().ok_or(JsonError::truncated(self.i))?;
            let d = match b {
                b'0'..=b'9' => u32::from(b - b'0'),
                b'a'..=b'f' => u32::from(b - b'a' + 10),
                b'A'..=b'F' => u32::from(b - b'A' + 10),
                _ => return Err(JsonError::bad_escape(start)),
            };
            n = (n << 4) | d;
        }
        Ok(n)
    }

    fn push_utf8(&mut self, out: &mut String, first: u8, at: usize) -> Result<(), JsonError> {
        let width = match first {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return Err(JsonError::invalid_utf8(at)),
        };
        let mut buf = [first, 0, 0, 0];
        for item in buf.iter_mut().take(width).skip(1) {
            let b = self.bump().ok_or(JsonError::truncated(self.i))?;
            if !(0x80..0xC0).contains(&b) {
                return Err(JsonError::invalid_utf8(at));
            }
            *item = b;
        }
        let text = std::str::from_utf8(&buf[..width]).map_err(|_| JsonError::invalid_utf8(at))?;
        out.push_str(text);
        Ok(())
    }

    fn number(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let first = self.bump().ok_or(JsonError::truncated(self.i))?;
        match first {
            b'0' => {
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(JsonError::unexpected(self.i));
                }
            }
            b'1'..=b'9' => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => {
                return Err(JsonError::unexpected(if self.i == 0 {
                    0
                } else {
                    self.i - 1
                }));
            }
        }
        let mut is_float = false;
        if self.peek() == Some(b'.') {
            is_float = true;
            self.i += 1;
            if !self.take_digits() {
                return Err(JsonError::unexpected(self.i));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            is_float = true;
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.take_digits() {
                return Err(JsonError::unexpected(self.i));
            }
        }
        let lit = self
            .input
            .get(start..self.i)
            .ok_or(JsonError::unexpected(start))?;
        let text = std::str::from_utf8(lit).map_err(|_| JsonError::invalid_utf8(start))?;
        classify_number(text, is_float, start)
    }

    fn take_digits(&mut self) -> bool {
        if !matches!(self.peek(), Some(b'0'..=b'9')) {
            return false;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        true
    }
}

fn classify_number(text: &str, is_float: bool, at: usize) -> Result<JsonValue, JsonError> {
    if !is_float {
        if text.starts_with('-') {
            // `-0` parses as i64 0. serde_json reports that as `-0.0`, so it
            // is not an [`JsonValue::Int`] and falls through to f64.
            if let Ok(n) = text.parse::<i64>() {
                if n < 0 {
                    return Ok(JsonValue::Int(n));
                }
            }
        } else if let Ok(n) = text.parse::<u64>() {
            return Ok(JsonValue::Uint(n));
        }
    }
    match text.parse::<f64>() {
        Ok(f) if f.is_finite() => Ok(JsonValue::Float(f)),
        Ok(_) => Err(JsonError::non_finite(at)),
        Err(_) => Err(JsonError::unexpected(at)),
    }
}

/// Field lookup. `Ok(None)` when the key is absent. The value must be an object.
pub fn get<'a>(value: &'a JsonValue, key: &str) -> Result<Option<&'a JsonValue>, JsonTypeError> {
    let JsonValue::Object(entries) = value else {
        return Err(JsonTypeError::NotObject);
    };
    Ok(entries.iter().find(|(k, _)| k == key).map(|(_, v)| v))
}

pub fn get_str<'a>(value: &'a JsonValue, key: &str) -> Result<Option<&'a str>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_str(v).map(Some),
    }
}

pub fn get_bool(value: &JsonValue, key: &str) -> Result<Option<bool>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_bool(v).map(Some),
    }
}

pub fn get_u64(value: &JsonValue, key: &str) -> Result<Option<u64>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_u64(v).map(Some),
    }
}

pub fn get_u32(value: &JsonValue, key: &str) -> Result<Option<u32>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_u32(v).map(Some),
    }
}

pub fn get_f64(value: &JsonValue, key: &str) -> Result<Option<f64>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_f64(v).map(Some),
    }
}

/// `u64` from a number, or from a decimal string (`"18446744073709551615"`).
pub fn get_u64_flexible(value: &JsonValue, key: &str) -> Result<Option<u64>, JsonTypeError> {
    match get(value, key)? {
        None => Ok(None),
        Some(v) => as_u64_flexible(v).map(Some),
    }
}

pub fn as_str(value: &JsonValue) -> Result<&str, JsonTypeError> {
    match value {
        JsonValue::Str(s) => Ok(s),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_bool(value: &JsonValue) -> Result<bool, JsonTypeError> {
    match value {
        JsonValue::Bool(b) => Ok(*b),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_u64(value: &JsonValue) -> Result<u64, JsonTypeError> {
    match value {
        JsonValue::Uint(n) => Ok(*n),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_u32(value: &JsonValue) -> Result<u32, JsonTypeError> {
    u32::try_from(as_u64(value)?).map_err(|_| JsonTypeError::OutOfRange)
}

pub fn as_usize(value: &JsonValue) -> Result<usize, JsonTypeError> {
    usize::try_from(as_u64(value)?).map_err(|_| JsonTypeError::OutOfRange)
}

pub fn as_f64(value: &JsonValue) -> Result<f64, JsonTypeError> {
    match value {
        JsonValue::Float(f) => Ok(*f),
        JsonValue::Uint(n) => Ok(*n as f64),
        JsonValue::Int(n) => Ok(*n as f64),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_u64_flexible(value: &JsonValue) -> Result<u64, JsonTypeError> {
    match value {
        JsonValue::Uint(n) => Ok(*n),
        JsonValue::Str(s) => s.parse().map_err(|_| JsonTypeError::WrongType),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_array(value: &JsonValue) -> Result<&[JsonValue], JsonTypeError> {
    match value {
        JsonValue::Array(items) => Ok(items),
        _ => Err(JsonTypeError::WrongType),
    }
}

pub fn as_object(value: &JsonValue) -> Result<&[(String, JsonValue)], JsonTypeError> {
    match value {
        JsonValue::Object(entries) => Ok(entries),
        _ => Err(JsonTypeError::NotObject),
    }
}

/// First key that is not in `allowed`, if the value is an object.
pub fn unknown_key<'a>(
    value: &'a JsonValue,
    allowed: &[&str],
) -> Result<Option<&'a str>, JsonTypeError> {
    let entries = as_object(value)?;
    Ok(entries
        .iter()
        .map(|(k, _)| k.as_str())
        .find(|k| !allowed.contains(k)))
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for JsonValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ValueVisitor)
    }
}

#[cfg(feature = "serde")]
struct ValueVisitor;

#[cfg(feature = "serde")]
impl<'de> serde::de::Visitor<'de> for ValueVisitor {
    type Value = JsonValue;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_unit<E>(self) -> Result<JsonValue, E> {
        Ok(JsonValue::Null)
    }

    fn visit_none<E>(self) -> Result<JsonValue, E> {
        Ok(JsonValue::Null)
    }

    fn visit_bool<E>(self, v: bool) -> Result<JsonValue, E> {
        Ok(JsonValue::Bool(v))
    }

    fn visit_u64<E>(self, v: u64) -> Result<JsonValue, E> {
        Ok(JsonValue::Uint(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<JsonValue, E> {
        // Non-negative ints must hash like the same number parsed as u64.
        Ok(u64::try_from(v).map_or(JsonValue::Int(v), JsonValue::Uint))
    }

    fn visit_f64<E>(self, v: f64) -> Result<JsonValue, E> {
        Ok(JsonValue::Float(v))
    }

    fn visit_str<E>(self, v: &str) -> Result<JsonValue, E> {
        Ok(JsonValue::Str(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<JsonValue, E> {
        Ok(JsonValue::Str(v))
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<JsonValue, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(JsonValue::Array(items))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<JsonValue, A::Error> {
        let mut entries = Vec::new();
        while let Some(entry) = map.next_entry()? {
            entries.push(entry);
        }
        Ok(JsonValue::Object(entries))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::panic)]

    use super::*;

    fn nested(n: usize) -> String {
        let mut s = String::new();
        for _ in 0..n {
            s.push('[');
        }
        s.push('0');
        for _ in 0..n {
            s.push(']');
        }
        s
    }

    #[test]
    fn duplicates_keep_the_later_value_in_place() {
        let v = parse(br#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(
            v,
            JsonValue::Object(vec![
                ("a".into(), JsonValue::Uint(3)),
                ("b".into(), JsonValue::Uint(2)),
            ])
        );
    }

    #[test]
    fn depth_limit() {
        assert!(parse(nested(64).as_bytes()).is_ok());
        assert!(matches!(
            parse(nested(65).as_bytes()),
            Err(JsonError::TooDeep { .. })
        ));
        let mut objects = String::new();
        for _ in 0..64 {
            objects.push_str(r#"{"a":"#);
        }
        objects.push('1');
        for _ in 0..64 {
            objects.push('}');
        }
        assert!(parse(objects.as_bytes()).is_ok());
    }

    #[test]
    fn minus_zero_is_negative_float() {
        let JsonValue::Float(f) = parse(b"-0").unwrap() else {
            panic!("-0 was not a float");
        };
        assert_eq!(f.to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn rejects_bad_input() {
        let bad: &[&[u8]] = &[
            b"",
            b" ",
            b"01",
            b"-01",
            b"+1",
            b"1.",
            b"1e",
            b"1e+",
            b"[1,]",
            b"{\"a\":1,}",
            b"\"\\ud800\"",
            b"\"\\u\"",
            b"\"unterminated",
            b"tru",
            b"1 2",
            b"[][]",
            b"\"\x01\"",
            &[0xFF],
            b"\"\xFF\"",
            b"1e9999",
        ];
        for input in bad {
            assert!(parse(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut x = 0x1234_5678_u64;
        for _ in 0..2_000 {
            x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let n = ((x >> 33) as usize) % 48;
            let mut buf = vec![0u8; n];
            for b in &mut buf {
                x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                *b = (x >> 33) as u8;
            }
            let _ = parse(&buf);
        }
    }

    #[test]
    fn escapes_and_unicode_keys() {
        let v = parse(r#"{"é":"\u0041\n\uD800\uDC00"}"#.as_bytes()).unwrap();
        let JsonValue::Object(entries) = v else {
            panic!("expected object");
        };
        assert_eq!(entries[0].0, "é");
        assert_eq!(entries[0].1, JsonValue::Str("A\n\u{10000}".into()));
    }
}

#[cfg(all(test, feature = "serde"))]
mod serde_equiv {
    #![allow(clippy::panic, clippy::unwrap_used)]

    use std::path::Path;

    use super::*;

    fn bits_eq(a: &JsonValue, b: &JsonValue) -> bool {
        match (a, b) {
            (JsonValue::Null, JsonValue::Null) => true,
            (JsonValue::Bool(x), JsonValue::Bool(y)) => x == y,
            (JsonValue::Uint(x), JsonValue::Uint(y)) => x == y,
            (JsonValue::Int(x), JsonValue::Int(y)) => x == y,
            (JsonValue::Float(x), JsonValue::Float(y)) => x.to_bits() == y.to_bits(),
            (JsonValue::Str(x), JsonValue::Str(y)) => x == y,
            (JsonValue::Array(x), JsonValue::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(p, q)| bits_eq(p, q))
            }
            (JsonValue::Object(x), JsonValue::Object(y)) => {
                x.len() == y.len()
                    && x.iter()
                        .zip(y)
                        .all(|(p, q)| p.0 == q.0 && bits_eq(&p.1, &q.1))
            }
            _ => false,
        }
    }

    fn assert_same(input: &[u8]) {
        let ours = parse(input);
        let theirs: Result<JsonValue, _> = serde_json::from_slice(input);
        match (ours, theirs) {
            (Ok(a), Ok(b)) => assert!(
                bits_eq(&a, &b),
                "mismatch on {input:?}\n ours {a:?}\n serde {b:?}"
            ),
            (Err(_), Err(_)) => {}
            (Ok(a), Err(e)) => panic!("accepted {input:?} as {a:?}; serde: {e}"),
            (Err(e), Ok(b)) => panic!("rejected {input:?} ({e}); serde: {b:?}"),
        }
    }

    fn nested(n: usize) -> String {
        let mut s = String::new();
        for _ in 0..n {
            s.push('[');
        }
        s.push('1');
        for _ in 0..n {
            s.push(']');
        }
        s
    }

    #[test]
    fn matches_serde_on_edges_fixtures_and_hostile_input() {
        let edges = [
            "null",
            "true",
            "false",
            "0",
            "-0",
            "1",
            "-1",
            "1.0",
            "1e3",
            "1E+2",
            "1e-1",
            "-0.0",
            "18446744073709551615",
            "18446744073709551616",
            "-9223372036854775808",
            "-9223372036854775809",
            "9007199254740993",
            "\"\"",
            "\"a\"",
            "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"",
            "\"\\u0041\"",
            "\"\\uD800\\uDC00\"",
            "\"café\"",
            "[]",
            "{}",
            "[1,2,true,null]",
            r#"{"b":1,"a":[true],"c":"x"}"#,
            r#"{"é":1,"a":2}"#,
            " ",
            "",
            "01",
            "+1",
            "1.",
            "[1,]",
            "{\"a\":1,}",
            "\"\\ud800\"",
            "\"\\uDC00\"",
            "\"unterminated",
            "tru",
            "1 2",
            "[1 2]",
            "1e9999",
            &nested(64),
        ];
        for input in edges {
            assert_same(input.as_bytes());
        }
        // 65 is over our limit. serde_json still accepts it (its limit is 128).
        let deep = nested(65);
        assert!(matches!(
            parse(deep.as_bytes()),
            Err(JsonError::TooDeep { .. })
        ));

        let hostile = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"firestore"}"#,
            r#"{"service":"firestore","op":"get","ts_ms":-1,"path":"a"}"#,
            r#"{"service":"firestore","op":"get","ts_ms":1,"path":"////"}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{"limit":-5}}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{"filters":[{"field":"x","op":"==","value":{"a":[1,{"b":[[[null]]]}]}}]}}"#,
            r#"{"service":"firestore","op":"query","ts_ms":1,"path":"a","result":{"docs":18446744073709551615,"bytes":18446744073709551615},"query":{"offset":4294967295}}"#,
            r#"{"service":"firestore","op":"aggregate","ts_ms":1,"path":"a","result":{"index_entries":18446744073709551615}}"#,
            r#"{"service":"firestore","op":"commit","ts_ms":1,"path":"a","commit":{"writes":4294967295,"deletes":4294967295}}"#,
            r#"{"service":"firestore","op":"snapshot","ts_ms":1,"path":"a/b/c/d/e/f/g/h","attempt":0}"#,
            r#"{"service":"firestore","op":"get","ts_ms":1,"path":"\u0000/\ud800"}"#,
        ];
        for input in hostile {
            assert_same(input.as_bytes());
        }
        let deep_hostile = format!(
            r#"{{"service":"firestore","op":"query","ts_ms":1,"path":"a","query":{{"filters":[{{"field":"x","op":"==","value":{}1{}}}]}}}}"#,
            "[".repeat(10_000),
            "]".repeat(10_000)
        );
        assert_same(deep_hostile.as_bytes());

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures");
        let mut files = Vec::new();
        walk(&root, &mut files);
        assert!(!files.is_empty(), "no conformance fixtures");
        for path in files {
            let bytes = std::fs::read(&path).unwrap();
            let ours = parse(&bytes);
            let theirs: Result<JsonValue, _> = serde_json::from_slice(&bytes);
            match (ours, theirs) {
                (Ok(a), Ok(b)) => assert!(bits_eq(&a, &b), "mismatch in {}", path.display()),
                (Err(e), Err(_)) => panic!("fixture {} did not parse: {e}", path.display()),
                (Ok(_), Err(e)) => panic!("serde rejected {}: {e}", path.display()),
                (Err(e), Ok(_)) => panic!("parser rejected {}: {e}", path.display()),
            }
        }
    }

    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "json") {
                out.push(path);
            }
        }
    }
}
