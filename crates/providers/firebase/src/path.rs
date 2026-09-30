//! Shared path-segment checks for Realtime Database and Cloud Storage.
//!
//! Firestore document ids are already `{id}` on every second segment, and
//! field names are out of scope. These checks cover a segment that is
//! itself personal data.

/// `true` when `segment` contains `@`, looks like a phone number, is an IP
/// address, or is longer than 40 characters.
///
/// A phone is seven or more digits once `+`, `-`, `(`, `)`, space and `.`
/// are removed. Any other character disqualifies it. An IP is an IPv4 or
/// IPv6 address, optionally wrapped in one pair of brackets.
pub fn personal_segment(segment: &str) -> bool {
    segment.contains('@') || is_phone(segment) || is_ip(segment) || segment.chars().count() > 40
}

fn is_phone(segment: &str) -> bool {
    let mut digits = 0usize;
    for c in segment.chars() {
        if c.is_ascii_digit() {
            digits += 1;
        } else if matches!(c, '+' | '-' | '(' | ')' | ' ' | '.') {
            continue;
        } else {
            return false;
        }
    }
    digits >= 7
}

fn is_ip(segment: &str) -> bool {
    let bare = segment
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(segment);
    // Hand-rolled. `std::net::IpAddr` pulls the std parser into the SDK wasm.
    is_ipv4(bare) || is_ipv6(bare)
}

/// Four decimal octets, 0-255, no leading zeros. Dotted quad only.
fn is_ipv4(s: &str) -> bool {
    let mut parts = 0u8;
    let mut val: u16 = 0;
    let mut digits = 0u8;
    for b in s.bytes() {
        if b.is_ascii_digit() {
            if digits >= 3 || (digits > 0 && val == 0) {
                return false;
            }
            val = val * 10 + u16::from(b - b'0');
            if val > 255 {
                return false;
            }
            digits += 1;
        } else if b == b'.' {
            if digits == 0 || parts == 3 {
                return false;
            }
            parts += 1;
            val = 0;
            digits = 0;
        } else {
            return false;
        }
    }
    parts == 3 && digits > 0
}

/// Textual IPv6, including one `::` and a trailing dotted quad.
fn is_ipv6(s: &str) -> bool {
    if s.len() > 45 || !s.as_bytes().contains(&b':') || s.contains(":::") {
        return false;
    }
    let doubles = double_colons(s);
    if doubles > 1 {
        return false;
    }
    let (left, right) = match s.split_once("::") {
        Some(pair) => pair,
        None => (s, ""),
    };
    let mut groups = 0u8;
    if !left.is_empty() && !ipv6_groups(left, &mut groups) {
        return false;
    }
    if !right.is_empty() && !ipv6_groups(right, &mut groups) {
        return false;
    }
    if doubles == 1 {
        groups < 8
    } else {
        groups == 8
    }
}

fn double_colons(s: &str) -> u8 {
    let b = s.as_bytes();
    let mut n = 0u8;
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b':' && b[i + 1] == b':' {
            n = n.saturating_add(1);
            i += 2;
        } else {
            i += 1;
        }
    }
    n
}

fn ipv6_groups(side: &str, groups: &mut u8) -> bool {
    let bytes = side.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i <= bytes.len() {
        if i == bytes.len() || bytes[i] == b':' {
            let part = &side[start..i];
            if part.is_empty() {
                return false;
            }
            let last = i == bytes.len();
            if last && part.as_bytes().contains(&b'.') {
                if !is_ipv4(part) {
                    return false;
                }
                *groups = groups.saturating_add(2);
                return *groups <= 8;
            }
            if !is_hex_group(part) {
                return false;
            }
            *groups = groups.saturating_add(1);
            if *groups > 8 {
                return false;
            }
            start = i + 1;
        }
        i += 1;
    }
    true
}

fn is_hex_group(s: &str) -> bool {
    (1..=4).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_personal_segments() {
        assert!(personal_segment("alice@example.com"));
        assert!(personal_segment("+1 (555) 123-4567"));
        assert!(personal_segment("192.168.0.1"));
        assert!(personal_segment("[2001:db8::1]"));
        assert!(personal_segment(&"a".repeat(41)));
        assert!(!personal_segment("room_1"));
        assert!(!personal_segment("photos"));
        assert!(!personal_segment("orderByChild"));
    }

    #[test]
    fn ip_check_matches_std() {
        let samples = [
            "192.168.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "192.168.001.1",
            "192.168.0",
            "1.2.3.4.5",
            "::1",
            "::",
            "2001:db8::1",
            "2001:0db8:85a3::8a2e:0370:7334",
            "fe80::1",
            "::ffff:192.0.2.1",
            "1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7:8:9",
            ":::1",
            "gggg::1",
            "192.168.0.1.jpg",
            "",
        ];
        for sample in samples {
            let std_ok = sample.parse::<std::net::IpAddr>().is_ok();
            assert_eq!(is_ip(sample), std_ok, "{sample}");
            let wrapped = format!("[{sample}]");
            assert_eq!(is_ip(&wrapped), std_ok, "{wrapped}");
        }
    }
}
