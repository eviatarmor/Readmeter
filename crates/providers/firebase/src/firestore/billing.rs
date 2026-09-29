//! Firestore billable units, per Firestore Standard edition billing rules:
//!
//! - Every query bills at least 1 read, even with no results.
//! - Documents skipped with `offset` are billed as reads.
//! - Aggregations bill 1 read per 1,000 index entries, minimum 1.
//! - A listener's initial snapshot bills every document; later snapshots bill
//!   only documents added or changed.
//! - Results served from the local cache are free.
//! - Failed calls are treated as unbilled.
//!
//! Prices per unit live in `pricing/firebase/firestore.toml`.

use readmeter_core::{Envelope, Op, Units};

pub const READS: &str = "reads";
pub const WRITES: &str = "writes";
pub const DELETES: &str = "deletes";
pub const EGRESS_BYTES: &str = "egress_bytes";

pub fn units(env: &Envelope) -> Units {
    let mut u = Units::new();
    if env.outcome.is_error() {
        return u;
    }
    let cached = env.from_cache();
    let items = env.items();
    match &env.op {
        Op::Get if !cached => u.add(READS, 1),
        Op::Query if !cached => {
            let offset = env.query.as_ref().and_then(|q| q.offset).unwrap_or(0);
            u.add(READS, items.max(1).saturating_add(u64::from(offset)));
        }
        Op::Aggregate if !cached => {
            let entries = env
                .result
                .as_ref()
                .and_then(|r| r.index_entries)
                .unwrap_or(0);
            u.add(READS, entries.div_ceil(1_000).max(1));
        }
        Op::Snapshot { initial: true } if !cached => u.add(READS, items.max(1)),
        Op::Snapshot { initial: false } if !cached => u.add(READS, items),
        Op::Create | Op::Set | Op::Update => u.add(WRITES, 1),
        Op::Delete => u.add(DELETES, 1),
        Op::Commit {
            writes, deletes, ..
        } => {
            u.add(WRITES, u64::from(*writes));
            u.add(DELETES, u64::from(*deletes));
        }
        _ => {}
    }
    if !cached && (env.op.is_read() || matches!(env.op, Op::Snapshot { .. })) {
        u.add(EGRESS_BYTES, env.bytes());
    }
    u
}

#[cfg(test)]
mod tests {
    use readmeter_core::ResultStats;
    use readmeter_rules::testing::EnvBuilder;

    use super::*;

    fn reads(env: Envelope) -> u64 {
        units(&env).get(READS)
    }

    #[test]
    fn query_min_one_read_plus_offset() {
        assert_eq!(reads(EnvBuilder::query("a").items(0).build()), 1);
        assert_eq!(reads(EnvBuilder::query("a").items(10).build()), 10);
        let with_offset = EnvBuilder::query("a")
            .items(10)
            .with_query(|q| q.offset = Some(100))
            .build();
        assert_eq!(reads(with_offset), 110);
    }

    #[test]
    fn aggregate_bills_per_thousand_entries() {
        let mut env = EnvBuilder::new(Op::Aggregate, "a").build();
        env.result = Some(ResultStats {
            index_entries: Some(2_500),
            ..Default::default()
        });
        assert_eq!(reads(env.clone()), 3);
        env.result = Some(ResultStats::default());
        assert_eq!(reads(env), 1);
    }

    #[test]
    fn cache_and_errors_are_free() {
        assert_eq!(reads(EnvBuilder::query("a").items(10).cached().build()), 0);
        assert_eq!(
            reads(
                EnvBuilder::get("a/{id}")
                    .items(1)
                    .error("unavailable")
                    .build()
            ),
            0
        );
    }

    #[test]
    fn snapshots_and_writes() {
        assert_eq!(
            reads(
                EnvBuilder::new(Op::Snapshot { initial: true }, "a")
                    .items(0)
                    .build()
            ),
            1
        );
        assert_eq!(
            reads(
                EnvBuilder::new(Op::Snapshot { initial: false }, "a")
                    .items(0)
                    .build()
            ),
            0
        );
        let commit = EnvBuilder::new(
            Op::Commit {
                writes: 3,
                deletes: 2,
                transactional: false,
            },
            "a",
        )
        .build();
        let u = units(&commit);
        assert_eq!((u.get(WRITES), u.get(DELETES)), (3, 2));
    }
}
