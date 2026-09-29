use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/emptiness-check-without-limit";

const USAGE_TTL_MS: u64 = 5 * 60 * 1_000;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(EmptinessCheck {
        min_docs: p.u64("min_docs")?.max(2),
        queries: BoundedMap::new(USAGE_TTL_MS),
    }))
}

/// A query used only for `snapshot.empty` fetched more than one document;
/// `limit(1)` answers the same question for 1 read.
struct EmptinessCheck {
    min_docs: u64,
    queries: BoundedMap<(u64, u64), u64>,
}

impl Detector for EmptinessCheck {
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
                if !usage.read_empty || usage.read_items || usage.read_size {
                    return;
                }
                out.emit(
                    env,
                    format!(
                        "{docs} documents from `{}` were fetched only to check emptiness; use limit(1)",
                        env.target.template
                    ),
                )
                .evidence("docs", docs)
                .wasted(READS, docs - 1);
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

    #[test]
    fn empty_only_usage_is_flagged() {
        let mut e = single_rule_engine(ID, build, &[("min_docs", int(2))]);
        let usage = ResultUsage {
            read_empty: true,
            ..Default::default()
        };
        let f = run(
            &mut e,
            [
                EnvBuilder::query("invites").call_id(4).items(30).build(),
                EnvBuilder::query("invites").usage(4, usage).build(),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get(READS), 29);
    }
}
