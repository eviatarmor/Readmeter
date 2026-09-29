use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/fanout-writes";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(FanoutWrites {
        min_writes: p.u64("min_writes")?.max(1),
    }))
}

/// One commit that writes or deletes many documents.
struct FanoutWrites {
    min_writes: u64,
}

impl Detector for FanoutWrites {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let Op::Commit {
            writes,
            deletes,
            transactional,
        } = env.op
        else {
            return;
        };
        let n = u64::from(writes).saturating_add(u64::from(deletes));
        if n < self.min_writes {
            return;
        }
        out.emit(
            env,
            format!(
                "one commit on `{}` wrote {n} documents from a client; each user action costs {n} writes",
                env.target.template
            ),
        )
        .evidence("writes", u64::from(writes))
        .evidence("deletes", u64::from(deletes))
        .evidence("transactional", transactional);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Scalar;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_writes", int(100))])
    }

    fn commit(writes: u32, deletes: u32, transactional: bool) -> Envelope {
        EnvBuilder::new(
            Op::Commit {
                writes,
                deletes,
                transactional,
            },
            "feeds",
        )
        .build()
    }

    #[test]
    fn flags_large_commits() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                commit(80, 40, false),
                commit(100, 0, true),
                commit(0, 100, false),
            ],
        );
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].evidence.get("writes"), Some(&Scalar::U64(80)));
        assert_eq!(f[0].evidence.get("deletes"), Some(&Scalar::U64(40)));
        assert_eq!(
            f[0].evidence.get("transactional"),
            Some(&Scalar::Bool(false))
        );
        assert_eq!(
            f[0].message,
            "one commit on `feeds` wrote 120 documents from a client; each user action costs 120 writes"
        );
        assert_eq!(
            f[1].evidence.get("transactional"),
            Some(&Scalar::Bool(true))
        );
        assert_eq!(f[2].evidence.get("writes"), Some(&Scalar::U64(0)));
        assert_eq!(f[2].evidence.get("deletes"), Some(&Scalar::U64(100)));
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn ignores_smaller_commits_and_single_writes() {
        let mut e = engine();
        let set = EnvBuilder::new(Op::Set, "feeds/{id}").build();
        assert!(run(&mut e, [commit(99, 0, false), commit(50, 49, false), set]).is_empty());
    }
}
