use readmeter_core::{Envelope, Op, Units};

use super::{billed, callsite_key};
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::{BoundedMap, KeyedWindow};

/// How long a read waits for its usage report.
const USAGE_TTL_MS: u64 = 5 * 60 * 1_000;

pub const ID: &str = "generic/unused-result";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(UnusedResult {
        min_unused: p.u64("min_unused")?.max(1) as usize,
        pending: BoundedMap::new(USAGE_TTL_MS),
        window: KeyedWindow::new(window_ms),
    }))
}

/// Results fetched and never accessed. The SDK reports usage about a second
/// after the result arrives, so a result read later than that counts as unused.
struct UnusedResult {
    min_unused: usize,
    /// (session, call id) -> units and callsite group of the read
    pending: BoundedMap<(u64, u64), Pending>,
    /// (session, callsite or template) -> units of unused reads
    window: KeyedWindow<(u64, u64), Units>,
}

struct Pending {
    units: Units,
    group: u64,
}

impl Detector for UnusedResult {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let id = (env.ctx.session, env.ctx.call_id);
        match env.op {
            Op::Get | Op::Query if billed(env) && env.items() >= 1 => {
                self.pending.insert(
                    id,
                    env.ts_ms,
                    Pending {
                        units: env.units.clone(),
                        group: callsite_key(env),
                    },
                );
            }
            Op::Usage => {
                let Some(usage) = env.usage else {
                    return;
                };
                let Some((_, pending)) = self.pending.remove(&id) else {
                    return;
                };
                if usage.read_items || usage.read_size || usage.read_empty {
                    return;
                }
                let group = (env.ctx.session, pending.group);
                let (unused, wasted) = {
                    let samples = self.window.push(group, env.ts_ms, pending.units);
                    if samples.len() < self.min_unused {
                        return;
                    }
                    let mut wasted = Units::new();
                    for (_, units) in samples.iter() {
                        wasted.merge(units);
                    }
                    (samples.len(), wasted)
                };
                self.window.remove(&group);
                out.emit(
                    env,
                    format!(
                        "{unused} results from `{}` were fetched and never read; remove the read or fetch on demand",
                        env.target.template
                    ),
                )
                .evidence("unused", unused)
                .wasted_units(&wasted);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};
    use readmeter_core::ResultUsage;

    use super::*;

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(600_000)), ("min_unused", int(3))],
        )
    }

    fn read(call: u64, session: u64) -> Envelope {
        EnvBuilder::query("posts")
            .call_id(call)
            .session(session)
            .callsite(4)
            .items(2)
            .units(Units::new().with("reads", 2).with("egress_bytes", 50))
            .at(call * 1_000)
            .build()
    }

    fn usage(call: u64, session: u64, read_items: bool) -> Envelope {
        EnvBuilder::query("posts")
            .session(session)
            .at(20_000 + call)
            .usage(
                call,
                ResultUsage {
                    read_items,
                    ..ResultUsage::default()
                },
            )
            .build()
    }

    #[test]
    fn three_unread_results_sum_their_units() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                read(1, 1),
                usage(1, 1, false),
                read(2, 1),
                usage(2, 1, false),
                read(3, 1),
                usage(3, 1, false),
            ],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "3 results from `posts` were fetched and never read; remove the read or fetch on demand"
        );
        assert_eq!(f[0].wasted.get("reads"), 6);
        assert_eq!(f[0].wasted.get("egress_bytes"), 150);
    }

    #[test]
    fn one_read_result_blocks_the_finding() {
        let mut e = engine();
        let f = run(
            &mut e,
            [
                read(1, 1),
                usage(1, 1, false),
                read(2, 1),
                usage(2, 1, true),
                read(3, 1),
                usage(3, 1, false),
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
                read(1, 1),
                usage(1, 1, false),
                read(2, 1),
                usage(2, 1, false),
                read(1, 2),
                usage(1, 2, false),
                read(2, 2),
                usage(2, 2, false),
            ],
        );
        assert!(f.is_empty());
    }
}
