use readmeter_core::{Envelope, Op, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/unused-projection";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(UnusedProjection {
        min_docs: p.u64("min_docs")?,
        min_avg_doc_bytes: p.u64("min_avg_doc_bytes")?,
    }))
}

/// Server SDKs can `select()` fields; fetching whole large documents
/// pays egress and memory for fields that are not used.
struct UnusedProjection {
    min_docs: u64,
    min_avg_doc_bytes: u64,
}

impl Detector for UnusedProjection {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Query || env.ctx.platform != Platform::Server || !billed(env) {
            return;
        }
        let Some(q) = env.query.as_ref() else {
            return;
        };
        if q.projection.is_some() || !q.aggregations.is_empty() {
            return;
        }
        let docs = env.items();
        if docs < self.min_docs {
            return;
        }
        let avg = env.bytes() / docs.max(1);
        if avg < self.min_avg_doc_bytes {
            return;
        }
        out.emit(
            env,
            format!(
                "server query on `{}` fetched {docs} full documents (~{avg} bytes each); select() only the fields used",
                env.target.template
            ),
        )
        .evidence("docs", docs)
        .evidence("avg_doc_bytes", avg);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    #[test]
    fn server_only_large_docs_without_select() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("min_docs", int(10)), ("min_avg_doc_bytes", int(4_096))],
        );
        let q = || EnvBuilder::query("reports").items(50).bytes(50 * 10_000);
        let server = q().platform(Platform::Server).build();
        let browser = q().platform(Platform::Browser).build();
        let selected = q()
            .platform(Platform::Server)
            .with_query(|s| s.projection = Some(vec!["title".into()]))
            .build();
        assert_eq!(run(&mut e, [server, browser, selected]).len(), 1);
    }
}
