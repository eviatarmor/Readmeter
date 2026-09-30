use std::collections::HashSet;

use readmeter_core::Envelope;
use readmeter_rules::window::{DEFAULT_MAX_KEYS, KeyedWindow};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/multi-client-write-hotspot";

/// Document keys remembered for one project.
pub const MAX_DOCS: usize = DEFAULT_MAX_KEYS;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1_000);
    let min_sessions = p.u64("min_sessions")?.max(2);
    let min_sessions = usize::try_from(min_sessions).unwrap_or(usize::MAX);
    let mut rate = p.f64("max_writes_per_sec")?;
    if !rate.is_finite() || rate <= 0.0 {
        rate = 1.0;
    }
    // One more write than the sustained rate allows, same formula as
    // `write-hotspot`, counted across sessions.
    let raw = (rate * window_ms as f64 / 1_000.0).floor();
    let threshold = if raw.is_finite() && raw > 0.0 && raw < usize::MAX as f64 {
        (raw as usize).saturating_add(1)
    } else if raw >= usize::MAX as f64 {
        usize::MAX
    } else {
        2
    };
    let threshold = threshold.max(2);
    let max_samples = threshold.clamp(64, 1_024);
    Ok(Box::new(MultiClientWriteHotspot {
        window_ms,
        min_sessions,
        rate,
        threshold,
        writes: KeyedWindow::with_caps(window_ms, MAX_DOCS, max_samples),
    }))
}

/// One document written by many sessions faster than Firestore's sustained
/// per-document rate. Each session can stay under `write-hotspot`.
struct MultiClientWriteHotspot {
    window_ms: u64,
    min_sessions: usize,
    rate: f64,
    threshold: usize,
    writes: KeyedWindow<u64, u64>,
}

impl Detector for MultiClientWriteHotspot {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !env.op.is_single_write() {
            return;
        }
        let key = env.target.key;
        let samples = self.writes.push(key, env.ts_ms, env.ctx.session);
        let n = samples.len();
        if n < self.threshold {
            return;
        }
        let sessions = samples
            .iter()
            .map(|(_, s)| *s)
            .collect::<HashSet<_>>()
            .len();
        if sessions < self.min_sessions {
            return;
        }
        self.writes.remove(&key);
        let rate = if (self.rate - self.rate.round()).abs() < f64::EPSILON {
            format!("{}", self.rate.round() as u64)
        } else {
            format!("{:.1}", self.rate)
        };
        out.emit(
            env,
            format!(
                "`{}` written {n} times in {}ms by {sessions} sessions (limit ~{rate}/s); shard the document or batch updates in a Cloud Function",
                env.target.template, self.window_ms
            ),
        )
        .evidence("writes", n)
        .evidence("sessions", sessions)
        .evidence("window_ms", self.window_ms);
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.writes.len()
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, float, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(60_000)),
                ("min_sessions", int(10)),
                ("max_writes_per_sec", float(1.0)),
            ],
        )
    }

    fn writes(sessions: u64, each: u64) -> Vec<Envelope> {
        let mut out = Vec::new();
        for session in 1..=sessions {
            for i in 0..each {
                out.push(
                    EnvBuilder::new(Op::Update, "counters/{id}")
                        .session(session)
                        .at(session * 100 + i * 8_000)
                        .build(),
                );
            }
        }
        out
    }

    #[test]
    fn many_sessions_together_exceed_the_rate() {
        let mut e = engine();
        let found = run(&mut e, writes(10, 7));
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].evidence.get("sessions"),
            Some(&readmeter_core::Scalar::U64(10))
        );
        assert!(found[0].wasted.is_empty());
        assert!(run(&mut e, writes(1, 1)).is_empty());
    }

    #[test]
    fn nine_sessions_stay_quiet() {
        let mut e = engine();
        assert!(run(&mut e, writes(9, 7)).is_empty());
    }

    #[test]
    fn under_the_rate_stays_quiet() {
        let mut e = engine();
        // 10 sessions * 6 writes = 60, one under the 61-write threshold.
        assert!(run(&mut e, writes(10, 6)).is_empty());
    }

    #[test]
    fn state_stays_under_the_cap() {
        let mut e = engine();
        for i in 0..MAX_DOCS + 32 {
            e.observe(
                &EnvBuilder::new(Op::Update, "counters/{id}")
                    .key(i as u64)
                    .session(1)
                    .at(1)
                    .build(),
            );
        }
        assert!(e.tracked() <= MAX_DOCS);
        assert!(e.tracked() < MAX_DOCS + 32);
    }
}
