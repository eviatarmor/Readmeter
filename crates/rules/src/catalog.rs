use std::collections::BTreeSet;

use readmeter_core::{Severity, VecMap};
use serde::{Deserialize, Serialize};

use crate::config::{RuleConfig, RuleOverride};
use crate::def::{ANY, Evaluation, ParamValue, RuleDef, RuleSpec, Status};

/// The full set of rule definitions known to a build.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Catalog {
    pub rules: Vec<RuleDef>,
}

/// What SDKs receive from the rule CDN: engine specs plus tenant overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    /// Catalog revision the bundle was built from, for cache busting and support.
    #[serde(default)]
    pub revision: String,
    pub rules: Vec<RuleSpec>,
    #[serde(default)]
    pub config: RuleConfig,
}

const MAGIC: &[u8; 2] = b"RB";
const HEADER_LEN: usize = 4;

/// Binary bundle format version, little-endian, written after the `RB` magic.
pub const BUNDLE_VERSION: u16 = 1;

impl Bundle {
    pub fn validate(&self) -> Result<(), CatalogError> {
        let mut seen = BTreeSet::new();
        for rule in &self.rules {
            if !seen.insert(rule.id.as_str()) {
                return Err(CatalogError::Duplicate(rule.id.clone()));
            }
            validate_spec(rule)?;
        }
        Ok(())
    }

    /// Encodes this bundle as `bundle.bin`: `RB` magic, little-endian
    /// [`BUNDLE_VERSION`], then a postcard body.
    pub fn encode(&self) -> Result<Vec<u8>, BundleError> {
        let mut out = Vec::with_capacity(HEADER_LEN + 32 * self.rules.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&BUNDLE_VERSION.to_le_bytes());
        let body = postcard::to_allocvec(&BinBundle::from(self))?;
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// Decodes `bundle.bin` and rejects a bundle that fails [`Bundle::validate`].
    pub fn decode(bytes: &[u8]) -> Result<Self, BundleError> {
        if bytes.len() < HEADER_LEN {
            return Err(BundleError::Truncated);
        }
        if &bytes[..2] != MAGIC {
            return Err(BundleError::BadMagic);
        }
        let version = u16::from_le_bytes([bytes[2], bytes[3]]);
        if version != BUNDLE_VERSION {
            return Err(BundleError::UnsupportedVersion(version));
        }
        let bundle = Bundle::from(postcard::from_bytes::<BinBundle>(&bytes[HEADER_LEN..])?);
        bundle.validate()?;
        Ok(bundle)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("payload too short")]
    Truncated,
    #[error("bad magic bytes")]
    BadMagic,
    #[error("unsupported bundle version {0}")]
    UnsupportedVersion(u16),
    #[error("codec error: {0}")]
    Codec(#[from] postcard::Error),
    #[error(transparent)]
    Invalid(#[from] CatalogError),
}

/// Postcard mirror of [`ParamValue`]. Variant order is the bundle format.
#[derive(Debug, Clone, Serialize, Deserialize)]
enum BinParam {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct BinBundle {
    revision: String,
    rules: Vec<BinSpec>,
    config: BinConfig,
}

#[derive(Debug, Serialize, Deserialize)]
struct BinSpec {
    id: String,
    provider: String,
    service: String,
    severity: Severity,
    evaluation: Evaluation,
    status: Status,
    default_enabled: bool,
    params: VecMap<BinParam>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BinConfig {
    overrides: VecMap<BinOverride>,
    cooldown_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct BinOverride {
    enabled: Option<bool>,
    severity: Option<Severity>,
    params: VecMap<BinParam>,
}

impl From<&ParamValue> for BinParam {
    fn from(v: &ParamValue) -> Self {
        match v {
            ParamValue::Bool(v) => BinParam::Bool(*v),
            ParamValue::Int(v) => BinParam::Int(*v),
            ParamValue::Float(v) => BinParam::Float(*v),
            ParamValue::Str(v) => BinParam::Str(v.clone()),
        }
    }
}

impl From<&BinParam> for ParamValue {
    fn from(v: &BinParam) -> Self {
        match v {
            BinParam::Bool(v) => ParamValue::Bool(*v),
            BinParam::Int(v) => ParamValue::Int(*v),
            BinParam::Float(v) => ParamValue::Float(*v),
            BinParam::Str(v) => ParamValue::Str(v.clone()),
        }
    }
}

fn params_to_bin(params: &VecMap<ParamValue>) -> VecMap<BinParam> {
    params
        .iter()
        .map(|(k, v)| (k.to_owned(), BinParam::from(v)))
        .collect()
}

fn params_from_bin(params: &VecMap<BinParam>) -> VecMap<ParamValue> {
    params
        .iter()
        .map(|(k, v)| (k.to_owned(), ParamValue::from(v)))
        .collect()
}

impl From<&RuleSpec> for BinSpec {
    fn from(spec: &RuleSpec) -> Self {
        Self {
            id: spec.id.clone(),
            provider: spec.provider.clone(),
            service: spec.service.clone(),
            severity: spec.severity,
            evaluation: spec.evaluation,
            status: spec.status,
            default_enabled: spec.default_enabled,
            params: params_to_bin(&spec.params),
        }
    }
}

impl From<BinSpec> for RuleSpec {
    fn from(spec: BinSpec) -> Self {
        Self {
            id: spec.id,
            provider: spec.provider,
            service: spec.service,
            severity: spec.severity,
            evaluation: spec.evaluation,
            status: spec.status,
            default_enabled: spec.default_enabled,
            params: params_from_bin(&spec.params),
        }
    }
}

impl From<&RuleOverride> for BinOverride {
    fn from(ov: &RuleOverride) -> Self {
        Self {
            enabled: ov.enabled,
            severity: ov.severity,
            params: params_to_bin(&ov.params),
        }
    }
}

impl From<&BinOverride> for RuleOverride {
    fn from(ov: &BinOverride) -> Self {
        Self {
            enabled: ov.enabled,
            severity: ov.severity,
            params: params_from_bin(&ov.params),
        }
    }
}

impl From<&RuleConfig> for BinConfig {
    fn from(config: &RuleConfig) -> Self {
        Self {
            overrides: config
                .overrides
                .iter()
                .map(|(k, v)| (k.to_owned(), BinOverride::from(v)))
                .collect(),
            cooldown_ms: config.cooldown_ms,
        }
    }
}

impl From<BinConfig> for RuleConfig {
    fn from(config: BinConfig) -> Self {
        Self {
            overrides: config
                .overrides
                .iter()
                .map(|(k, v)| (k.to_owned(), RuleOverride::from(v)))
                .collect(),
            cooldown_ms: config.cooldown_ms,
        }
    }
}

impl From<&Bundle> for BinBundle {
    fn from(bundle: &Bundle) -> Self {
        Self {
            revision: bundle.revision.clone(),
            rules: bundle.rules.iter().map(BinSpec::from).collect(),
            config: BinConfig::from(&bundle.config),
        }
    }
}

impl From<BinBundle> for Bundle {
    fn from(bundle: BinBundle) -> Self {
        Self {
            revision: bundle.revision,
            rules: bundle.rules.into_iter().map(RuleSpec::from).collect(),
            config: RuleConfig::from(bundle.config),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("duplicate rule id `{0}`")]
    Duplicate(String),
    #[error("rule `{id}`: {reason}")]
    Invalid { id: String, reason: String },
    #[cfg(feature = "catalog-toml")]
    #[error("{path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: toml::de::Error,
    },
    #[cfg(feature = "catalog-toml")]
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

impl Catalog {
    pub fn new(rules: Vec<RuleDef>) -> Result<Self, CatalogError> {
        let catalog = Self { rules };
        catalog.validate()?;
        Ok(catalog)
    }

    pub fn get(&self, id: &str) -> Option<&RuleDef> {
        self.rules.iter().find(|r| r.id == id)
    }

    pub fn specs(&self) -> Vec<RuleSpec> {
        self.rules.iter().map(RuleDef::spec).collect()
    }

    /// Builds the SDK bundle for one tenant configuration.
    pub fn bundle(&self, revision: &str, config: RuleConfig) -> Bundle {
        Bundle {
            revision: revision.to_owned(),
            rules: self.specs(),
            config,
        }
    }

    pub fn validate(&self) -> Result<(), CatalogError> {
        let mut seen = BTreeSet::new();
        for rule in &self.rules {
            if !seen.insert(rule.id.as_str()) {
                return Err(CatalogError::Duplicate(rule.id.clone()));
            }
            validate_spec(&rule.spec())?;
            validate_text(rule)?;
        }
        Ok(())
    }

    /// Parses one rule from TOML.
    #[cfg(feature = "catalog-toml")]
    pub fn parse_rule(path: &str, text: &str) -> Result<RuleDef, CatalogError> {
        toml::from_str(text).map_err(|source| CatalogError::Parse {
            path: path.to_owned(),
            source,
        })
    }

    /// Loads every `*.toml` under `dir`, recursively, sorted by id.
    #[cfg(feature = "catalog-toml")]
    pub fn load_dir(dir: &std::path::Path) -> Result<Self, CatalogError> {
        let mut files = Vec::new();
        collect_toml(dir, &mut files)?;
        let mut rules = Vec::with_capacity(files.len());
        for path in files {
            let display = path.display().to_string();
            let text = std::fs::read_to_string(&path).map_err(|source| CatalogError::Io {
                path: display.clone(),
                source,
            })?;
            rules.push(Self::parse_rule(&display, &text)?);
        }
        rules.sort_by(|a, b| a.id.cmp(&b.id));
        Self::new(rules)
    }
}

#[cfg(feature = "catalog-toml")]
fn collect_toml(
    dir: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), CatalogError> {
    let io = |source| CatalogError::Io {
        path: dir.display().to_string(),
        source,
    };
    for entry in std::fs::read_dir(dir).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path.is_dir() {
            collect_toml(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "toml") {
            out.push(path);
        }
    }
    Ok(())
}

fn validate_spec(rule: &RuleSpec) -> Result<(), CatalogError> {
    let invalid = |reason: String| CatalogError::Invalid {
        id: rule.id.clone(),
        reason,
    };
    let Some((scope, name)) = rule.id.split_once('/') else {
        return Err(invalid("id must be `<scope>/<name>`".into()));
    };
    if !is_kebab(name) {
        return Err(invalid(format!("name `{name}` must be kebab-case")));
    }
    let expected_scope = if rule.provider == ANY {
        if rule.service != ANY {
            return Err(invalid("generic rules must use service = \"*\"".into()));
        }
        "generic".to_owned()
    } else {
        if rule.service == ANY {
            return Err(invalid("provider rules must name a service".into()));
        }
        format!("{}.{}", rule.provider, rule.service)
    };
    if scope != expected_scope {
        return Err(invalid(format!(
            "id scope `{scope}` must be `{expected_scope}`"
        )));
    }
    Ok(())
}

fn validate_text(rule: &RuleDef) -> Result<(), CatalogError> {
    for (field, value) in [
        ("title", &rule.title),
        ("summary", &rule.summary),
        ("description", &rule.description),
        ("fix", &rule.fix),
    ] {
        if value.trim().is_empty() {
            return Err(CatalogError::Invalid {
                id: rule.id.clone(),
                reason: format!("`{field}` must not be empty"),
            });
        }
    }
    Ok(())
}

fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.as_bytes().windows(2).any(|w| w == b"--")
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::rule_def;

    #[test]
    fn accepts_valid_ids() {
        let generic = rule_def("generic/n-plus-one", "*", "*");
        let scoped = rule_def("firebase.firestore/unbounded-list", "firebase", "firestore");
        assert!(Catalog::new(vec![generic, scoped]).is_ok());
    }

    #[test]
    fn rejects_bad_ids() {
        for (id, p, s) in [
            ("n-plus-one", "*", "*"),
            ("generic/NPlusOne", "*", "*"),
            ("firestore/unbounded-list", "firebase", "firestore"),
            ("generic/x", "firebase", "firestore"),
            ("generic/x", "*", "firestore"),
        ] {
            assert!(
                Catalog::new(vec![rule_def(id, p, s)]).is_err(),
                "{id} should fail"
            );
        }
    }

    #[test]
    fn rejects_duplicates() {
        let a = rule_def("generic/a", "*", "*");
        assert!(matches!(
            Catalog::new(vec![a.clone(), a]),
            Err(CatalogError::Duplicate(_))
        ));
    }

    fn sample_bundle() -> Bundle {
        let mut params = VecMap::new();
        params.insert("on", ParamValue::Bool(true));
        params.insert("limit", ParamValue::Int(10));
        params.insert("ratio", ParamValue::Float(0.5));
        params.insert("label", ParamValue::Str("x".into()));
        let spec = RuleSpec {
            id: "generic/sample-rule".into(),
            provider: "*".into(),
            service: "*".into(),
            severity: Severity::High,
            evaluation: Evaluation::Local,
            status: Status::Stable,
            default_enabled: true,
            params,
        };
        let mut overrides = VecMap::new();
        overrides.insert(
            "generic/sample-rule",
            RuleOverride {
                enabled: Some(false),
                severity: Some(Severity::Low),
                params: [("limit".to_owned(), ParamValue::Int(3))].into(),
            },
        );
        Bundle {
            revision: "rev".into(),
            rules: vec![spec],
            config: RuleConfig {
                overrides,
                cooldown_ms: 1_000,
            },
        }
    }

    #[test]
    fn roundtrip_sample() {
        let bundle = sample_bundle();
        let bytes = bundle.encode().expect("encode");
        assert_eq!(&bytes[..2], b"RB");
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), BUNDLE_VERSION);
        assert_eq!(Bundle::decode(&bytes).expect("decode"), bundle);
    }

    #[test]
    fn rejects_bad_header() {
        assert!(matches!(Bundle::decode(b"R"), Err(BundleError::Truncated)));
        assert!(matches!(
            Bundle::decode(b"XX\x01\x00"),
            Err(BundleError::BadMagic)
        ));
        let mut bytes = sample_bundle().encode().expect("encode");
        bytes[2] = 2;
        bytes[3] = 0;
        assert!(matches!(
            Bundle::decode(&bytes),
            Err(BundleError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn decode_validates() {
        let bin = BinBundle {
            revision: "r".into(),
            rules: vec![BinSpec {
                id: "not-an-id".into(),
                provider: "*".into(),
                service: "*".into(),
                severity: Severity::Low,
                evaluation: Evaluation::Local,
                status: Status::Stable,
                default_enabled: true,
                params: VecMap::new(),
            }],
            config: BinConfig::from(&RuleConfig::default()),
        };
        let body = postcard::to_allocvec(&bin).expect("encode");
        let mut bytes = Vec::from(MAGIC.as_slice());
        bytes.extend_from_slice(&BUNDLE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&body);
        assert!(matches!(
            Bundle::decode(&bytes),
            Err(BundleError::Invalid(_))
        ));
    }

    /// SDKs decode untrusted bytes: every mutation must be an error or a
    /// valid bundle, never a panic.
    #[test]
    fn mutated_input_never_panics() {
        let valid = sample_bundle().encode().expect("encode");
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            rng
        };
        for _ in 0..20_000 {
            let mut bytes = valid.clone();
            match next() % 3 {
                0 => {
                    let i = (next() as usize) % bytes.len();
                    bytes[i] = next() as u8;
                }
                1 => bytes.truncate((next() as usize) % bytes.len()),
                _ => {
                    let i = HEADER_LEN + (next() as usize) % (bytes.len() - HEADER_LEN);
                    bytes[i] = 0xff;
                }
            }
            let _ = Bundle::decode(&bytes);
        }
    }

    #[cfg(feature = "catalog-toml")]
    #[test]
    fn roundtrip_real_catalog() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rules");
        let bundle = Catalog::load_dir(&dir)
            .expect("rules")
            .bundle("test-rev", RuleConfig::default());
        let bytes = bundle.encode().expect("encode");
        assert_eq!(Bundle::decode(&bytes).expect("decode"), bundle);
    }
}
