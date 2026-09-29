use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/unbounded-list";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(UnboundedList {
        min_docs: p.u64("min_docs")?,
    }))
}

/// Query or listener with no `limit()`: reads grow with the collection.
struct UnboundedList {
    min_docs: u64,
}

impl Detector for UnboundedList {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let is_list = matches!(env.op, Op::Query | Op::Snapshot { initial: true });
        let Some(q) = env.query.as_ref() else {
            return;
        };
        if !is_list || !billed(env) || q.limit.is_some() || !q.aggregations.is_empty() {
            return;
        }
        let docs = env.items();
        if docs < self.min_docs {
            return;
        }
        out.emit(
            env,
            format!(
                "unbounded {} on `{}` returned {docs} documents; add limit() and paginate",
                if env.op == Op::Query {
                    "query"
                } else {
                    "listener"
                },
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
    fn flags_large_unlimited_reads_only() {
        let mut e = single_rule_engine(ID, build, &[("min_docs", int(100))]);
        let unlimited = EnvBuilder::query("posts").items(500).build();
        let limited = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(500))
            .items(500)
            .build();
        let small = EnvBuilder::query("tags").items(20).build();
        let listener = EnvBuilder::new(Op::Snapshot { initial: true }, "posts")
            .with_query(|_| {})
            .items(300)
            .build();
        let count = EnvBuilder::new(Op::Aggregate, "posts")
            .with_query(|q| q.aggregations = vec!["count".into()])
            .items(1)
            .build();
        let f = run(&mut e, [unlimited, limited, small, listener, count]);
        assert_eq!(f.len(), 2);
    }
}
