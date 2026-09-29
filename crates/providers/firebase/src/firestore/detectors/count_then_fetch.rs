use readmeter_core::{Envelope, Op, Units};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/count-then-fetch";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(CountThenFetch {
        window_ms,
        counts: BoundedMap::new(window_ms),
    }))
}

/// A count aggregation followed by a fetch of the same query inside the window.
struct CountThenFetch {
    window_ms: u64,
    /// (session, query base key) -> units of the count
    counts: BoundedMap<(u64, u64), Units>,
}

impl Detector for CountThenFetch {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        match env.op {
            Op::Aggregate if billed(env) => {
                let Some(query) = env.query.as_ref() else {
                    return;
                };
                if !query.aggregations.iter().any(|kind| kind == "count") {
                    return;
                }
                self.counts
                    .insert((session, query.base_key), env.ts_ms, env.units.clone());
            }
            Op::Query if billed(env) => {
                let Some(query) = env.query.as_ref() else {
                    return;
                };
                if !query.aggregations.is_empty() {
                    return;
                }
                let group = (session, query.base_key);
                let Some((ts, units)) = self.counts.remove(&group) else {
                    return;
                };
                let gap = env.ts_ms.saturating_sub(ts);
                if gap > self.window_ms {
                    return;
                }
                out.emit(
                    env,
                    format!(
                        "`{}` counted with count() and then fetched; `snapshot.size` of the fetch already has the count",
                        env.target.template
                    ),
                )
                .evidence("gap_ms", gap)
                .wasted_units(&units);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("window_ms", int(5_000))])
    }

    fn count(base: u64, ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Aggregate, "tasks")
            .session(session)
            .at(ts)
            .with_query(|q| {
                q.base_key = base;
                q.aggregations.push("count".into());
            })
            .units(Units::new().with("reads", 1).with("egress_bytes", 16))
            .build()
    }

    fn fetch(base: u64, ts: u64, session: u64) -> Envelope {
        EnvBuilder::query("tasks")
            .session(session)
            .at(ts)
            .with_query(|q| q.base_key = base)
            .items(12)
            .build()
    }

    #[test]
    fn fires_when_the_fetch_follows_count() {
        let mut e = engine();
        let f = run(&mut e, [count(11, 1_000, 1), fetch(11, 2_500, 1)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 1);
        assert_eq!(f[0].wasted.get("egress_bytes"), 16);
    }

    #[test]
    fn late_fetch_and_different_query_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, [count(11, 1_000, 1), fetch(11, 1_000 + 5_001, 1)]).is_empty());
        let mut e = engine();
        assert!(run(&mut e, [count(11, 1_000, 1), fetch(12, 2_000, 1)]).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        assert!(run(&mut e, [count(11, 1_000, 1), fetch(11, 2_000, 2)]).is_empty());
    }
}
