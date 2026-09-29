use std::collections::HashSet;

use readmeter_core::{Envelope, Op, Units};
use readmeter_rules::detectors::callsite_key;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/query-per-keystroke";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(QueryPerKeystroke {
        min_distinct: p.u64("min_distinct")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Same query shape, new filter values, from one callsite inside the window.
struct QueryPerKeystroke {
    min_distinct: usize,
    window_ms: u64,
    /// (session, fingerprint, callsite) -> (target key, units)
    window: KeyedWindow<(u64, u64, u64), (u64, Units)>,
}

impl Detector for QueryPerKeystroke {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Query | Op::Subscribe) || !billed(env) {
            return;
        }
        let Some(query) = env.query.as_ref() else {
            return;
        };
        if query.filters.is_empty() {
            return;
        }
        let group = (env.ctx.session, query.fingerprint, callsite_key(env));
        let (distinct, wasted) = {
            let samples = self
                .window
                .push(group, env.ts_ms, (env.target.key, env.units.clone()));
            let mut seen = HashSet::new();
            for (_, (key, _)) in samples.iter() {
                seen.insert(*key);
            }
            if seen.len() < self.min_distinct {
                return;
            }
            let mut wasted = Units::new();
            let keep = samples.len().saturating_sub(1);
            for (_, (_, units)) in samples.iter().take(keep) {
                wasted.merge(units);
            }
            (seen.len(), wasted)
        };
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{distinct} queries with the same shape and different values on `{}` within {} ms from one callsite; typing issues a query per keystroke",
                env.target.template, self.window_ms
            ),
        )
        .evidence("distinct_queries", distinct)
        .evidence("window_ms", self.window_ms)
        .wasted_units(&wasted);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Scalar};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(3_000)), ("min_distinct", int(4))],
        )
    }

    fn search(key: u64, ts: u64, session: u64, callsite: u64) -> EnvBuilder {
        EnvBuilder::query("users")
            .key(key)
            .at(ts)
            .session(session)
            .callsite(callsite)
            .with_query(|q| {
                q.fingerprint = 42;
                q.filters.push(FilterShape {
                    field: "name".into(),
                    op: ">=".into(),
                });
            })
            .units(Units::new().with("reads", 2).with("egress_bytes", 100))
    }

    #[test]
    fn fires_on_distinct_values_and_wastes_every_sample_but_the_last() {
        let mut e = engine();
        let f = run(&mut e, (0..4).map(|i| search(i, i * 80, 1, 7).build()));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].evidence.get("distinct_queries"), Some(&Scalar::U64(4)));
        assert_eq!(f[0].wasted.get("reads"), 6);
        assert_eq!(f[0].wasted.get("egress_bytes"), 300);
    }

    #[test]
    fn identical_keys_and_one_short_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..4).map(|i| search(1, i * 80, 1, 7).build())).is_empty());
        let mut e = engine();
        assert!(run(&mut e, (0..3).map(|i| search(i, i * 80, 1, 7).build())).is_empty());
        let mut e = engine();
        let unfiltered = (0..4).map(|i| {
            EnvBuilder::query("users")
                .key(i)
                .at(i * 10)
                .callsite(7)
                .with_query(|q| q.fingerprint = 42)
                .items(1)
                .build()
        });
        assert!(run(&mut e, unfiltered).is_empty());
    }

    #[test]
    fn sessions_and_callsites_do_not_mix() {
        let mut e = engine();
        let split = (0..4).map(|i| search(i, i * 80, 1 + (i % 2), 7).build());
        assert!(run(&mut e, split).is_empty());
        let mut e = engine();
        let callsites = (0..4).map(|i| search(i, i * 80, 1, 1 + (i % 2)).build());
        assert!(run(&mut e, callsites).is_empty());
    }

    #[test]
    fn subscribes_with_a_filter_count() {
        let mut e = engine();
        let subs = (0..4).map(|i| {
            EnvBuilder::new(Op::Subscribe, "users")
                .key(i)
                .at(i * 40)
                .callsite(7)
                .with_query(|q| {
                    q.fingerprint = 42;
                    q.filters.push(FilterShape {
                        field: "name".into(),
                        op: ">=".into(),
                    });
                })
                .build()
        });
        assert_eq!(run(&mut e, subs).len(), 1);
    }

    #[test]
    fn cached_queries_do_not_count() {
        let mut e = engine();
        let cached = (0..4).map(|i| search(i, i * 80, 1, 7).cached().build());
        assert!(run(&mut e, cached).is_empty());
    }
}
