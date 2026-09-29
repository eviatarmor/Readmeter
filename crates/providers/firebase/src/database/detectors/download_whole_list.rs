use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.database/download-whole-list";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(DownloadWholeList {
        min_children: p.u64("min_children")?,
    }))
}

/// A list read with no `limitToFirst` / `limitToLast` returns every child.
struct DownloadWholeList {
    min_children: u64,
}

impl Detector for DownloadWholeList {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let watched = matches!(env.op, Op::Get | Op::Query | Op::Snapshot { initial: true });
        if !watched || !billed(env) {
            return;
        }
        let unlimited = env.query.as_ref().is_none_or(|q| q.limit.is_none());
        if !unlimited {
            return;
        }
        let children = env.items();
        if children < self.min_children {
            return;
        }
        out.emit(
            env,
            format!(
                "list read on `{}` returned {children} children with no limit; add limitToFirst or limitToLast",
                env.target.template
            ),
        )
        .evidence("children", children);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Envelope, Op};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_children", int(500))])
    }

    fn db(builder: EnvBuilder) -> Envelope {
        builder.provider("firebase", "database").build()
    }

    #[test]
    fn flags_unlimited_lists_only() {
        let mut e = engine();
        let whole = db(EnvBuilder::get("posts").items(500).bytes(50_000));
        let listener = db(EnvBuilder::new(Op::Snapshot { initial: true }, "posts").items(800));
        let limited = db(EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(500))
            .items(500));
        let small = db(EnvBuilder::get("tags").items(499));
        let later = db(EnvBuilder::new(Op::Snapshot { initial: false }, "posts").items(900));
        let child = db(EnvBuilder::new(Op::Other("child_added".into()), "posts").items(900));
        let f = run(&mut e, [whole, listener, limited, small, later, child]);
        assert_eq!(f.len(), 2);
    }
}
