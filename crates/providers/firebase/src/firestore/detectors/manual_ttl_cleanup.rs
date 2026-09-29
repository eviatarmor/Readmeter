use readmeter_core::{Envelope, Op, Units};
use readmeter_rules::detectors::local_hash;
use readmeter_rules::window::{BoundedMap, KeyedWindow};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/manual-ttl-cleanup";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1);
    Ok(Box::new(ManualTtlCleanup {
        min_deletes: p.u64("min_deletes")?.max(1),
        queries: BoundedMap::new(window_ms),
        deletes: KeyedWindow::new(window_ms),
    }))
}

/// An age-filter query followed by deleting the matching documents from the client.
struct ManualTtlCleanup {
    min_deletes: u64,
    /// (session, collection template hash) -> units of the age query
    queries: BoundedMap<(u64, u64), Units>,
    /// Deletes counted against the stored query.
    deletes: KeyedWindow<(u64, u64), u64>,
}

impl Detector for ManualTtlCleanup {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let session = env.ctx.session;
        if env.op == Op::Query && billed(env) {
            let Some(query) = env.query.as_ref() else {
                return;
            };
            if !query
                .filters
                .iter()
                .any(|f| matches!(f.op.as_str(), "<" | "<="))
            {
                return;
            }
            let key = (session, local_hash(env.target.template.as_str()));
            self.queries.insert(key, env.ts_ms, env.units.clone());
            self.deletes.remove(&key);
            return;
        }

        let n = deletes_in(&env.op);
        if n == 0 {
            return;
        }
        let Some(collection) = collection_template(&env.target.template) else {
            return;
        };
        let key = (session, local_hash(collection));
        if self.queries.get(&key, env.ts_ms).is_none() {
            self.deletes.remove(&key);
            return;
        }
        let total = {
            let samples = self.deletes.push(key, env.ts_ms, n);
            samples
                .iter()
                .fold(0u64, |acc, (_, d)| acc.saturating_add(*d))
        };
        if total < self.min_deletes {
            return;
        }
        let Some((_, wasted)) = self.queries.remove(&key) else {
            return;
        };
        self.deletes.remove(&key);
        let message = format!(
            "`{collection}` queried by an age filter and {total} results deleted from the client; a TTL policy deletes expired documents without the reads"
        );
        out.emit(env, message)
            .evidence("deletes", total)
            .wasted_units(&wasted);
    }
}

fn deletes_in(op: &Op) -> u64 {
    match op {
        Op::Delete => 1,
        Op::Commit { deletes, .. } => u64::from(*deletes),
        _ => 0,
    }
}

/// Parent collection of a document template.
/// `posts/{id}` is `posts`; `users/{id}/orders/{id}` is `users/{id}/orders`.
fn collection_template(template: &str) -> Option<&str> {
    let (parent, id) = template.rsplit_once('/')?;
    if !parent.is_empty() && id.starts_with('{') && id.ends_with('}') {
        Some(parent)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::FilterShape;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_deletes", int(20))],
        )
    }

    fn age_query(op: &str, ts: u64, session: u64) -> Envelope {
        EnvBuilder::query("sessions")
            .at(ts)
            .session(session)
            .with_query(|q| {
                q.filters.push(FilterShape {
                    field: "expiresAt".into(),
                    op: op.into(),
                });
            })
            .units(Units::new().with("reads", 20).with("egress_bytes", 4_000))
            .build()
    }

    fn delete(ts: u64, session: u64) -> Envelope {
        EnvBuilder::new(Op::Delete, "sessions/{id}")
            .at(ts)
            .session(session)
            .key(ts)
            .build()
    }

    #[test]
    fn collection_template_strips_the_document_segment() {
        assert_eq!(collection_template("posts/{id}"), Some("posts"));
        assert_eq!(
            collection_template("users/{id}/orders/{id}"),
            Some("users/{id}/orders")
        );
        assert_eq!(collection_template("posts"), None);
        assert_eq!(collection_template("posts/abc"), None);
        assert_eq!(collection_template("/{id}"), None);
    }

    #[test]
    fn fires_and_wastes_the_query() {
        let mut e = engine();
        let mut envs = vec![age_query("<", 1_000, 1)];
        envs.extend((0..20).map(|i| delete(1_100 + i * 50, 1)));
        let f = run(&mut e, envs);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].wasted.get("reads"), 20);
        assert_eq!(f[0].wasted.get("egress_bytes"), 4_000);
    }

    #[test]
    fn one_short_wrong_filter_and_early_deletes_do_not_fire() {
        let mut e = engine();
        let mut envs = vec![age_query("<=", 1_000, 1)];
        envs.extend((0..19).map(|i| delete(1_100 + i, 1)));
        assert!(run(&mut e, envs).is_empty());

        let mut e = engine();
        let mut envs = vec![age_query(">", 1_000, 1)];
        envs.extend((0..20).map(|i| delete(1_100 + i, 1)));
        assert!(run(&mut e, envs).is_empty());

        let mut e = engine();
        let mut envs: Vec<_> = (0..20).map(|i| delete(i, 1)).collect();
        envs.push(age_query("<", 5_000, 1));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn sessions_and_collections_do_not_mix() {
        let mut e = engine();
        let mut envs = vec![age_query("<", 1_000, 1)];
        envs.extend((0..20).map(|i| delete(1_100 + i, 2)));
        assert!(run(&mut e, envs).is_empty());

        let mut e = engine();
        let mut envs = vec![age_query("<", 1_000, 1)];
        envs.extend((0..20).map(|i| {
            EnvBuilder::new(Op::Delete, "comments/{id}")
                .at(1_100 + i)
                .key(i)
                .build()
        }));
        assert!(run(&mut e, envs).is_empty());
    }

    #[test]
    fn a_later_query_does_not_inherit_old_deletes() {
        let mut e = engine();
        let mut envs = vec![age_query("<", 0, 1)];
        envs.extend((0..10).map(|i| delete(100 + i, 1)));
        envs.push(age_query("<", 70_000, 1));
        envs.extend((0..10).map(|i| delete(70_100 + i, 1)));
        assert!(run(&mut e, envs).is_empty());
    }
}
