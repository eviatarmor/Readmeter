use readmeter_core::Envelope;
use readmeter_rules::window::{BoundedMap, KeyedWindow};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::attr;
use super::billed;
use super::named;

pub const ID: &str = "firebase.storage/redownload-without-cache-control";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(RedownloadWithoutCacheControl {
        min_downloads: p.u64("min_downloads")?.max(1) as usize,
        window_ms,
        known: BoundedMap::new(window_ms),
        window: KeyedWindow::new(window_ms),
    }))
}

/// What this call, or an earlier call on the same object, said about caching.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheClass {
    /// Metadata was seen and it had no `max-age`.
    None,
    MaxAge,
}

/// Repeated downloads of one object whose cache policy is explicitly uncached.
///
/// A download with no cache observation does not count unless an earlier
/// call in the window (typically `getMetadata`) recorded `none`. A
/// `max-age` does not count. `getStream` and a server `File.download` are
/// the same billed download as `getBytes` / `getBlob`.
struct RedownloadWithoutCacheControl {
    min_downloads: usize,
    window_ms: u64,
    known: BoundedMap<(u64, u64), CacheClass>,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for RedownloadWithoutCacheControl {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !billed(env) {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        if let Some(class) = cache_of(env) {
            self.known.insert(group, env.ts_ms, class);
        }
        if !named(env, "download") {
            return;
        }
        let effective = cache_of(env).or_else(|| self.known.get(&group, env.ts_ms).copied());
        if effective != Some(CacheClass::None) {
            return;
        }
        let downloads = self.window.push(group, env.ts_ms, ()).len();
        if downloads < self.min_downloads {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` downloaded {downloads} times in {}ms with no max-age; set cacheControl on the object",
                env.target.template, self.window_ms
            ),
        )
        .evidence("downloads", downloads)
        .evidence("window_ms", self.window_ms);
    }
}

fn cache_of(env: &Envelope) -> Option<CacheClass> {
    match attr(env, "cache_control") {
        Some("none") => Some(CacheClass::None),
        Some(_) => Some(CacheClass::MaxAge),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Op};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("min_downloads", int(3)), ("window_ms", int(600_000))],
        )
    }

    fn download(session: u64, key: u64, ts: u64, cache: Option<&str>) -> Envelope {
        let mut b = EnvBuilder::new(Op::Other("download".into()), "files/data.bin")
            .provider("firebase", "storage")
            .session(session)
            .key(key)
            .at(ts)
            .bytes(32);
        if let Some(cache) = cache {
            b = b.with_query(|q| {
                q.filters.push(FilterShape {
                    field: "cache_control".into(),
                    op: cache.to_owned(),
                });
            });
        }
        b.build()
    }

    fn metadata(key: u64, ts: u64, cache: &str) -> Envelope {
        EnvBuilder::new(Op::Get, "files/data.bin")
            .provider("firebase", "storage")
            .key(key)
            .at(ts)
            .with_query(|q| {
                q.filters.push(FilterShape {
                    field: "cache_control".into(),
                    op: cache.to_owned(),
                });
            })
            .build()
    }

    #[test]
    fn flags_three_uncached_downloads() {
        let mut quiet = engine();
        assert!(
            run(
                &mut quiet,
                (0..2).map(|i| download(1, 1, i * 1000, Some("none")))
            )
            .is_empty()
        );
        let mut hot = engine();
        assert_eq!(
            run(
                &mut hot,
                (0..3).map(|i| download(1, 1, i * 1000, Some("none")))
            )
            .len(),
            1
        );
    }

    #[test]
    fn unknown_and_max_age_do_not_count() {
        let mut unknown = engine();
        assert!(run(&mut unknown, (0..3).map(|i| download(1, 1, i * 1000, None))).is_empty());
        let mut aged = engine();
        assert!(
            run(
                &mut aged,
                (0..3).map(|i| download(1, 1, i * 1000, Some("3600")))
            )
            .is_empty()
        );
    }

    #[test]
    fn metadata_remembers_the_cache_class() {
        let mut uncached = engine();
        let calls = std::iter::once(metadata(1, 1_000, "none"))
            .chain((0..3).map(|i| download(1, 1, 2_000 + i * 1000, None)));
        assert_eq!(run(&mut uncached, calls).len(), 1);

        let mut cached = engine();
        let calls = std::iter::once(metadata(1, 1_000, "86400"))
            .chain((0..3).map(|i| download(1, 1, 2_000 + i * 1000, None)));
        assert!(run(&mut cached, calls).is_empty());

        let mut stale = engine();
        let calls = std::iter::once(metadata(1, 0, "none"))
            .chain((0..3).map(|i| download(1, 1, 600_001 + i * 1000, None)));
        assert!(run(&mut stale, calls).is_empty());
    }

    #[test]
    fn sessions_and_objects_do_not_mix() {
        let mut sessions = engine();
        assert!(
            run(
                &mut sessions,
                (0..3).map(|i| download((i % 2) + 1, 1, i * 1000, Some("none")))
            )
            .is_empty()
        );
        let mut objects = engine();
        assert!(
            run(
                &mut objects,
                (0..3).map(|i| download(1, (i % 2) + 1, i * 1000, Some("none")))
            )
            .is_empty()
        );
    }
}
