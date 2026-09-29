//! JSON array of local findings. Hand-written so the SDK path does not pull
//! in `serde_json` or float formatting. `evidence` stays in the postcard batch.

use readmeter_core::{Finding, Severity};

/// Encodes findings as a JSON array. Each object has `rule`, `severity`,
/// `template`, `message` and `wasted` (unit name to integer), in that order.
pub(crate) fn findings_json(findings: &[Finding]) -> String {
    let mut out = String::from("[");
    for (i, finding) in findings.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_finding(&mut out, finding);
    }
    out.push(']');
    out
}

fn push_finding(out: &mut String, finding: &Finding) {
    out.push('{');
    push_str_field(out, "rule", &finding.rule);
    out.push(',');
    push_str_field(out, "severity", severity_name(finding.severity));
    out.push(',');
    push_str_field(out, "template", &finding.template);
    out.push(',');
    push_str_field(out, "message", &finding.message);
    out.push(',');
    out.push_str("\"wasted\":{");
    for (i, (unit, amount)) in finding.wasted.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_string(out, unit);
        out.push(':');
        out.push_str(&amount.to_string());
    }
    out.push_str("}}");
}

fn push_str_field(out: &mut String, key: &str, value: &str) {
    push_string(out, key);
    out.push(':');
    push_string(out, value);
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Low => "low",
        Severity::Medium => "medium",
        Severity::High => "high",
        Severity::Critical => "critical",
    }
}

fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => push_u16(out, c as u32),
            c if !c.is_ascii() => {
                let u = c as u32;
                if u <= 0xFFFF {
                    push_u16(out, u);
                } else {
                    let v = u - 0x10000;
                    push_u16(out, 0xD800 + (v >> 10));
                    push_u16(out, 0xDC00 + (v & 0x3FF));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_u16(out: &mut String, n: u32) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push_str("\\u");
    for shift in [12, 8, 4, 0] {
        out.push(HEX[((n >> shift) & 0xF) as usize] as char);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Finding, Scalar, Severity, Units, VecMap};

    use super::*;

    fn finding(message: &str) -> Finding {
        let mut evidence = VecMap::new();
        evidence.insert("note", Scalar::Str("secret-evidence".into()));
        evidence.insert("ratio", Scalar::F64(0.5));
        Finding {
            rule: "firebase.firestore/unbounded-list".into(),
            severity: Severity::High,
            ts_ms: 1,
            provider: "firebase".into(),
            service: "firestore".into(),
            template: "users/{id}".into(),
            session: 1,
            callsite: None,
            message: message.into(),
            evidence,
            wasted: Units::new().with("reads", 3).with("writes", 1),
        }
    }

    #[test]
    fn exact_fields_and_escaping() {
        let message = "say \"hi\" \\ \n\t\u{0001} café 😀";
        let text = findings_json(&[finding(message)]);
        assert!(text.starts_with(r#"[{"rule":"#));
        assert!(!text.contains("secret-evidence"));
        assert!(!text.contains("ratio"));
        assert!(!text.contains('é'));
        assert!(text.contains("\\u00e9"));
        assert!(text.contains("\\u0001"));
        assert!(text.contains("\\\""));
        assert!(text.contains("\\\\"));
        assert!(text.contains("\\n"));
        assert!(text.contains("\\ud83d\\ude00"));

        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let obj = &value.as_array().unwrap()[0];
        let map = obj.as_object().unwrap();
        assert_eq!(map.len(), 5);
        for key in ["rule", "severity", "template", "message", "wasted"] {
            assert!(map.contains_key(key), "{key}");
        }
        assert!(map.get("evidence").is_none());
        assert_eq!(map["severity"], "high");
        assert_eq!(map["message"], message);
        assert_eq!(map["wasted"]["reads"], 3);
        assert_eq!(map["wasted"]["writes"], 1);
        assert!(map["wasted"]["reads"].is_u64());
    }
}
