use readmeter_core::{Envelope, Op};

use super::billed;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::KeyedWindow;

pub const ID: &str = "generic/polling-instead-of-subscription";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let min_samples = p.u64("min_samples")?.max(3) as usize;
    let max_interval_ms = p.u64("max_interval_ms")?;
    Ok(Box::new(Polling {
        min_samples,
        min_interval_ms: p.u64("min_interval_ms")?,
        max_interval_ms,
        max_jitter_ratio: p.f64("max_jitter_ratio")?,
        window: KeyedWindow::new(max_interval_ms.saturating_mul(min_samples as u64)),
    }))
}

/// The same request re-issued on a steady timer.
struct Polling {
    min_samples: usize,
    min_interval_ms: u64,
    max_interval_ms: u64,
    max_jitter_ratio: f64,
    window: KeyedWindow<(u64, u64), u64>,
}

impl Detector for Polling {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        // count()/sum() cannot be listened to; polled-aggregation reports those.
        if matches!(env.op, Op::Aggregate) || !env.op.is_read() || !billed(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let reads = env.units.get("reads");
        let samples = self.window.push(group, env.ts_ms, reads);
        if samples.len() < self.min_samples {
            return;
        }
        let recent: Vec<(u64, u64)> = samples
            .iter()
            .skip(samples.len() - self.min_samples)
            .copied()
            .collect();
        let intervals: Vec<f64> = recent
            .windows(2)
            .map(|w| w[1].0.saturating_sub(w[0].0) as f64)
            .collect();
        let n = intervals.len() as f64;
        let mean = intervals.iter().sum::<f64>() / n;
        if mean < self.min_interval_ms as f64 || mean > self.max_interval_ms as f64 {
            return;
        }
        let variance = intervals.iter().map(|i| (i - mean).powi(2)).sum::<f64>() / n;
        let jitter = variance.sqrt() / mean;
        if jitter > self.max_jitter_ratio {
            return;
        }
        let wasted: u64 = recent.iter().skip(1).map(|(_, r)| r).sum();
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` is re-read every ~{}ms; use a realtime subscription or cache with a TTL",
                env.target.template,
                mean.round() as u64
            ),
        )
        .evidence("polls", self.min_samples)
        .evidence("mean_interval_ms", mean.round() as u64)
        .evidence("jitter_ratio", jitter)
        .wasted("reads", wasted);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;

    use super::*;
    use crate::testing::{EnvBuilder, float, int, run, single_rule_engine};

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("min_samples", int(5)),
                ("min_interval_ms", int(1_000)),
                ("max_interval_ms", int(300_000)),
                ("max_jitter_ratio", float(0.2)),
            ],
        )
    }

    #[test]
    fn fires_on_steady_interval() {
        let mut e = engine();
        let envs = (0..5).map(|i| {
            EnvBuilder::query("feed")
                .items(10)
                .at(i * 30_000 + (i % 2) * 500)
                .build()
        });
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 40);
    }

    #[test]
    fn ignores_polled_aggregates() {
        let mut e = engine();
        let envs = (0..5).map(|i| {
            EnvBuilder::new(Op::Aggregate, "orders")
                .items(1)
                .at(i * 30_000)
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn ignores_irregular_and_too_fast() {
        let mut e = engine();
        let irregular = [0u64, 1_000, 50_000, 52_000, 200_000]
            .map(|t| EnvBuilder::query("feed").items(1).at(t).build());
        assert!(run(&mut e, irregular).is_empty());
        let fast = (0..5).map(|i| EnvBuilder::query("fast").items(1).at(i * 100).build());
        assert!(run(&mut e, fast).is_empty());
    }
}
