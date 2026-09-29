use readmeter_core::{Envelope, Op, ReadSource};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/force-server-read";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ForceServerRead {
        min_reads: p.u64("min_reads")?.max(1) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// The same target billed from the server several times, skipping the cache.
struct ForceServerRead {
    min_reads: usize,
    window_ms: u64,
    /// (session, target key) -> billed reads of that call
    window: KeyedWindow<(u64, u64), u64>,
}

impl Detector for ForceServerRead {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Get | Op::Query)
            || !billed(env)
            || env.source != ReadSource::Server
        {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let samples = self.window.push(group, env.ts_ms, env.units.get(READS));
        if samples.len() < self.min_reads {
            return;
        }
        let reads = samples.len();
        let mut wasted = 0u64;
        for (_, amount) in samples.iter().skip(1) {
            wasted = wasted.saturating_add(*amount);
        }
        self.window.remove(&group);
        let seconds = self.window_ms / 1_000;
        out.emit(
            env,
            format!(
                "`{}` was read from the server {reads} times in {seconds}s with getDocsFromServer(); the cache or a listener would serve it",
                env.target.template
            ),
        )
        .evidence("reads", reads)
        .evidence("window_ms", self.window_ms)
        .wasted(READS, wasted);
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
            &[("window_ms", int(60_000)), ("min_reads", int(3))],
        )
    }

    fn server_get(session: u64, at: u64) -> Envelope {
        EnvBuilder::get("posts/{id}")
            .source(ReadSource::Server)
            .items(1)
            .session(session)
            .at(at)
            .build()
    }

    #[test]
    fn repeated_server_reads_waste_all_but_the_first() {
        let mut e = engine();
        let f = run(
            &mut e,
            [server_get(1, 0), server_get(1, 1_000), server_get(1, 2_000)],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0].message,
            "`posts/{id}` was read from the server 3 times in 60s with getDocsFromServer(); the cache or a listener would serve it"
        );
        assert_eq!(f[0].wasted.get(READS), 2);
    }

    #[test]
    fn two_reads_do_not_fire() {
        let mut e = engine();
        assert!(run(&mut e, [server_get(1, 0), server_get(1, 1_000)]).is_empty());
    }

    #[test]
    fn default_source_does_not_fire() {
        let mut e = engine();
        let envs = (0..3).map(|i| EnvBuilder::get("posts/{id}").items(1).at(i * 1_000).build());
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = engine();
        // Two sessions, two server reads each. Neither reaches min_reads.
        let envs = [
            server_get(1, 0),
            server_get(1, 1_000),
            server_get(2, 2_000),
            server_get(2, 3_000),
        ];
        assert!(run(&mut e, envs).is_empty());
    }
}
