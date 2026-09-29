use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/expensive-aggregation";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ExpensiveAggregation {
        min_index_entries: p.u64("min_index_entries")?.max(1),
    }))
}

/// Aggregation whose index scan costs many reads on every call.
struct ExpensiveAggregation {
    min_index_entries: u64,
}

impl Detector for ExpensiveAggregation {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Aggregate || !billed(env) {
            return;
        }
        let entries = env
            .result
            .as_ref()
            .and_then(|r| r.index_entries)
            .unwrap_or(0);
        if entries < self.min_index_entries {
            return;
        }
        let reads = env.units.get(READS);
        out.emit(
            env,
            format!(
                "`{}` aggregation scanned {entries} index entries ({reads} reads) per call; keep a counter document or cache the value",
                env.target.template
            ),
        )
        .evidence("index_entries", entries)
        .evidence("reads", reads);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Outcome, ResultStats, Scalar, Units};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("min_index_entries", int(50_000))])
    }

    /// Billed aggregate. `reads` follows the 1-read-per-1,000-entries rule.
    fn scanned(entries: u64) -> Envelope {
        let mut env = EnvBuilder::new(Op::Aggregate, "posts")
            .with_query(|q| q.aggregations = vec!["count".into()])
            .build();
        env.result = Some(ResultStats {
            items: 1,
            bytes: 16,
            from_cache: false,
            index_entries: Some(entries),
        });
        let reads = entries.div_ceil(1_000).max(1);
        env.units = Units::new().with(READS, reads).with("egress_bytes", 16);
        env
    }

    #[test]
    fn flags_large_index_scans() {
        let mut e = engine();
        let f = run(&mut e, [scanned(50_000), scanned(120_000)]);
        assert_eq!(f.len(), 2);
        assert_eq!(
            f[0].evidence.get("index_entries"),
            Some(&Scalar::U64(50_000))
        );
        assert_eq!(f[0].evidence.get("reads"), Some(&Scalar::U64(50)));
        assert_eq!(
            f[0].message,
            "`posts` aggregation scanned 50000 index entries (50 reads) per call; keep a counter document or cache the value"
        );
        assert_eq!(f[1].evidence.get("reads"), Some(&Scalar::U64(120)));
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn ignores_smaller_cached_and_failed_scans() {
        let mut e = engine();
        let mut cached = scanned(120_000);
        if let Some(result) = cached.result.as_mut() {
            result.from_cache = true;
        }
        cached.units = Units::new();
        let mut failed = scanned(120_000);
        failed.outcome = Outcome::Error {
            code: "unavailable".into(),
        };
        assert!(run(&mut e, [scanned(49_999), cached, failed]).is_empty());
    }
}
