use readmeter_core::{Envelope, Op};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/offset-pagination";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(OffsetPagination {
        min_offset: p.u64("min_offset")?.max(1),
    }))
}

/// `offset(n)` bills the n skipped documents as reads.
struct OffsetPagination {
    min_offset: u64,
}

impl Detector for OffsetPagination {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Query || !billed(env) {
            return;
        }
        let offset = env
            .query
            .as_ref()
            .and_then(|q| q.offset)
            .map_or(0, u64::from);
        if offset < self.min_offset {
            return;
        }
        out.emit(
            env,
            format!(
                "offset({offset}) on `{}` bills every skipped document; paginate with startAfter()",
                env.target.template
            ),
        )
        .evidence("offset", offset)
        .wasted(READS, offset);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    #[test]
    fn offset_reads_are_wasted() {
        let mut e = single_rule_engine(ID, build, &[("min_offset", int(1))]);
        let env = EnvBuilder::query("posts")
            .with_query(|q| q.offset = Some(200))
            .items(20)
            .build();
        let f = run(&mut e, [env, EnvBuilder::query("posts").items(20).build()]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get(READS), 200);
    }
}
