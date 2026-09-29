use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/blob-in-document";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(BlobInDocument {
        min_field_bytes: p.u64("min_field_bytes")?.max(1),
    }))
}

/// A single written field is large enough that every later read downloads it.
struct BlobInDocument {
    min_field_bytes: u64,
}

impl Detector for BlobInDocument {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Create | Op::Set | Op::Update) || env.outcome.is_error() {
            return;
        }
        let Some(write) = env.write.as_ref() else {
            return;
        };
        if write.max_field_bytes < self.min_field_bytes {
            return;
        }
        let n = write.max_field_bytes;
        out.emit(
            env,
            format!(
                "a {n}-byte field was written to `{}`; every read of this document downloads it",
                env.target.template
            ),
        )
        .evidence("max_field_bytes", write.max_field_bytes)
        .evidence("payload_bytes", write.payload_bytes);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Scalar, WriteStats};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_field_bytes", int(65_536))])
    }

    fn write(op: Op, max_field_bytes: u64) -> Envelope {
        EnvBuilder::new(op, "profiles/{id}")
            .write(WriteStats {
                max_field_bytes,
                payload_bytes: max_field_bytes.saturating_add(400),
                ..Default::default()
            })
            .build()
    }

    #[test]
    fn flags_a_large_field_on_single_writes() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                write(Op::Set, 65_536),
                write(Op::Create, 70_000),
                write(Op::Update, 120_000),
            ],
        );
        assert_eq!(f.len(), 3);
        assert_eq!(
            f[0].message,
            "a 65536-byte field was written to `profiles/{id}`; every read of this document downloads it"
        );
        assert_eq!(
            f[0].evidence.get("max_field_bytes"),
            Some(&Scalar::U64(65_536))
        );
        assert_eq!(
            f[0].evidence.get("payload_bytes"),
            Some(&Scalar::U64(65_936))
        );
        assert!(f[0].wasted.is_empty());
        assert_eq!(
            f[2].evidence.get("max_field_bytes"),
            Some(&Scalar::U64(120_000))
        );
    }

    #[test]
    fn ignores_one_byte_under_and_errors() {
        let mut e = engine();
        let failed = EnvBuilder::new(Op::Set, "profiles/{id}")
            .write(WriteStats {
                max_field_bytes: 65_536,
                payload_bytes: 65_936,
                ..Default::default()
            })
            .error("unavailable")
            .build();
        let deleted = EnvBuilder::new(Op::Delete, "profiles/{id}")
            .write(WriteStats {
                max_field_bytes: 80_000,
                payload_bytes: 80_000,
                ..Default::default()
            })
            .build();
        assert!(
            run(
                &mut e,
                [
                    write(Op::Set, 65_535),
                    failed,
                    deleted,
                    write(Op::Update, 0)
                ]
            )
            .is_empty()
        );
    }
}
