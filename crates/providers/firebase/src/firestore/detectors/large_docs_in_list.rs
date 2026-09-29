use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::EGRESS_BYTES;

pub const ID: &str = "firebase.firestore/large-docs-in-list";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(LargeDocsInList {
        min_docs: p.u64("min_docs")?.max(1),
        max_avg_doc_bytes: p.u64("max_avg_doc_bytes")?.max(1),
        upper_avg_doc_bytes: p.u64("upper_avg_doc_bytes")?.max(1),
    }))
}

/// List whose documents average more than a row needs. Averages at or above
/// `generic/oversized-payload`'s item cap are left to that rule.
struct LargeDocsInList {
    min_docs: u64,
    max_avg_doc_bytes: u64,
    upper_avg_doc_bytes: u64,
}

impl Detector for LargeDocsInList {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let is_list = matches!(env.op, Op::Query | Op::Snapshot { initial: true });
        if !is_list || !billed(env) {
            return;
        }
        let docs = env.items();
        if docs < self.min_docs {
            return;
        }
        let bytes = env.bytes();
        let Some(avg) = bytes.checked_div(docs) else {
            return;
        };
        if avg < self.max_avg_doc_bytes || avg >= self.upper_avg_doc_bytes {
            return;
        }
        let allowance = docs.saturating_mul(self.max_avg_doc_bytes);
        let extra = bytes.saturating_sub(allowance);
        out.emit(
            env,
            format!(
                "documents in list `{}` average {avg} bytes; the web SDK always downloads whole documents",
                env.target.template
            ),
        )
        .evidence("docs", docs)
        .evidence("avg_doc_bytes", avg)
        .evidence("bytes", bytes)
        .wasted(EGRESS_BYTES, extra);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Scalar;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("min_docs", int(10)),
                ("max_avg_doc_bytes", int(20_480)),
                ("upper_avg_doc_bytes", int(102_400)),
            ],
        )
    }

    fn list(template: &str, docs: u64, bytes: u64) -> EnvBuilder {
        EnvBuilder::query(template)
            .with_query(|q| q.limit = Some(20))
            .items(docs)
            .bytes(bytes)
    }

    #[test]
    fn flags_lists_of_fat_documents() {
        let mut e = engine();
        let docs: u64 = 12;
        let bytes = docs * 30_000;
        let query = list("articles", docs, bytes).build();
        let snap = EnvBuilder::new(Op::Snapshot { initial: true }, "articles")
            .with_query(|q| q.limit = Some(20))
            .items(10)
            .bytes(10 * 102_399)
            .build();
        let f = run(&mut e, [query, snap]);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].evidence.get("docs"), Some(&Scalar::U64(docs)));
        assert_eq!(
            f[0].evidence.get("avg_doc_bytes"),
            Some(&Scalar::U64(30_000))
        );
        assert_eq!(f[0].evidence.get("bytes"), Some(&Scalar::U64(bytes)));
        assert_eq!(f[0].wasted.get(EGRESS_BYTES), bytes - docs * 20_480);
        assert_eq!(
            f[0].message,
            "documents in list `articles` average 30000 bytes; the web SDK always downloads whole documents"
        );
        // Just under oversized-payload's average, so this rule still owns it.
        assert_eq!(
            f[1].evidence.get("avg_doc_bytes"),
            Some(&Scalar::U64(102_399))
        );
        assert_eq!(f[1].wasted.get(EGRESS_BYTES), 10 * 102_399 - 10 * 20_480);
    }

    #[test]
    fn ignores_smaller_docs_and_the_oversized_band() {
        let mut e = engine();
        let just_under = list("articles", 10, 10 * 20_479).build();
        let at_upper = list("articles", 10, 10 * 102_400).build();
        let few = list("articles", 9, 9 * 80_000).build();
        let cached = list("articles", 12, 12 * 30_000).cached().build();
        let delta = EnvBuilder::new(Op::Snapshot { initial: false }, "articles")
            .items(12)
            .bytes(12 * 30_000)
            .build();
        assert!(run(&mut e, [just_under, at_upper, few, cached, delta]).is_empty());
    }
}
