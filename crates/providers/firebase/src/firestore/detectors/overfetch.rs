use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

/// How long a query result waits for its usage report.
const USAGE_TTL_MS: u64 = 5 * 60 * 1_000;

pub const ID: &str = "firebase.firestore/overfetch";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(Overfetch {
        min_docs: p.u64("min_docs")?.max(1),
        max_used_ratio: p.f64("max_used_ratio")?.max(0.0),
        queries: BoundedMap::new(USAGE_TTL_MS),
    }))
}

/// A large query whose caller reads only a small fraction of the documents.
struct Overfetch {
    min_docs: u64,
    max_used_ratio: f64,
    /// (session, call id) -> documents returned
    queries: BoundedMap<(u64, u64), u64>,
}

impl Detector for Overfetch {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let id = (env.ctx.session, env.ctx.call_id);
        match env.op {
            Op::Query if billed(env) && env.items() >= self.min_docs => {
                self.queries.insert(id, env.ts_ms, env.items());
            }
            Op::Usage => {
                let Some(usage) = env.usage else {
                    return;
                };
                let Some(&items) = self.queries.get(&id, env.ts_ms) else {
                    return;
                };
                self.queries.remove(&id);
                let Some(used) = usage.items_used else {
                    return;
                };
                if !usage.read_items || used < 1 {
                    return;
                }
                let limit = items as f64 * self.max_used_ratio;
                if f64::from(used) > limit {
                    return;
                }
                let wasted = items.saturating_sub(u64::from(used));
                out.emit(
                    env,
                    format!(
                        "{items} documents from `{}` were fetched and {used} were used; filter or limit on the server",
                        env.target.template
                    ),
                )
                .evidence("docs", items)
                .evidence("docs_used", u64::from(used))
                .wasted(READS, wasted);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{ResultUsage, Scalar};
    use readmeter_rules::testing::{EnvBuilder, float, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("min_docs", int(20)), ("max_used_ratio", float(0.25))],
        )
    }

    fn usage(call: u64, items_used: Option<u32>, read_items: bool) -> Envelope {
        EnvBuilder::query("posts")
            .usage(
                call,
                ResultUsage {
                    read_items,
                    items_used,
                    ..ResultUsage::default()
                },
            )
            .build()
    }

    #[test]
    fn few_used_documents_are_flagged() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                EnvBuilder::query("posts").call_id(1).items(20).build(),
                usage(1, Some(5), true),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "20 documents from `posts` were fetched and 5 were used; filter or limit on the server"
        );
        assert_eq!(f[0].evidence.get("docs"), Some(&Scalar::U64(20)));
        assert_eq!(f[0].evidence.get("docs_used"), Some(&Scalar::U64(5)));
        assert_eq!(f[0].wasted.get(READS), 15);
    }

    #[test]
    fn ratio_just_above_the_limit_is_fine() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                EnvBuilder::query("posts").call_id(1).items(20).build(),
                usage(1, Some(6), true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn untracked_or_zero_used_does_not_fire() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                EnvBuilder::query("posts").call_id(1).items(20).build(),
                usage(1, None, true),
                EnvBuilder::query("posts").call_id(2).items(20).build(),
                usage(2, Some(0), true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                EnvBuilder::query("posts").call_id(1).items(20).build(),
                EnvBuilder::query("posts")
                    .session(2)
                    .usage(
                        1,
                        ResultUsage {
                            read_items: true,
                            items_used: Some(1),
                            ..ResultUsage::default()
                        },
                    )
                    .build(),
            ],
        );
        assert!(f.is_empty());
    }
}
