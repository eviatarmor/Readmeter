use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/growing-document";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(GrowingDocument {
        min_doc_bytes: p.u64("min_doc_bytes")?.max(1),
        unions: BoundedMap::new(window_ms),
        reads: BoundedMap::new(window_ms),
    }))
}

/// A document that is already large and still grows via `arrayUnion`.
struct GrowingDocument {
    min_doc_bytes: u64,
    /// (session, target key) seen an `array_union` set/update
    unions: BoundedMap<(u64, u64), ()>,
    /// (session, target key) -> bytes of a large document read
    reads: BoundedMap<(u64, u64), u64>,
}

fn billed(env: &Envelope) -> bool {
    super::billed(env)
}

fn array_union(env: &Envelope) -> bool {
    env.write
        .as_ref()
        .is_some_and(|write| write.transforms.iter().any(|name| name == "array_union"))
}

fn document_target(env: &Envelope) -> bool {
    env.target.template.ends_with("{id}")
}

impl Detector for GrowingDocument {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let group = (env.ctx.session, env.target.key);
        match env.op {
            Op::Update | Op::Set if !env.outcome.is_error() && array_union(env) => {
                if let Some(&bytes) = self.reads.get(&group, env.ts_ms) {
                    self.reads.remove(&group);
                    self.unions.remove(&group);
                    emit(env, bytes, out);
                } else {
                    self.unions.insert(group, env.ts_ms, ());
                }
            }
            Op::Get | Op::Snapshot { .. }
                if billed(env) && document_target(env) && env.bytes() >= self.min_doc_bytes =>
            {
                let bytes = env.bytes();
                if self.unions.get(&group, env.ts_ms).is_some() {
                    self.unions.remove(&group);
                    self.reads.remove(&group);
                    emit(env, bytes, out);
                } else {
                    self.reads.insert(group, env.ts_ms, bytes);
                }
            }
            _ => {}
        }
    }
}

fn emit(env: &Envelope, bytes: u64, out: &mut Emitter<'_>) {
    out.emit(
        env,
        format!(
            "`{}` is {bytes} bytes and still grows with arrayUnion(); every read and listener update downloads the whole array",
            env.target.template
        ),
    )
    .evidence("doc_bytes", bytes);
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Scalar, WriteStats};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(600_000)), ("min_doc_bytes", int(262_144))],
        )
    }

    fn union(key: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Update, "profiles/{id}")
            .key(key)
            .at(at)
            .session(session)
            .write(WriteStats {
                transforms: vec!["array_union".into()],
                ..WriteStats::default()
            })
            .build()
    }

    fn got(key: u64, bytes: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::get("profiles/{id}")
            .key(key)
            .items(1)
            .bytes(bytes)
            .at(at)
            .session(session)
            .build()
    }

    #[test]
    fn union_then_large_read_fires() {
        let mut e = engine();
        let f = run(&mut e, [union(1, 1_000, 1), got(1, 262_144, 5_000, 1)]);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "`profiles/{id}` is 262144 bytes and still grows with arrayUnion(); every read and listener update downloads the whole array"
        );
        assert_eq!(f[0].evidence.get("doc_bytes"), Some(&Scalar::U64(262_144)));
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn large_read_then_union_fires() {
        let mut e = engine();
        let f = run(&mut e, [got(1, 300_000, 1_000, 1), union(1, 2_000, 1)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].evidence.get("doc_bytes"), Some(&Scalar::U64(300_000)));
    }

    #[test]
    fn small_document_does_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, [union(1, 1_000, 1), got(1, 262_143, 2_000, 1)]).is_empty());
    }

    #[test]
    fn update_without_array_union_does_not_fire() {
        let mut e = engine();
        let plain = EnvBuilder::new(Op::Update, "profiles/{id}")
            .key(1)
            .write(WriteStats::default())
            .build();
        assert!(run(&mut e, [plain, got(1, 262_144, 2_000, 1)]).is_empty());
    }

    #[test]
    fn different_document_and_sessions_do_not_fire() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                union(1, 1_000, 1),
                got(2, 262_144, 2_000, 1),
                union(1, 1_000, 2),
                got(1, 262_144, 2_000, 1),
            ],
        );
        // The last get pairs with the first union (same session and key).
        assert_eq!(f.len(), 1);
        let mut isolated = engine();
        assert!(
            run(
                &mut isolated,
                [union(1, 1_000, 1), got(1, 262_144, 2_000, 2)]
            )
            .is_empty()
        );
    }
}
