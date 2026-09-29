use std::collections::HashSet;

use readmeter_core::{Envelope, Op};

use super::{billed, local_hash};
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::KeyedWindow;

pub const ID: &str = "generic/n-plus-one";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(NPlusOne {
        min_calls: p.u64("min_calls")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// Many distinct single-item reads on one template in a short burst.
struct NPlusOne {
    min_calls: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), u64>,
}

impl Detector for NPlusOne {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if env.op != Op::Get || !billed(env) {
            return;
        }
        let group = (env.ctx.session, local_hash(&env.target.template));
        let samples = self.window.push(group, env.ts_ms, env.target.key);
        let distinct: HashSet<u64> = samples.iter().map(|(_, k)| *k).collect();
        if distinct.len() < self.min_calls {
            return;
        }
        let calls = samples.len();
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "{calls} single-item reads on `{}` within {}ms; fetch them with one query",
                env.target.template, self.window_ms
            ),
        )
        .evidence("calls", calls)
        .evidence("distinct_items", distinct.len())
        .evidence("window_ms", self.window_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    #[test]
    fn fires_on_burst_of_distinct_gets() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(1000)), ("min_calls", int(5))],
        );
        let envs = (0..5).map(|i| {
            EnvBuilder::get("users/{id}")
                .key(i)
                .items(1)
                .at(i * 10)
                .build()
        });
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rule, ID);
    }

    #[test]
    fn ignores_repeats_slow_reads_and_cache() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(1000)), ("min_calls", int(5))],
        );
        let same = (0..10).map(|i| EnvBuilder::get("users/{id}").key(1).items(1).at(i).build());
        assert!(run(&mut e, same).is_empty());
        let slow = (0..10).map(|i| {
            EnvBuilder::get("a/{id}")
                .key(i)
                .items(1)
                .at(i * 2_000)
                .build()
        });
        assert!(run(&mut e, slow).is_empty());
        let cached = (0..10).map(|i| EnvBuilder::get("b/{id}").key(i).cached().at(i).build());
        assert!(run(&mut e, cached).is_empty());
    }
}
