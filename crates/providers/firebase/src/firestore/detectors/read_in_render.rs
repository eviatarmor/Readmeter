use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/read-in-render";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ReadInRender {
        min_reads: p.u64("min_reads")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Billed reads the SDK saw inside a React render, repeated from one place.
struct ReadInRender {
    min_reads: usize,
    window_ms: u64,
    /// (session, callsite or target) -> billed reads of each call
    window: KeyedWindow<(u64, u8, u64), u64>,
}

impl Detector for ReadInRender {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !env.ctx.in_render
            || !matches!(env.op, Op::Get | Op::Query | Op::Aggregate)
            || !billed(env)
        {
            return;
        }
        // Without a callsite, repeats of the same request are the best proxy
        // for "the same line in the component body".
        let group = match env.ctx.callsite {
            Some(c) => (env.ctx.session, 1, c),
            None => (env.ctx.session, 0, env.target.key),
        };
        let (reads, wasted) = {
            let samples = self.window.push(group, env.ts_ms, env.units.get("reads"));
            if samples.len() < self.min_reads {
                return;
            }
            let wasted: u64 = samples.iter().skip(1).map(|(_, r)| *r).sum();
            (samples.len(), wasted)
        };
        // Reset so one render loop yields one finding per window, not one per call.
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{reads} reads on `{}` issued during render within {} ms; each render bills the read again",
                env.target.template, self.window_ms
            ),
        )
        .evidence("reads", reads)
        .evidence("window_ms", self.window_ms)
        .wasted("reads", wasted);
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
            &[("window_ms", int(10_000)), ("min_reads", int(3))],
        )
    }

    fn render_get(ts: u64, callsite: u64) -> EnvBuilder {
        EnvBuilder::get("users/{id}")
            .items(1)
            .at(ts)
            .callsite(callsite)
            .in_render()
    }

    #[test]
    fn fires_once_with_reads_beyond_the_first_wasted() {
        let mut e = engine();
        let f = run(&mut e, (0..4).map(|i| render_get(i * 100, 7).build()));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].evidence.get("reads"), Some(&Scalar::U64(3)));
        assert_eq!(f[0].wasted.get("reads"), 2);
    }

    #[test]
    fn counts_billed_query_and_aggregate_reads() {
        let mut e = engine();
        let envs = (0..3).map(|i| {
            EnvBuilder::query("messages")
                .items(5)
                .at(i * 100)
                .callsite(9)
                .in_render()
                .build()
        });
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 10);

        let mut e = engine();
        let envs = (0..3).map(|i| {
            EnvBuilder::new(Op::Aggregate, "messages")
                .items(1)
                .at(i * 100)
                .in_render()
                .build()
        });
        assert_eq!(run(&mut e, envs).len(), 1);
    }

    #[test]
    fn one_short_of_min_reads_does_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..2).map(|i| render_get(i * 100, 7).build())).is_empty());
    }

    #[test]
    fn reads_outside_render_do_not_fire() {
        let mut e = engine();
        let envs = (0..5).map(|i| {
            EnvBuilder::get("users/{id}")
                .items(1)
                .at(i * 100)
                .callsite(7)
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn reads_spread_beyond_the_window_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, (0..5).map(|i| render_get(i * 6_000, 7).build())).is_empty());
    }

    #[test]
    fn callsites_and_sessions_do_not_mix() {
        let mut e = engine();
        let envs = (0..4).map(|i| render_get(i * 100, 1 + (i % 2)).build());
        assert!(run(&mut e, envs).is_empty());
        let mut e = engine();
        let envs = (0..4).map(|i| render_get(i * 100, 7).session(1 + (i % 2)).build());
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn cache_hits_and_errors_are_not_billed() {
        let mut e = engine();
        let envs = (0..5).map(|i| render_get(i * 100, 7).cached().build());
        assert!(run(&mut e, envs).is_empty());
        let mut e = engine();
        let envs = (0..5).map(|i| render_get(i * 100, 7).error("unavailable").build());
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn writes_in_render_do_not_count() {
        let mut e = engine();
        let envs = (0..5).map(|i| {
            EnvBuilder::new(Op::Set, "users/{id}")
                .at(i * 100)
                .callsite(7)
                .in_render()
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }
}
