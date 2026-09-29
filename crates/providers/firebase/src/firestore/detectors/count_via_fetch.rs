use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/count-via-fetch";

/// How long a query result waits for its usage report.
const USAGE_TTL_MS: u64 = 5 * 60 * 1_000;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(CountViaFetch {
        min_docs: p.u64("min_docs")?,
        queries: BoundedMap::new(USAGE_TTL_MS),
    }))
}

/// Documents fetched only to read `snapshot.size`; `count()` bills
/// 1 read per 1,000 index entries instead of 1 per document.
struct CountViaFetch {
    min_docs: u64,
    /// (session, call id) -> docs returned
    queries: BoundedMap<(u64, u64), u64>,
}

impl Detector for CountViaFetch {
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
                let Some(&docs) = self.queries.get(&id, env.ts_ms) else {
                    return;
                };
                self.queries.remove(&id);
                if !usage.read_size || usage.read_items {
                    return;
                }
                let count_cost = docs.div_ceil(1_000).max(1);
                out.emit(
                    env,
                    format!(
                        "{docs} documents from `{}` were fetched only to count them; use count()",
                        env.target.template
                    ),
                )
                .evidence("docs", docs)
                .wasted(READS, docs.saturating_sub(count_cost));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::ResultUsage;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn usage(call: u64, read_items: bool) -> Envelope {
        EnvBuilder::query("orders")
            .usage(
                call,
                ResultUsage {
                    read_size: true,
                    read_items,
                    read_empty: false,
                    items_used: None,
                },
            )
            .build()
    }

    #[test]
    fn size_only_usage_is_flagged() {
        let mut e = single_rule_engine(ID, build, &[("min_docs", int(10))]);
        let f = run(
            &mut e,
            [
                EnvBuilder::query("orders").call_id(1).items(2_500).build(),
                usage(1, false),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get(READS), 2_497);
    }

    #[test]
    fn iterating_docs_is_fine() {
        let mut e = single_rule_engine(ID, build, &[("min_docs", int(10))]);
        let f = run(
            &mut e,
            [
                EnvBuilder::query("orders").call_id(1).items(50).build(),
                usage(1, true),
            ],
        );
        assert!(f.is_empty());
    }
}
