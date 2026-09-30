use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

/// How long a query result waits for its usage report.
const USAGE_TTL_MS: u64 = 5 * 60 * 1_000;

/// Index entries per billed read for `sum()` and `average()`.
const ENTRIES_PER_READ: u64 = 1_000;

pub const ID: &str = "firebase.firestore/client-side-aggregation";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ClientSideAggregation {
        min_docs: p.u64("min_docs")?.max(1),
        min_used_ratio: p.f64("min_used_ratio")?.max(0.0),
        max_fields: p.u64("max_fields")?.max(1),
        queries: BoundedMap::new(USAGE_TTL_MS),
    }))
}

/// A large query whose caller read (nearly) every document but only one
/// numeric field of each: a sum or average computed on the client.
struct ClientSideAggregation {
    min_docs: u64,
    min_used_ratio: f64,
    max_fields: u64,
    /// (session, call id) -> documents returned
    queries: BoundedMap<(u64, u64), u64>,
}

impl Detector for ClientSideAggregation {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let id = (env.ctx.session, env.ctx.call_id);
        match env.op {
            Op::Query if billed(env) && env.items() >= self.min_docs => {
                let aggregated = env
                    .query
                    .as_ref()
                    .is_some_and(|q| !q.aggregations.is_empty());
                if !aggregated {
                    self.queries.insert(id, env.ts_ms, env.items());
                }
            }
            Op::Usage => {
                let Some(usage) = env.usage else {
                    return;
                };
                let Some(&items) = self.queries.get(&id, env.ts_ms) else {
                    return;
                };
                self.queries.remove(&id);
                let (Some(used), Some(fields)) = (usage.items_used, usage.fields_read) else {
                    return;
                };
                if !usage.read_items || !usage.fields_numeric {
                    return;
                }
                let fields = u64::from(fields);
                if fields < 1 || fields > self.max_fields {
                    return;
                }
                if (f64::from(used)) < items as f64 * self.min_used_ratio {
                    return;
                }
                let aggregate_reads = items.div_ceil(ENTRIES_PER_READ).max(1);
                let what = if fields == 1 {
                    "one numeric field".to_string()
                } else {
                    format!("{fields} numeric fields")
                };
                out.emit(
                    env,
                    format!(
                        "{items} documents from `{}` were fetched to read {what}; use sum() or average()",
                        env.target.template
                    ),
                )
                .evidence("docs", items)
                .evidence("fields_read", fields)
                .wasted(READS, items.saturating_sub(aggregate_reads));
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

    fn engine(max_fields: i64) -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("min_docs", int(50)),
                ("min_used_ratio", float(0.9)),
                ("max_fields", int(max_fields)),
            ],
        )
    }

    fn query(call: u64, items: u64) -> Envelope {
        EnvBuilder::query("orders")
            .call_id(call)
            .items(items)
            .build()
    }

    fn usage(call: u64, used: u32, fields: Option<u32>, numeric: bool) -> Envelope {
        EnvBuilder::query("orders")
            .usage(
                call,
                ResultUsage {
                    read_items: true,
                    items_used: Some(used),
                    fields_read: fields,
                    fields_numeric: numeric,
                    ..ResultUsage::default()
                },
            )
            .build()
    }

    #[test]
    fn summing_one_numeric_field_is_flagged() {
        let mut e = engine(1);
        let f = run(&mut e, [query(1, 200), usage(1, 200, Some(1), true)]);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "200 documents from `orders` were fetched to read one numeric field; use sum() or average()"
        );
        assert_eq!(f[0].evidence.get("docs"), Some(&Scalar::U64(200)));
        assert_eq!(f[0].evidence.get("fields_read"), Some(&Scalar::U64(1)));
        assert_eq!(f[0].wasted.get(READS), 199);
    }

    #[test]
    fn wasted_reads_keep_one_read_per_thousand_entries() {
        let mut e = engine(1);
        let f = run(&mut e, [query(1, 2_500), usage(1, 2_500, Some(1), true)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get(READS), 2_497);
    }

    #[test]
    fn several_fields_fire_when_allowed() {
        let mut e = engine(2);
        let f = run(&mut e, [query(1, 60), usage(1, 60, Some(2), true)]);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "60 documents from `orders` were fetched to read 2 numeric fields; use sum() or average()"
        );
    }

    #[test]
    fn ratio_just_below_the_limit_is_fine() {
        let mut e = engine(1);
        let f = run(&mut e, [query(1, 100), usage(1, 89, Some(1), true)]);
        assert!(f.is_empty());
        let f = run(&mut e, [query(2, 100), usage(2, 90, Some(1), true)]);
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn two_fields_with_max_one_do_not_fire() {
        let mut e = engine(1);
        let f = run(&mut e, [query(1, 100), usage(1, 100, Some(2), true)]);
        assert!(f.is_empty());
    }

    #[test]
    fn non_numeric_or_untracked_fields_do_not_fire() {
        let mut e = engine(1);
        let f = run(
            &mut e,
            [
                query(1, 100),
                usage(1, 100, Some(1), false),
                query(2, 100),
                usage(2, 100, None, true),
                query(3, 100),
                usage(3, 100, Some(0), true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn small_results_do_not_fire() {
        let mut e = engine(1);
        let f = run(&mut e, [query(1, 49), usage(1, 49, Some(1), true)]);
        assert!(f.is_empty());
    }

    #[test]
    fn aggregation_queries_do_not_fire() {
        let mut e = engine(1);
        let f = run(
            &mut e,
            [
                EnvBuilder::query("orders")
                    .call_id(1)
                    .items(100)
                    .with_query(|q| q.aggregations = vec!["sum".into()])
                    .build(),
                usage(1, 100, Some(1), true),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn cached_results_do_not_fire() {
        let mut e = engine(1);
        let f = run(
            &mut e,
            [
                EnvBuilder::query("orders")
                    .call_id(1)
                    .items(100)
                    .cached()
                    .build(),
                usage(1, 100, Some(1), true),
            ],
        );
        assert!(f.is_empty());
    }
}
