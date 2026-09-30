use readmeter_core::{Envelope, Op};
use readmeter_rules::window::{BoundedMap, DEFAULT_MAX_KEYS};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/listener-reconnect-rebill";

/// Listeners live for hours in a long-running tab. Each snapshot refreshes
/// the entry, so this only drops listeners that went silent for a day.
const STATE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ListenerReconnectRebill {
        min_offline_ms: p.u64("min_offline_ms")?.max(1),
        min_items: p.u64("min_items")?.max(1),
        listeners: BoundedMap::with_cap(STATE_TTL_MS, DEFAULT_MAX_KEYS),
        offline: BoundedMap::with_cap(STATE_TTL_MS, DEFAULT_MAX_KEYS),
    }))
}

/// Firestore bills a listener as a new query when it reconnects after more
/// than 30 minutes offline. Fires when a session comes back online after a
/// long gap with enough initial-result documents still being listened to.
struct ListenerReconnectRebill {
    min_offline_ms: u64,
    min_items: u64,
    /// (session, listener) -> open listener
    listeners: BoundedMap<(u64, u64), Listener>,
    /// session -> ts of the first `online: false` since the last `online: true`
    offline: BoundedMap<u64, u64>,
}

/// Enough of the subscribe envelope to anchor a finding on the listener
/// that costs the most, without keeping the whole envelope.
struct Listener {
    /// Documents in the last billed initial snapshot: what a rebill re-reads.
    items: u64,
    template: String,
    key: u64,
    callsite: Option<u64>,
    callsite_label: Option<String>,
}

impl Listener {
    fn from_env(env: &Envelope) -> Self {
        Self {
            items: 0,
            template: env.target.template.clone(),
            key: env.target.key,
            callsite: env.ctx.callsite,
            callsite_label: env.ctx.callsite_label.clone(),
        }
    }
}

impl ListenerReconnectRebill {
    fn on_snapshot(&mut self, env: &Envelope, initial: bool, listener: u64) {
        let id = (env.ctx.session, listener);
        let mut state = match self.listeners.remove(&id) {
            Some((ts, state)) if env.ts_ms.saturating_sub(ts) <= STATE_TTL_MS => state,
            // Subscribe was missed (state evicted or batch lost).
            _ => Listener::from_env(env),
        };
        if initial && billed(env) {
            state.items = env.items();
        }
        // Re-insert to refresh the TTL: the listener is still alive.
        self.listeners.insert(id, env.ts_ms, state);
    }

    fn on_online(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        let Some((ts, since)) = self.offline.remove(&session) else {
            return;
        };
        if env.ts_ms.saturating_sub(ts) > STATE_TTL_MS {
            return;
        }
        let offline_ms = env.ts_ms.saturating_sub(since);
        if offline_ms < self.min_offline_ms {
            return;
        }
        let now = env.ts_ms;
        let mut listeners = 0u64;
        let mut items = 0u64;
        let mut top: Option<&Listener> = None;
        for (&(s, _), ts, l) in self.listeners.iter() {
            if s != session || now.saturating_sub(ts) > STATE_TTL_MS {
                continue;
            }
            listeners += 1;
            items = items.saturating_add(l.items);
            if top.is_none_or(|t| l.items > t.items) {
                top = Some(l);
            }
        }
        let Some(top) = top else {
            return;
        };
        if items < self.min_items {
            return;
        }
        // The online event is a host event (provider "sdk"). Anchor the
        // finding on the largest listener so it groups by its callsite.
        let mut anchor = env.clone();
        anchor.provider = "firebase".into();
        anchor.service = "firestore".into();
        anchor.target.template.clone_from(&top.template);
        anchor.target.key = top.key;
        anchor.ctx.callsite = top.callsite;
        anchor.ctx.callsite_label.clone_from(&top.callsite_label);
        let minutes = offline_ms / 60_000;
        out.emit(
            &anchor,
            format!(
                "{listeners} listeners re-read {items} documents after {minutes} minutes offline; detach listeners when the app goes to the background"
            ),
        )
        .evidence("listeners", listeners)
        .evidence("items", items)
        .evidence("offline_minutes", minutes)
        .wasted("reads", items);
    }
}

impl Detector for ListenerReconnectRebill {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        match env.op {
            Op::Connection { online: false } => {
                if self.offline.get(&session, env.ts_ms).is_none() {
                    self.offline.insert(session, env.ts_ms, env.ts_ms);
                }
            }
            Op::Connection { online: true } => self.on_online(env, out),
            Op::Subscribe if !env.outcome.is_error() => {
                let Some(listener) = env.ctx.listener else {
                    return;
                };
                self.listeners
                    .insert((session, listener), env.ts_ms, Listener::from_env(env));
            }
            Op::Snapshot { initial } if !env.outcome.is_error() => {
                if let Some(listener) = env.ctx.listener {
                    self.on_snapshot(env, initial, listener);
                }
            }
            Op::Unsubscribe => {
                if let Some(listener) = env.ctx.listener {
                    self.listeners.remove(&(session, listener));
                }
            }
            _ => {}
        }
    }

    fn host_events(&self) -> bool {
        true
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.listeners.len() + self.offline.len()
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Scalar, Units};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    const MIN: u64 = 60_000;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("min_offline_ms", int(1_800_000)), ("min_items", int(100))],
        )
    }

    /// Host event exactly as the runtime builds it: provider `sdk`.
    fn connection(online: bool, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Get, "")
            .provider("sdk", "connection")
            .connection(online)
            .at(at)
            .session(session)
            .build()
    }

    fn subscribe(listener: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Subscribe, "rooms/{id}/messages")
            .listener(listener)
            .callsite(7)
            .at(at)
            .session(session)
            .build()
    }

    fn initial(listener: u64, items: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Snapshot { initial: true }, "rooms/{id}/messages")
            .listener(listener)
            .items(items)
            .at(at)
            .session(session)
            .build()
    }

    fn unsubscribe(listener: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Unsubscribe, "rooms/{id}/messages")
            .listener(listener)
            .at(at)
            .session(session)
            .build()
    }

    fn open(listener: u64, items: u64, session: u64) -> [Envelope; 2] {
        [
            subscribe(listener, 0, session),
            initial(listener, items, 10, session),
        ]
    }

    #[test]
    fn long_offline_with_large_listeners_fires() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 80, 1).into();
        envs.extend(open(2, 40, 1));
        envs.push(connection(false, 1_000, 1));
        // Freeze after going offline: the first offline wins.
        envs.push(connection(false, 20 * MIN, 1));
        envs.push(connection(true, 1_000 + 45 * MIN, 1));
        // A second online (resume after online) does not fire again.
        envs.push(connection(true, 1_000 + 46 * MIN, 1));
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "2 listeners re-read 120 documents after 45 minutes offline; detach listeners when the app goes to the background"
        );
        assert_eq!(f[0].provider, "firebase");
        assert_eq!(f[0].service, "firestore");
        assert_eq!(f[0].template, "rooms/{id}/messages");
        assert_eq!(f[0].callsite, Some(7));
        assert_eq!(f[0].evidence.get("listeners"), Some(&Scalar::U64(2)));
        assert_eq!(f[0].evidence.get("items"), Some(&Scalar::U64(120)));
        assert_eq!(f[0].evidence.get("offline_minutes"), Some(&Scalar::U64(45)));
        assert_eq!(f[0].wasted, Units::new().with("reads", 120));
    }

    #[test]
    fn gap_just_under_threshold_does_not_fire() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 500, 1).into();
        envs.push(connection(false, 1_000, 1));
        envs.push(connection(true, 1_000 + 1_799_999, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn few_items_do_not_fire() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 99, 1).into();
        envs.push(connection(false, 1_000, 1));
        envs.push(connection(true, 1_000 + 60 * MIN, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn cached_initial_snapshot_does_not_count() {
        let mut e = engine();
        let cached = EnvBuilder::new(Op::Snapshot { initial: true }, "rooms/{id}/messages")
            .listener(1)
            .items(500)
            .cached()
            .at(10)
            .build();
        let envs = [
            subscribe(1, 0, 1),
            cached,
            connection(false, 1_000, 1),
            connection(true, 1_000 + 60 * MIN, 1),
        ];
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn listener_closed_before_offline_does_not_fire() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 500, 1).into();
        envs.push(unsubscribe(1, 500, 1));
        envs.push(connection(false, 1_000, 1));
        envs.push(connection(true, 1_000 + 60 * MIN, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn online_without_prior_offline_does_not_fire() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 500, 1).into();
        envs.push(connection(true, 60 * MIN, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        let mut envs: Vec<Envelope> = open(1, 500, 1).into();
        envs.extend(open(1, 500, 2));
        // Session 1 has listeners but never goes offline; session 2 goes
        // offline but has no listeners left.
        envs.push(unsubscribe(1, 500, 2));
        envs.push(connection(false, 1_000, 2));
        envs.push(connection(true, 1_000 + 60 * MIN, 2));
        envs.push(connection(true, 1_000 + 60 * MIN, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn state_survives_long_offline_gaps() {
        // Listeners opened hours ago still count after a 3 hour outage.
        let mut e = engine();
        let hour = 60 * MIN;
        let envs = [
            subscribe(1, 0, 1),
            initial(1, 300, 10, 1),
            connection(false, 5 * hour, 1),
            connection(true, 8 * hour, 1),
        ];
        assert_eq!(run(&mut e, envs).len(), 1);
    }

    #[test]
    fn state_is_bounded() {
        let mut e = engine();
        let n = DEFAULT_MAX_KEYS as u64 * 3;
        let envs = (0..n).flat_map(|i| {
            [
                subscribe(i, i, i % 7),
                connection(false, i, i),
                initial(i, 1, i, i % 7),
            ]
        });
        run(&mut e, envs);
        assert!(e.tracked() <= 2 * DEFAULT_MAX_KEYS);
    }
}
