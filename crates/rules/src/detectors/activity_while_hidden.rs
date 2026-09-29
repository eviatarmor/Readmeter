use readmeter_core::{Envelope, Op};

use crate::window::BoundedMap;

use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};

use super::billed;

pub const ID: &str = "generic/activity-while-hidden";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ActivityWhileHidden {
        min_hidden_ms: p.u64("min_hidden_ms")?.max(1),
        min_items: p.u64("min_items")?.max(1),
        sessions: BoundedMap::new(u64::MAX),
    }))
}

/// Billed reads that keep arriving after the tab has been hidden for a while.
struct ActivityWhileHidden {
    min_hidden_ms: u64,
    min_items: u64,
    sessions: BoundedMap<u64, Hidden>,
}

struct Hidden {
    since: u64,
    items: u64,
    /// Already reported this hidden period. Cleared when the tab is shown.
    fired: bool,
}

fn counts(env: &Envelope) -> bool {
    matches!(
        env.op,
        Op::Snapshot { .. } | Op::Get | Op::Query | Op::Aggregate
    )
}

impl Detector for ActivityWhileHidden {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        match env.op {
            Op::Page { visible: true } => {
                self.sessions.remove(&session);
            }
            Op::Page { visible: false } => {
                if self.sessions.get(&session, env.ts_ms).is_none() {
                    self.sessions.insert(
                        session,
                        env.ts_ms,
                        Hidden {
                            since: env.ts_ms,
                            items: 0,
                            fired: false,
                        },
                    );
                }
            }
            _ if counts(env) && billed(env) => {
                let (items, hidden_ms) = {
                    let Some(state) = self.sessions.get_mut(&session, env.ts_ms) else {
                        return;
                    };
                    if state.fired {
                        return;
                    }
                    state.items = state.items.saturating_add(env.items());
                    let hidden_ms = env.ts_ms.saturating_sub(state.since);
                    if state.items < self.min_items || hidden_ms < self.min_hidden_ms {
                        return;
                    }
                    let items = state.items;
                    // One finding per hidden period.
                    state.fired = true;
                    state.items = 0;
                    (items, hidden_ms)
                };
                let seconds = hidden_ms / 1_000;
                out.emit(
                    env,
                    format!(
                        "{items} items were billed while the tab was hidden for {seconds}s; pause listeners and polling on visibilitychange"
                    ),
                )
                .evidence("items", items)
                .evidence("hidden_ms", hidden_ms);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Op, Scalar};

    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[("min_hidden_ms", int(60_000)), ("min_items", int(50))],
        )
    }

    fn page(visible: bool, at: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Page { visible }, "")
            .at(at)
            .session(session)
            .build()
    }

    fn query(items: u64, at: u64, session: u64) -> Envelope {
        EnvBuilder::query("feed")
            .items(items)
            .at(at)
            .session(session)
            .build()
    }

    #[test]
    fn hidden_tab_with_enough_items_fires_once() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                page(false, 1_000, 1),
                query(50, 61_000, 1),
                query(50, 70_000, 1),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "50 items were billed while the tab was hidden for 60s; pause listeners and polling on visibilitychange"
        );
        assert_eq!(f[0].evidence.get("items"), Some(&Scalar::U64(50)));
        assert_eq!(f[0].evidence.get("hidden_ms"), Some(&Scalar::U64(60_000)));
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn visible_short_hide_and_small_results_do_not_fire() {
        let mut visible = engine();
        assert!(run(&mut visible, [page(true, 0, 1), query(50, 60_000, 1)]).is_empty());
        let mut brief = engine();
        assert!(run(&mut brief, [page(false, 0, 1), query(50, 30_000, 1)]).is_empty());
        let mut few = engine();
        assert!(run(&mut few, [page(false, 0, 1), query(49, 60_000, 1)]).is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                page(false, 0, 1),
                page(false, 0, 2),
                query(40, 60_000, 1),
                query(40, 60_000, 2),
            ],
        );
        assert!(f.is_empty());
    }
}
