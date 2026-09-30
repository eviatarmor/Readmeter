use readmeter_core::{Envelope, Op};

use super::billed;
use readmeter_rules::window::BoundedMap;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/broadcast-listener";

/// `(target key, session)` pairs kept for one project.
pub const MAX_PAIRS: usize = 4_096;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1_000);
    let min_sessions = p.u64("min_sessions")?.max(2);
    let min_sessions = usize::try_from(min_sessions).unwrap_or(usize::MAX);
    Ok(Box::new(BroadcastListener {
        window_ms,
        min_sessions,
        sessions: BoundedMap::with_cap(window_ms, MAX_PAIRS),
    }))
}

/// Many sessions subscribed to one document or query, so each change is
/// billed once per client.
struct BroadcastListener {
    window_ms: u64,
    min_sessions: usize,
    sessions: BoundedMap<(u64, u64), ()>,
}

impl BroadcastListener {
    fn live(&self, key: u64, now: u64) -> usize {
        self.sessions
            .iter()
            .filter(|((k, _), ts, _)| *k == key && now.saturating_sub(*ts) <= self.window_ms)
            .count()
    }
}

impl Detector for BroadcastListener {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if matches!(env.op, Op::Unsubscribe) {
            self.sessions.remove(&(env.target.key, env.ctx.session));
            return;
        }
        let listening =
            matches!(env.op, Op::Subscribe | Op::Snapshot { .. }) && !env.outcome.is_error();
        if listening {
            self.sessions
                .insert((env.target.key, env.ctx.session), env.ts_ms, ());
        }
        let billable =
            matches!(env.op, Op::Snapshot { initial: false }) && billed(env) && env.items() > 0;
        if !billable {
            return;
        }
        let sessions = self.live(env.target.key, env.ts_ms);
        if sessions < self.min_sessions {
            return;
        }
        let key = env.target.key;
        self.sessions.retain(|(k, _), _, _| *k != key);
        out.emit(
            env,
            format!(
                "`{}` is listened to by {sessions} clients; each change bills one read per client; fan out through a summary document or a bundle",
                env.target.template
            ),
        )
        .evidence("sessions", sessions);
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(300_000)), ("min_sessions", int(50))],
        )
    }

    fn snap(session: u64, key: u64, initial: bool, items: u64, ts: u64) -> Envelope {
        EnvBuilder::new(Op::Snapshot { initial }, "rooms/{id}/messages")
            .key(key)
            .session(session)
            .items(items)
            .at(ts)
            .build()
    }

    #[test]
    fn many_listeners_on_one_query() {
        let mut e = engine();
        let warm: Vec<_> = (1..50).map(|s| snap(s, 1, false, 1, s * 1_000)).collect();
        assert!(run(&mut e, warm).is_empty());
        let found = run(&mut e, [snap(50, 1, false, 1, 50_000)]);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].evidence.get("sessions"),
            Some(&readmeter_core::Scalar::U64(50))
        );
        assert!(found[0].message.contains("rooms/{id}/messages"));
        assert!(run(&mut e, [snap(51, 1, false, 1, 51_000)]).is_empty());
    }

    #[test]
    fn initial_snapshots_do_not_fire() {
        let mut e = engine();
        let envs = (1..=50).map(|s| snap(s, 1, true, 20, s * 1_000));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn empty_changes_do_not_fire() {
        let mut e = engine();
        let envs = (1..=50).map(|s| snap(s, 1, false, 0, s * 1_000));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn different_targets_do_not_combine() {
        let mut e = engine();
        let envs = (1..=50).map(|s| snap(s, if s <= 25 { 1 } else { 2 }, false, 1, s * 1_000));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn unsubscribe_drops_the_session() {
        let mut e = engine();
        let mut envs: Vec<_> = (1..=50).map(|s| snap(s, 1, false, 1, s * 100)).collect();
        envs.insert(
            49,
            EnvBuilder::new(Op::Unsubscribe, "rooms/{id}/messages")
                .key(1)
                .session(1)
                .at(4_950)
                .build(),
        );
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn state_stays_under_the_cap() {
        let mut e = engine();
        for i in 0..MAX_PAIRS + 32 {
            e.observe(
                &EnvBuilder::new(Op::Subscribe, "rooms/{id}/messages")
                    .key(i as u64)
                    .session(1)
                    .at(1)
                    .build(),
            );
        }
        assert!(e.tracked() <= MAX_PAIRS);
        assert!(e.tracked() < MAX_PAIRS + 32);
    }
}
