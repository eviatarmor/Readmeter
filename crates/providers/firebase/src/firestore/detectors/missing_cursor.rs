use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;
use crate::firestore::billing::READS;

pub const ID: &str = "firebase.firestore/missing-cursor";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(MissingCursor {
        min_pages: p.u64("min_pages")?.max(2) as usize,
        window: KeyedWindow::new(window_ms),
    }))
}

/// "Load more" implemented by growing `limit()` on the same query instead of
/// continuing from a cursor: every page re-reads all previous pages.
struct MissingCursor {
    min_pages: usize,
    /// (session, base key) -> (limit, docs)
    window: KeyedWindow<(u64, u64), (u32, u64)>,
}

impl Detector for MissingCursor {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Query | Op::Snapshot { initial: true }) || !billed(env) {
            return;
        }
        let Some(q) = env.query.as_ref() else {
            return;
        };
        let Some(limit) = q.limit else {
            return;
        };
        if q.start_cursor || q.offset.is_some() {
            return;
        }
        let group = (env.ctx.session, q.base_key);
        let samples = self.window.push(group, env.ts_ms, (limit, env.items()));

        // Length of the trailing run of strictly growing limits.
        let mut run = 1;
        for pair in samples.iter().rev().collect::<Vec<_>>().windows(2) {
            if pair[0].1.0 > pair[1].1.0 {
                run += 1;
            } else {
                break;
            }
        }
        if run < self.min_pages {
            return;
        }
        let pages: Vec<(u32, u64)> = samples
            .iter()
            .skip(samples.len() - run)
            .map(|(_, v)| *v)
            .collect();
        let reread: u64 = pages[..pages.len() - 1].iter().map(|(_, docs)| docs).sum();
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` is paginated by growing limit() ({run} pages); continue with startAfter(lastDoc)",
                env.target.template
            ),
        )
        .evidence("pages", run)
        .evidence("last_limit", limit)
        .wasted(READS, reread);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn page(limit: u32, ts: u64, cursor: bool) -> Envelope {
        EnvBuilder::query("feed")
            .with_query(|q| {
                q.limit = Some(limit);
                q.base_key = 77;
                q.start_cursor = cursor;
            })
            .key(u64::from(limit))
            .items(u64::from(limit))
            .at(ts)
            .build()
    }

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(600_000)), ("min_pages", int(3))],
        )
    }

    #[test]
    fn growing_limit_is_flagged_with_reread_docs() {
        let mut e = engine();
        let f = run(
            &mut e,
            [page(20, 0, false), page(40, 1, false), page(60, 2, false)],
        );
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get(READS), 60);
    }

    #[test]
    fn cursor_pagination_and_refetch_are_fine() {
        let mut e = engine();
        assert!(
            run(
                &mut e,
                [page(20, 0, true), page(20, 1, true), page(20, 2, true)]
            )
            .is_empty()
        );
        assert!(
            run(
                &mut e,
                [page(20, 3, false), page(20, 4, false), page(20, 5, false)]
            )
            .is_empty()
        );
    }
}
