use readmeter_core::{Envelope, Op};

use super::billed;
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/public-data-not-bundled";

/// `(target key, session)` pairs kept for one project.
pub const MAX_PAIRS: usize = 4_096;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1_000);
    let min_sessions = p.u64("min_sessions")?.max(2);
    let min_sessions = usize::try_from(min_sessions).unwrap_or(usize::MAX);
    let mut ratio = p.f64("max_size_ratio")?;
    if !ratio.is_finite() {
        ratio = 0.0;
    }
    Ok(Box::new(PublicDataNotBundled {
        window_ms,
        min_sessions,
        max_size_ratio: ratio.clamp(0.0, 1.0),
        seen: BoundedMap::with_cap(window_ms, MAX_PAIRS),
    }))
}

/// The same query, with the same result size, read by many sessions.
/// A Firestore bundle on a CDN would serve it once.
struct PublicDataNotBundled {
    window_ms: u64,
    min_sessions: usize,
    max_size_ratio: f64,
    seen: BoundedMap<(u64, u64), u64>,
}

fn within(min: u64, max: u64, ratio: f64) -> bool {
    if max == 0 {
        return min == 0;
    }
    let slack = (max as f64 * ratio).floor();
    let slack = if slack.is_finite() && slack > 0.0 {
        slack as u64
    } else {
        0
    };
    max.saturating_sub(min) <= slack
}

impl Detector for PublicDataNotBundled {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let read = matches!(env.op, Op::Query | Op::Snapshot { initial: true }) && billed(env);
        if !read {
            return;
        }
        let key = env.target.key;
        self.seen
            .insert((key, env.ctx.session), env.ts_ms, env.bytes());
        let mut sessions = 0usize;
        let mut min_bytes = u64::MAX;
        let mut max_bytes = 0u64;
        for ((k, _), ts, bytes) in self.seen.iter() {
            if *k != key || env.ts_ms.saturating_sub(ts) > self.window_ms {
                continue;
            }
            sessions += 1;
            min_bytes = min_bytes.min(*bytes);
            max_bytes = max_bytes.max(*bytes);
        }
        if sessions < self.min_sessions || !within(min_bytes, max_bytes, self.max_size_ratio) {
            return;
        }
        self.seen.retain(|(k, _), _, _| *k != key);
        out.emit(
            env,
            format!(
                "`{}` was read by {sessions} sessions with the same result; serve it with loadBundle from Hosting or a CDN",
                env.target.template
            ),
        )
        .evidence("sessions", sessions)
        .evidence("bytes", max_bytes);
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.seen.len()
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, float, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(3_600_000)),
                ("min_sessions", int(100)),
                ("max_size_ratio", float(0.05)),
            ],
        )
    }

    fn query(session: u64, bytes: u64, ts: u64) -> Envelope {
        EnvBuilder::query("catalog")
            .key(9)
            .session(session)
            .items(10)
            .bytes(bytes)
            .at(ts)
            .build()
    }

    #[test]
    fn same_public_query_across_sessions() {
        let mut e = engine();
        let warm: Vec<_> = (1..100).map(|s| query(s, 2_000, s * 1_000)).collect();
        assert!(run(&mut e, warm).is_empty());
        let found = run(&mut e, [query(100, 2_040, 100_000)]);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].evidence.get("sessions"),
            Some(&readmeter_core::Scalar::U64(100))
        );
        assert!(run(&mut e, [query(101, 2_000, 101_000)]).is_empty());
    }

    #[test]
    fn sizes_outside_five_percent_stay_quiet() {
        let mut e = engine();
        let envs = (1..=100).map(|s| query(s, if s == 1 { 3_000 } else { 2_000 }, s * 1_000));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn ninety_nine_sessions_stay_quiet() {
        let mut e = engine();
        let envs = (1..100).map(|s| query(s, 2_000, s * 1_000));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn single_document_gets_are_not_this_rule() {
        let mut e = engine();
        let envs = (1..=100).map(|s| {
            EnvBuilder::get("catalog/{id}")
                .key(9)
                .session(s)
                .items(1)
                .bytes(2_000)
                .at(s * 1_000)
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn state_stays_under_the_cap() {
        let mut e = engine();
        for i in 0..MAX_PAIRS + 32 {
            e.observe(
                &EnvBuilder::query("catalog")
                    .key(i as u64)
                    .session(1)
                    .items(10)
                    .bytes(2_000)
                    .at(1)
                    .build(),
            );
        }
        assert!(e.tracked() <= MAX_PAIRS);
        assert!(e.tracked() < MAX_PAIRS + 32);
    }
}
