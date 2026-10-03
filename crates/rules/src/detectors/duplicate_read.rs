use readmeter_core::{Envelope, Platform, ReadSource, Units};

use super::billed;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};
use crate::window::KeyedWindow;

pub const ID: &str = "generic/duplicate-read";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(DuplicateRead {
        min_repeats: p.u64("min_repeats")?.max(2) as usize,
        window_ms,
        window: KeyedWindow::new(window_ms),
    }))
}

/// The exact same request billed several times in a short window.
struct DuplicateRead {
    min_repeats: usize,
    window_ms: u64,
    window: KeyedWindow<(u64, u64), Units>,
}

impl Detector for DuplicateRead {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !env.op.is_read() || !billed(env) {
            return;
        }
        // Forced server reads are reported by firebase.firestore/force-server-read.
        if env.source == ReadSource::Server {
            return;
        }
        if paged_without_secret_key(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let samples = self.window.push(group, env.ts_ms, env.units.clone());
        if samples.len() < self.min_repeats {
            return;
        }
        let repeats = samples.len();
        let mut wasted = Units::new();
        for (_, units) in samples.iter().skip(1) {
            wasted.merge(units);
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "same request on `{}` billed {repeats} times within {}ms; cache or share the result",
                env.target.template, self.window_ms
            ),
        )
        .evidence("repeats", repeats)
        .evidence("window_ms", self.window_ms)
        .wasted_units(&wasted);
    }
}

/// Browser builds carry the hash key, so providers keep cursor values that
/// are not ids out of `target.key` (a timestamp cursor becomes its type).
/// Successive pages of one query can then share a key and would look like
/// the same request.
fn paged_without_secret_key(env: &Envelope) -> bool {
    matches!(env.ctx.platform, Platform::Browser | Platform::Unknown)
        && env
            .query
            .as_ref()
            .is_some_and(|q| q.start_cursor || q.end_cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    #[test]
    fn fires_with_wasted_reads() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_repeats", int(3))],
        );
        let envs = (0..3).map(|i| EnvBuilder::query("posts").items(20).at(i * 1_000).build());
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 40);
    }

    #[test]
    fn different_keys_and_cache_hits_do_not_count() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_repeats", int(3))],
        );
        let envs = (0..3)
            .map(|i| EnvBuilder::query("posts").key(i).items(1).build())
            .chain((0..3).map(|_| EnvBuilder::query("posts").cached().build()));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn forced_server_reads_are_not_duplicates() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_repeats", int(3))],
        );
        let envs = (0..3).map(|i| {
            EnvBuilder::query("posts")
                .source(readmeter_core::ReadSource::Server)
                .items(20)
                .at(i * 1_000)
                .build()
        });
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn sessions_are_isolated() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_repeats", int(3))],
        );
        let envs = (0..3).map(|s| EnvBuilder::get("u/{id}").items(1).session(s).build());
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn browser_pages_are_not_duplicates() {
        let page = |platform: Platform, i: u64| {
            let mut env = EnvBuilder::query("feed")
                .items(20)
                .at(i * 1_000)
                .platform(platform)
                .build();
            if let Some(q) = env.query.as_mut() {
                q.start_cursor = true;
            }
            env
        };
        for platform in [Platform::Browser, Platform::Unknown] {
            let mut e = single_rule_engine(
                ID,
                build,
                &[("window_ms", int(60_000)), ("min_repeats", int(3))],
            );
            assert!(run(&mut e, (0..3).map(|i| page(platform, i))).is_empty());
        }
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_repeats", int(3))],
        );
        let found = run(&mut e, (0..3).map(|i| page(Platform::Server, i)));
        assert_eq!(found.len(), 1, "server keys hold the real cursor");
    }
}
