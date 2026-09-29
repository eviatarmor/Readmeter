use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/large-listener-result";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(LargeListener {
        max_docs: p.u64("max_docs")?,
    }))
}

/// A listener whose initial snapshot is large. The whole result is billed
/// again on every re-subscribe and after reconnecting from 30+ minutes
/// offline.
struct LargeListener {
    max_docs: u64,
}

impl Detector for LargeListener {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != (Op::Snapshot { initial: true }) || !billed(env) {
            return;
        }
        let docs = env.items();
        if docs < self.max_docs {
            return;
        }
        out.emit(
            env,
            format!(
                "listener on `{}` loaded {docs} documents initially; narrow it or listen to a summary document",
                env.target.template
            ),
        )
        .evidence("docs", docs);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    #[test]
    fn flags_only_large_initial_snapshots() {
        let mut e = single_rule_engine(ID, build, &[("max_docs", int(500))]);
        let big = EnvBuilder::new(Op::Snapshot { initial: true }, "msgs")
            .items(800)
            .build();
        let delta = EnvBuilder::new(Op::Snapshot { initial: false }, "msgs")
            .items(800)
            .build();
        let small = EnvBuilder::new(Op::Snapshot { initial: true }, "msgs")
            .items(10)
            .build();
        assert_eq!(run(&mut e, [big, delta, small]).len(), 1);
    }
}
