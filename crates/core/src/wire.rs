//! Upload format: `b"RM"` magic, little-endian `u16` schema version, then a
//! postcard-encoded [`Batch`]. Only Rust encodes and decodes it (the core on
//! the client, ingest on the server), so SDK shims never touch it.

use serde::{Deserialize, Serialize};

use crate::SCHEMA_VERSION;
use crate::envelope::Envelope;
use crate::finding::Finding;

const MAGIC: &[u8; 2] = b"RM";
const HEADER_LEN: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkInfo {
    /// Package name, e.g. `@readmeter/firebase`.
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub schema: u16,
    pub sdk: SdkInfo,
    pub session: u64,
    pub sent_at_ms: u64,
    pub dropped_events: u64,
    pub dropped_findings: u64,
    pub events: Vec<Envelope>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("payload too short")]
    Truncated,
    #[error("bad magic bytes")]
    BadMagic,
    #[error("unsupported schema version {0}")]
    UnsupportedVersion(u16),
    #[error("codec error: {0}")]
    Codec(#[from] postcard::Error),
}

impl Batch {
    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        let mut out = Vec::with_capacity(HEADER_LEN + 64 * self.events.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&self.schema.to_le_bytes());
        let body = postcard::to_allocvec(self)?;
        out.extend_from_slice(&body);
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() < HEADER_LEN {
            return Err(WireError::Truncated);
        }
        if &bytes[..2] != MAGIC {
            return Err(WireError::BadMagic);
        }
        let version = u16::from_le_bytes([bytes[2], bytes[3]]);
        if version != SCHEMA_VERSION {
            return Err(WireError::UnsupportedVersion(version));
        }
        Ok(postcard::from_bytes(&bytes[HEADER_LEN..])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::*;
    use crate::finding::{Scalar, Severity};
    use crate::units::Units;

    fn sample() -> Batch {
        let event = Envelope {
            ts_ms: 1,
            provider: "firebase".into(),
            service: "firestore".into(),
            op: Op::Commit {
                writes: 3,
                deletes: 1,
                transactional: true,
            },
            target: Target {
                template: "users/{id}".into(),
                key: 7,
                id_shape: Some(IdShape::AutoId),
                collection_group: false,
            },
            query: Some(QueryShape {
                limit: Some(10),
                ..QueryShape::default()
            }),
            result: Some(ResultStats {
                items: 10,
                bytes: 1024,
                from_cache: false,
                index_entries: None,
            }),
            usage: Some(ResultUsage {
                read_items: true,
                items_used: Some(2),
                ..ResultUsage::default()
            }),
            source: ReadSource::Server,
            write: Some(WriteStats {
                max_field_bytes: 4,
                payload_bytes: 8,
                transforms: vec!["increment".into()],
                payload_key: None,
            }),
            setup: Some(ClientSetup {
                cache: CacheKind::Persistent,
                shared_tabs: true,
            }),
            outcome: Outcome::Error {
                code: "aborted".into(),
            },
            duration_us: Some(1500),
            ctx: CallContext {
                transaction: Some(3),
                ..CallContext::default()
            },
            units: Units::new().with("reads", 10),
        };
        let mut evidence = crate::map::VecMap::new();
        evidence.insert("docs", Scalar::U64(10));
        evidence.insert("ratio", Scalar::F64(0.5));
        Batch {
            schema: SCHEMA_VERSION,
            sdk: SdkInfo {
                name: "t".into(),
                version: "0".into(),
            },
            session: 9,
            sent_at_ms: 2,
            dropped_events: 0,
            dropped_findings: 0,
            events: vec![event],
            findings: vec![Finding {
                rule: "generic/x".into(),
                severity: Severity::High,
                ts_ms: 1,
                provider: "firebase".into(),
                service: "firestore".into(),
                template: "users/{id}".into(),
                session: 9,
                callsite: Some(3),
                callsite_label: Some("src/App.tsx:1:1".into()),
                message: "m".into(),
                evidence,
                wasted: Units::new().with("reads", 9),
            }],
        }
    }

    #[test]
    fn roundtrip() {
        let batch = sample();
        let bytes = batch.encode().expect("encode");
        assert_eq!(Batch::decode(&bytes).expect("decode"), batch);
    }

    #[test]
    fn rejects_bad_header() {
        assert!(matches!(Batch::decode(b"R"), Err(WireError::Truncated)));
        assert!(matches!(
            Batch::decode(b"XX\x01\x00"),
            Err(WireError::BadMagic)
        ));
        assert!(matches!(
            Batch::decode(b"RM\x09\x00"),
            Err(WireError::UnsupportedVersion(9))
        ));
    }

    /// Nothing has shipped, so a version-1 header is rejected even when the
    /// body was produced by this crate.
    #[test]
    fn rejects_schema_v1() {
        let mut bytes = sample().encode().expect("encode");
        bytes[2] = 1;
        bytes[3] = 0;
        assert!(matches!(
            Batch::decode(&bytes),
            Err(WireError::UnsupportedVersion(1))
        ));
    }

    /// Ingest decodes untrusted bytes: every mutation must be an error or a
    /// valid batch, never a panic or a huge allocation.
    #[test]
    fn mutated_input_never_panics() {
        let valid = sample().encode().expect("encode");
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
            let _ = Batch::decode(&bytes);
        }
    }
}
