use std::collections::HashMap;

use readmeter_core::Envelope;

use super::{billed, callsite_key, local_hash};
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::BoundedMap;

pub const ID: &str = "generic/hot-callsite";

/// Distinct (scope, unit, time-bucket) rows kept for one project.
pub const MAX_BUCKETS: usize = 8_192;
const BUCKETS_PER_WINDOW: u64 = 30;

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1_000);
    let min_total = p.u64("min_reads")?.max(1);
    Ok(Box::new(HotCallsite {
        window_ms,
        bucket_ms: (window_ms / BUCKETS_PER_WINDOW).max(1),
        min_ppm: share_ppm(p.f64("min_share")?),
        min_total,
        buckets: BoundedMap::with_cap(window_ms, MAX_BUCKETS),
    }))
}

/// One callsite's share of a project's billed units over the window.
///
/// Every unit on the envelope is summed. The finding names the unit with
/// the largest share, once that share and the project total both clear
/// the thresholds.
struct HotCallsite {
    window_ms: u64,
    bucket_ms: u64,
    /// `min_share` in parts per million, so the comparison stays integer.
    min_ppm: u64,
    min_total: u64,
    buckets: BoundedMap<BucketKey, Acc>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Scope {
    Total,
    Site(u64),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct BucketKey {
    scope: Scope,
    unit: u64,
    bucket: u64,
}

struct Acc {
    unit: String,
    amount: u64,
}

fn share_ppm(share: f64) -> u64 {
    if !share.is_finite() {
        return 1_000_000;
    }
    let scaled = share.clamp(0.0, 1.0) * 1_000_000.0;
    if scaled.is_finite() {
        scaled.round() as u64
    } else {
        1_000_000
    }
}

fn ppm(amount: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    let scaled = u128::from(amount).saturating_mul(1_000_000) / u128::from(total);
    u64::try_from(scaled).unwrap_or(u64::MAX)
}

impl HotCallsite {
    fn add(&mut self, scope: Scope, unit: &str, ts: u64, amount: u64) {
        if amount == 0 {
            return;
        }
        let key = BucketKey {
            scope,
            unit: local_hash(unit),
            bucket: ts / self.bucket_ms,
        };
        let prev = self.buckets.get(&key, ts).map(|a| a.amount).unwrap_or(0);
        self.buckets.insert(
            key,
            ts,
            Acc {
                unit: unit.to_owned(),
                amount: prev.saturating_add(amount),
            },
        );
    }

    fn sums(&self, site: u64, now: u64) -> (HashMap<String, u64>, HashMap<String, u64>) {
        let mut totals: HashMap<String, u64> = HashMap::new();
        let mut mine: HashMap<String, u64> = HashMap::new();
        for (key, ts, acc) in self.buckets.iter() {
            if now.saturating_sub(ts) > self.window_ms {
                continue;
            }
            let slot = match key.scope {
                Scope::Total => &mut totals,
                Scope::Site(id) if id == site => &mut mine,
                Scope::Site(_) => continue,
            };
            let entry = slot.entry(acc.unit.clone()).or_insert(0);
            *entry = entry.saturating_add(acc.amount);
        }
        (totals, mine)
    }
}

impl Detector for HotCallsite {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !billed(env) || env.units.is_empty() {
            return;
        }
        let site = callsite_key(env);
        for (unit, amount) in env.units.iter() {
            self.add(Scope::Total, unit, env.ts_ms, amount);
            self.add(Scope::Site(site), unit, env.ts_ms, amount);
        }
        let (totals, mine) = self.sums(site, env.ts_ms);
        let mut best: Option<(u64, u64, u64, String)> = None;
        for (unit, amount) in &mine {
            let Some(total) = totals.get(unit) else {
                continue;
            };
            if *total < self.min_total || *amount == 0 {
                continue;
            }
            let share = ppm(*amount, *total);
            if share < self.min_ppm {
                continue;
            }
            let replace = match &best {
                None => true,
                Some((best_share, best_total, _, best_unit)) => {
                    share > *best_share
                        || (share == *best_share && *total > *best_total)
                        || (share == *best_share && total == best_total && unit < best_unit)
                }
            };
            if replace {
                best = Some((share, *total, *amount, unit.clone()));
            }
        }
        let Some((share, total, amount, unit)) = best else {
            return;
        };
        self.buckets
            .retain(|key, _, _| key.scope != Scope::Site(site));
        let pct = (share / 10_000).min(100);
        out.emit(
            env,
            format!(
                "one callsite accounts for {pct}% of billed {unit} ({amount} of {total}); review caching, pagination and subscription scope"
            ),
        )
        .evidence("share", (pct as f64) / 100.0)
        .evidence("amount", amount)
        .evidence("total", total)
        .evidence("unit", unit);
    }

    #[cfg(any(test, feature = "testing"))]
    fn tracked(&self) -> usize {
        self.buckets.len()
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Units;

    use super::*;
    use crate::testing::{EnvBuilder, float, int, run, single_rule_engine};

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(3_600_000)),
                ("min_share", float(0.3)),
                ("min_reads", int(10_000)),
            ],
        )
    }

    fn reads(
        template: &str,
        session: u64,
        callsite: u64,
        n: u64,
        ts: u64,
    ) -> readmeter_core::Envelope {
        EnvBuilder::query(template)
            .session(session)
            .callsite(callsite)
            .at(ts)
            .units(Units::new().with("reads", n))
            .build()
    }

    fn unit_name(f: &readmeter_core::Finding) -> Option<&str> {
        match f.evidence.get("unit")? {
            readmeter_core::Scalar::Str(v) => Some(v.as_str()),
            _ => None,
        }
    }

    #[test]
    fn dominant_callsite_fires_once() {
        let mut e = engine();
        assert!(run(&mut e, [reads("posts", 1, 7, 3_000, 0)]).is_empty());
        let found = run(&mut e, [reads("other", 2, 8, 7_000, 1)]);
        assert_eq!(found.len(), 1);
        assert_eq!(unit_name(&found[0]), Some("reads"));
        assert_eq!(
            found[0].evidence.get("amount"),
            Some(&readmeter_core::Scalar::U64(7_000))
        );
        assert_eq!(
            found[0].evidence.get("total"),
            Some(&readmeter_core::Scalar::U64(10_000))
        );
        assert!(run(&mut e, [reads("other", 4, 8, 1, 3)]).is_empty());
    }

    #[test]
    fn just_under_the_share_stays_quiet() {
        let mut e = engine();
        // 2999/10000 is just under 30%, and no other callsite reaches 30%.
        let envs = [
            reads("a", 1, 1, 2_334, 0),
            reads("b", 2, 2, 2_334, 1),
            reads("c", 3, 3, 2_333, 2),
            reads("d", 4, 4, 2_999, 3),
        ];
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn small_project_total_stays_quiet() {
        let mut e = engine();
        assert!(run(&mut e, [reads("posts", 1, 7, 9_999, 0)]).is_empty());
    }

    #[test]
    fn reports_the_unit_with_the_larger_share() {
        let mut e = engine();
        let other = EnvBuilder::query("posts")
            .session(2)
            .callsite(8)
            .at(0)
            .units(Units::new().with("reads", 6_000).with("writes", 1_000))
            .build();
        let mixed = EnvBuilder::query("posts")
            .callsite(7)
            .at(1)
            .units(Units::new().with("reads", 4_000).with("writes", 9_000))
            .build();
        let found = run(&mut e, [other, mixed]);
        assert_eq!(found.len(), 1);
        assert_eq!(unit_name(&found[0]), Some("writes"));
        assert_eq!(
            found[0].evidence.get("amount"),
            Some(&readmeter_core::Scalar::U64(9_000))
        );
    }

    #[test]
    fn state_stays_under_the_cap() {
        let mut e = engine();
        for i in 0..MAX_BUCKETS + 32 {
            e.observe(&reads("posts", 1, i as u64, 1, 1));
        }
        assert!(e.tracked() <= MAX_BUCKETS);
        assert!(e.tracked() < MAX_BUCKETS + 32);
    }
}
