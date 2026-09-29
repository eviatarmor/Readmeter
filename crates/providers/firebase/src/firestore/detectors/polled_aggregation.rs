use readmeter_core::{Envelope, Op, Units};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/polled-aggregation";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(PolledAggregation {
        min_repeats: p.u64("min_repeats")?.max(2) as usize,
        min_interval_ms: p.u64("min_interval_ms")?,
        window: KeyedWindow::new(window_ms),
    }))
}

/// The same aggregation issued on a steady interval. Aggregations cannot be listened to.
struct PolledAggregation {
    min_repeats: usize,
    min_interval_ms: u64,
    window: KeyedWindow<(u64, u64), Units>,
}

impl Detector for PolledAggregation {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Aggregate || !billed(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let (repeats, span, wasted) = {
            let samples = self.window.push(group, env.ts_ms, env.units.clone());
            if samples.len() < self.min_repeats || !spaced(samples, self.min_interval_ms) {
                return;
            }
            let repeats = samples.len();
            let span = match (samples.front(), samples.back()) {
                (Some((start, _)), Some((end, _))) => end.saturating_sub(*start),
                _ => 0,
            };
            let mut wasted = Units::new();
            for (_, units) in samples.iter().skip(1) {
                wasted.merge(units);
            }
            (repeats, span, wasted)
        };
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "aggregation on `{}` ran {repeats} times in {span} ms; aggregations cannot be listened to",
                env.target.template
            ),
        )
        .evidence("repeats", repeats)
        .evidence("window_ms", span)
        .wasted_units(&wasted);
    }
}

fn spaced(samples: &std::collections::VecDeque<(u64, Units)>, min_interval_ms: u64) -> bool {
    let mut prev = None;
    for (ts, _) in samples {
        if let Some(earlier) = prev {
            if ts.saturating_sub(earlier) < min_interval_ms {
                return false;
            }
        }
        prev = Some(*ts);
    }
    true
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(600_000)),
                ("min_repeats", int(5)),
                ("min_interval_ms", int(2_000)),
            ],
        )
    }

    fn agg(ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Aggregate, "orders")
            .at(ts)
            .session(session)
            .units(Units::new().with("reads", 2).with("egress_bytes", 8))
            .build()
    }

    #[test]
    fn fires_on_spaced_repeats_and_counts_waste_after_the_first() {
        let mut e = engine();
        let f = run(&mut e, (0..5).map(|i| agg(i * 10_000, 1)));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 8);
        assert_eq!(f[0].wasted.get("egress_bytes"), 32);
    }

    #[test]
    fn short_series_and_bursts_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..4).map(|i| agg(i * 10_000, 1))).is_empty());
        let mut e = engine();
        let burst = [0u64, 100, 10_000, 20_000, 30_000].map(|t| agg(t, 1));
        assert!(run(&mut e, burst).is_empty());
    }

    #[test]
    fn sessions_do_not_mix() {
        let mut e = engine();
        let envs = (0..5).map(|i| agg(i * 10_000, 1 + (i % 2)));
        assert!(run(&mut e, envs).is_empty());
    }
}
