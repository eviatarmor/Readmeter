use readmeter_core::{Platform, SdkInfo};
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};
use readmeter_rules::Evaluation;

use crate::ClientError;

/// Client settings, supplied by the host as JSON.
///
/// 64-bit `session` accepts a number or a decimal string because JavaScript
/// numbers lose precision above 2^53.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Provider id, e.g. `firebase`.
    pub provider: String,
    pub sdk: SdkInfo,
    /// Random id for this process or browser tab.
    pub session: u64,
    /// 32 hex chars (128-bit SipHash key), issued per project by the console.
    pub hash_key: String,
    pub platform: Platform,
    pub dev: bool,
    /// Fraction of sessions whose events are uploaded, `0..=1`.
    pub sample_rate: f64,
    /// Rule evaluations to run in-process. Defaults to local rules only;
    /// dev builds may add `window` for immediate warnings.
    pub evaluations: Vec<Evaluation>,
    pub max_events: usize,
    pub max_findings: usize,
}

const FIELDS: &[&str] = &[
    "provider",
    "sdk",
    "session",
    "hash_key",
    "platform",
    "dev",
    "sample_rate",
    "evaluations",
    "max_events",
    "max_findings",
];

impl ClientConfig {
    /// Same fields and defaults as the previous serde mapping.
    /// Unknown fields are rejected. `sample_rate` must be within `0..=1`.
    /// `session` accepts a JSON number or a decimal string.
    pub fn from_json(value: &JsonValue) -> Result<Self, ClientError> {
        if let Some(name) = json::unknown_key(value, FIELDS).map_err(ty_cfg)? {
            return Err(ClientError::Config(format!("unknown field `{name}`")));
        }
        let sample_rate =
            match json::get_f64(value, "sample_rate").map_err(|e| field("sample_rate", e))? {
                None => 1.0,
                Some(rate) if (0.0..=1.0).contains(&rate) => rate,
                Some(_) => {
                    return Err(ClientError::Config(
                        "sample_rate must be within 0..=1".into(),
                    ));
                }
            };
        Ok(Self {
            provider: req_str(value, "provider")?,
            sdk: sdk_from(json::get(value, "sdk").map_err(|e| field("sdk", e))?)?,
            session: req_session(value)?,
            hash_key: req_str(value, "hash_key")?,
            platform: platform_from(value)?,
            dev: json::get_bool(value, "dev")
                .map_err(|e| field("dev", e))?
                .unwrap_or(false),
            sample_rate,
            evaluations: evaluations_from(value)?,
            max_events: def_usize(value, "max_events", 2_000)?,
            max_findings: def_usize(value, "max_findings", 200)?,
        })
    }

    pub fn hash_key(&self) -> Result<(u64, u64), ClientError> {
        let k = self.hash_key.as_str();
        let bad = || ClientError::Config("hash_key must be 32 hex characters".into());
        if k.len() != 32 {
            return Err(bad());
        }
        let k0 = u64::from_str_radix(&k[..16], 16).map_err(|_| bad())?;
        let k1 = u64::from_str_radix(&k[16..], 16).map_err(|_| bad())?;
        Ok((k0, k1))
    }
}

fn ty_cfg(err: JsonTypeError) -> ClientError {
    match err {
        JsonTypeError::NotObject => ClientError::Config("expected object".into()),
        JsonTypeError::WrongType => ClientError::Config("wrong type".into()),
        JsonTypeError::OutOfRange => ClientError::Config("out of range".into()),
    }
}

fn field(name: &str, err: JsonTypeError) -> ClientError {
    let why = match err {
        JsonTypeError::NotObject => "expected an object",
        JsonTypeError::WrongType => "wrong type",
        JsonTypeError::OutOfRange => "out of range",
    };
    ClientError::Config(format!("`{name}`: {why}"))
}

fn missing(name: &str) -> ClientError {
    ClientError::Config(format!("missing `{name}`"))
}

fn req_str(value: &JsonValue, key: &str) -> Result<String, ClientError> {
    match json::get_str(value, key).map_err(|e| field(key, e))? {
        Some(s) => Ok(s.to_owned()),
        None => Err(missing(key)),
    }
}

fn req_session(value: &JsonValue) -> Result<u64, ClientError> {
    match json::get_u64_flexible(value, "session").map_err(|e| field("session", e))? {
        Some(n) => Ok(n),
        None => Err(missing("session")),
    }
}

fn def_usize(value: &JsonValue, key: &str, default: usize) -> Result<usize, ClientError> {
    match json::get(value, key).map_err(|e| field(key, e))? {
        None => Ok(default),
        Some(v) => json::as_usize(v).map_err(|e| field(key, e)),
    }
}

fn sdk_from(value: Option<&JsonValue>) -> Result<SdkInfo, ClientError> {
    let Some(value) = value else {
        return Err(missing("sdk"));
    };
    json::as_object(value).map_err(|_| field("sdk", JsonTypeError::NotObject))?;
    Ok(SdkInfo {
        name: req_str(value, "name")?,
        version: req_str(value, "version")?,
    })
}

fn platform_from(value: &JsonValue) -> Result<Platform, ClientError> {
    match json::get_str(value, "platform").map_err(|e| field("platform", e))? {
        None => Ok(Platform::Unknown),
        Some("browser") => Ok(Platform::Browser),
        Some("server") => Ok(Platform::Server),
        Some("mobile") => Ok(Platform::Mobile),
        Some("unknown") => Ok(Platform::Unknown),
        Some(_) => Err(ClientError::Config("`platform`: unknown value".into())),
    }
}

fn evaluations_from(value: &JsonValue) -> Result<Vec<Evaluation>, ClientError> {
    let Some(raw) = json::get(value, "evaluations").map_err(|e| field("evaluations", e))? else {
        return Ok(vec![Evaluation::Local]);
    };
    let items = json::as_array(raw).map_err(|e| field("evaluations", e))?;
    items
        .iter()
        .map(|item| {
            let name = json::as_str(item).map_err(|e| field("evaluations", e))?;
            match name {
                "local" => Ok(Evaluation::Local),
                "window" => Ok(Evaluation::Window),
                "aggregate" => Ok(Evaluation::Aggregate),
                _ => Err(ClientError::Config("`evaluations`: unknown value".into())),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use readmeter_provider_api::json::parse;

    fn base(session: &str) -> String {
        format!(
            r#"{{"provider":"firebase","sdk":{{"name":"n","version":"0"}},"session":{session},"hash_key":"0123456789abcdef0123456789abcdef"}}"#
        )
    }

    fn cfg(text: &str) -> Result<ClientConfig, ClientError> {
        let value = parse(text.as_bytes()).unwrap();
        ClientConfig::from_json(&value)
    }

    #[test]
    fn session_as_number_or_decimal_string() {
        let number = cfg(&base("42")).unwrap();
        assert_eq!(number.session, 42);
        assert!((number.sample_rate - 1.0).abs() < f64::EPSILON);
        assert_eq!(number.evaluations, vec![Evaluation::Local]);
        assert_eq!(number.max_events, 2_000);
        assert_eq!(number.max_findings, 200);
        assert_eq!(number.platform, Platform::Unknown);
        assert!(!number.dev);

        let text = cfg(&base("\"18446744073709551615\"")).unwrap();
        assert_eq!(text.session, u64::MAX);
    }

    #[test]
    fn unknown_field_and_wrong_types() {
        let extra = format!("{},\"nope\":1}}", base("1").trim_end_matches('}'));
        assert!(cfg(&extra).is_err(), "{extra}");
        assert!(cfg(&base("true")).is_err());
        assert!(cfg(&base("\"nope\"")).is_err());
        assert!(cfg(&base("1.5")).is_err());
        let bad_dev = format!("{},\"dev\":\"yes\"}}", base("1").trim_end_matches('}'));
        assert!(cfg(&bad_dev).is_err());
        let rate = format!("{},\"sample_rate\":1.5}}", base("1").trim_end_matches('}'));
        assert!(cfg(&rate).is_err());
        let ok = format!(
            "{},\"sample_rate\":0,\"platform\":\"browser\"}}",
            base("1").trim_end_matches('}')
        );
        let c = cfg(&ok).unwrap();
        assert_eq!(c.sample_rate, 0.0);
        assert_eq!(c.platform, Platform::Browser);
    }
}
