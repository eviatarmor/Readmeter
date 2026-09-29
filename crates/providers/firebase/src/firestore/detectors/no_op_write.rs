use readmeter_core::{Envelope, Op};
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use crate::firestore::billing::WRITES;

pub const ID: &str = "firebase.firestore/no-op-write";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(NoOpWrite {
        min_repeats: p.u64("min_repeats")?.max(1),
        last: BoundedMap::new(window_ms),
    }))
}

/// A document written again with the same payload as the previous write.
struct NoOpWrite {
    min_repeats: u64,
    /// (session, target key) -> previous payload key and no-op count
    last: BoundedMap<(u64, u64), (Option<u64>, u64)>,
}

impl Detector for NoOpWrite {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Set | Op::Update | Op::Create) || env.outcome.is_error() {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let payload = env.write.as_ref().and_then(|write| write.payload_key);
        let prev = self.last.get(&group, env.ts_ms).copied();
        if let Some((previous, repeats)) = prev
            && payload.is_some()
            && payload == previous
        {
            let repeats = repeats.saturating_add(1);
            if repeats >= self.min_repeats {
                self.last.remove(&group);
                out.emit(
                    env,
                    format!(
                        "`{}` was written {repeats} times with data identical to its previous write; each costs a write",
                        env.target.template
                    ),
                )
                .evidence("repeats", repeats)
                .wasted(WRITES, repeats);
                return;
            }
            self.last.insert(group, env.ts_ms, (payload, repeats));
            return;
        }
        self.last.insert(group, env.ts_ms, (payload, 0));
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Scalar, WriteStats};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(600_000)), ("min_repeats", int(2))],
        )
    }

    fn wrote(key: Option<u64>, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Set, "drafts/{id}")
            .at(at)
            .session(session)
            .write(WriteStats {
                payload_key: key,
                ..WriteStats::default()
            })
            .build()
    }

    #[test]
    fn identical_rewrites_waste_the_repeats() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                wrote(Some(7), 0, 1),
                wrote(Some(7), 8_000, 1),
                wrote(Some(7), 16_000, 1),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "`drafts/{id}` was written 2 times with data identical to its previous write; each costs a write"
        );
        assert_eq!(f[0].evidence.get("repeats"), Some(&Scalar::U64(2)));
        assert_eq!(f[0].wasted.get(WRITES), 2);
    }

    #[test]
    fn alternating_payloads_do_not_fire() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                wrote(Some(1), 0, 1),
                wrote(Some(2), 8_000, 1),
                wrote(Some(1), 16_000, 1),
                wrote(Some(2), 24_000, 1),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn missing_payload_key_does_not_fire() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                wrote(None, 0, 1),
                wrote(None, 8_000, 1),
                wrote(None, 16_000, 1),
            ],
        );
        assert!(f.is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                wrote(Some(7), 0, 1),
                wrote(Some(7), 8_000, 1),
                wrote(Some(7), 0, 2),
                wrote(Some(7), 8_000, 2),
            ],
        );
        assert!(f.is_empty());
    }
}
