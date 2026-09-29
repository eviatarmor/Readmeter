use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::attr;
use super::billed;
use super::named;

pub const ID: &str = "firebase.storage/upload-without-resumable";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(UploadWithoutResumable {
        min_bytes: p.u64("min_bytes")?.max(1),
    }))
}

/// A single-shot upload (`uploadBytes`, `uploadString`, or a server save
/// with `resumable: false`) larger than the threshold.
struct UploadWithoutResumable {
    min_bytes: u64,
}

impl Detector for UploadWithoutResumable {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "upload") || !billed(env) || attr(env, "resumable") == Some("true") {
            return;
        }
        let bytes = env.bytes();
        if bytes <= self.min_bytes {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` uploaded {bytes} bytes without a resumable upload; use uploadBytesResumable or resumable: true",
                env.target.template
            ),
        )
        .evidence("bytes", bytes);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_bytes", int(5_242_880))])
    }

    fn upload(bytes: u64, resumable: bool) -> readmeter_core::Envelope {
        let mut b = EnvBuilder::new(Op::Other("upload".into()), "videos/clip.bin")
            .provider("firebase", "storage")
            .bytes(bytes);
        if resumable {
            b = b.with_query(|q| {
                q.filters.push(readmeter_core::FilterShape {
                    field: "resumable".into(),
                    op: "true".into(),
                });
            });
        }
        b.build()
    }

    #[test]
    fn flags_a_large_single_shot_upload() {
        let mut e = engine();
        assert!(run(&mut e, [upload(5_242_880, false)]).is_empty());
        let mut hot = engine();
        assert_eq!(run(&mut hot, [upload(5_242_881, false)]).len(), 1);
    }

    #[test]
    fn resumable_and_errors_are_quiet() {
        let mut e = engine();
        let failed = EnvBuilder::new(Op::Other("upload".into()), "videos/clip.bin")
            .provider("firebase", "storage")
            .bytes(9_000_000)
            .error("network");
        assert!(run(&mut e, [upload(9_000_000, true), failed.build()]).is_empty());
    }
}
