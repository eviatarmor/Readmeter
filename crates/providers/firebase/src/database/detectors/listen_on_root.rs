use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.database/listen-on-root";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ListenOnRoot {
        min_bytes: p.u64("min_bytes")?,
    }))
}

/// A get or value listener on `/` or a single top-level key downloads a
/// node whose size grows with the whole database.
struct ListenOnRoot {
    min_bytes: u64,
}

impl Detector for ListenOnRoot {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let watched = matches!(env.op, Op::Get | Op::Query | Op::Snapshot { initial: true });
        if !watched || !billed(env) || !root_or_top(&env.target.template) {
            return;
        }
        let bytes = env.bytes();
        if bytes < self.min_bytes {
            return;
        }
        out.emit(
            env,
            format!(
                "read of `{template}` downloaded {bytes} bytes; narrow the path or listen to a summary",
                template = env.target.template
            ),
        )
        .evidence("bytes", bytes);
    }
}

fn root_or_top(template: &str) -> bool {
    template == "/" || !template.contains('/')
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Envelope, Op};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_bytes", int(1_048_576))])
    }

    fn db(builder: EnvBuilder) -> Envelope {
        builder.provider("firebase", "database").build()
    }

    #[test]
    fn flags_large_root_and_top_level_reads() {
        let mut e = engine();
        let root = db(EnvBuilder::get("/").bytes(1_048_576));
        let top = db(EnvBuilder::new(Op::Snapshot { initial: true }, "posts").bytes(2_000_000));
        let nested = db(EnvBuilder::get("posts/{id}").bytes(2_000_000));
        let small = db(EnvBuilder::query("posts").bytes(1_000));
        let update = db(EnvBuilder::new(Op::Snapshot { initial: false }, "/").bytes(2_000_000));
        let child = db(EnvBuilder::new(Op::Other("child_added".into()), "/").bytes(2_000_000));
        let f = run(&mut e, [root, top, nested, small, update, child]);
        assert_eq!(f.len(), 2);
    }

    #[test]
    fn cache_and_errors_are_quiet() {
        let mut e = engine();
        let cached = db(EnvBuilder::get("/").bytes(2_000_000).cached());
        let failed = db(EnvBuilder::get("posts").bytes(2_000_000).error("network"));
        assert!(run(&mut e, [cached, failed]).is_empty());
    }
}
