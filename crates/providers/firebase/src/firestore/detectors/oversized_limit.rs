use readmeter_core::{Envelope, Op, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::billed;

pub const ID: &str = "firebase.firestore/oversized-limit";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(OversizedLimit {
        max_limit: p.u64("max_limit")?.max(1),
        min_docs: p.u64("min_docs")?.max(1),
    }))
}

/// Client list with a `limit()` far larger than one screen of results.
struct OversizedLimit {
    max_limit: u64,
    min_docs: u64,
}

impl Detector for OversizedLimit {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let is_page = matches!(env.op, Op::Query | Op::Snapshot { initial: true });
        if !is_page || !billed(env) || env.ctx.platform == Platform::Server {
            return;
        }
        // No limit is `unbounded-list`. This rule only flags an explicit one.
        let Some(limit) = env.query.as_ref().and_then(|q| q.limit) else {
            return;
        };
        let limit = u64::from(limit);
        if limit < self.max_limit {
            return;
        }
        let docs = env.items();
        if docs < self.min_docs {
            return;
        }
        out.emit(
            env,
            format!(
                "limit({limit}) on `{}` returned {docs} documents in one read; a UI rarely shows more than a page",
                env.target.template
            ),
        )
        .evidence("limit", limit)
        .evidence("docs", docs);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Scalar;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(
            ID,
            build,
            &[("max_limit", int(500)), ("min_docs", int(200))],
        )
    }

    #[test]
    fn flags_client_pages_far_above_a_screen() {
        let mut e = engine();
        let query = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(1_000))
            .items(800)
            .platform(Platform::Browser)
            .build();
        let listener = EnvBuilder::new(Op::Snapshot { initial: true }, "inbox")
            .with_query(|q| q.limit = Some(500))
            .items(200)
            .platform(Platform::Mobile)
            .build();
        let f = run(&mut e, [query, listener]);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].evidence.get("limit"), Some(&Scalar::U64(1_000)));
        assert_eq!(f[0].evidence.get("docs"), Some(&Scalar::U64(800)));
        assert_eq!(
            f[0].message,
            "limit(1000) on `posts` returned 800 documents in one read; a UI rarely shows more than a page"
        );
        assert_eq!(f[1].evidence.get("limit"), Some(&Scalar::U64(500)));
        assert_eq!(f[1].evidence.get("docs"), Some(&Scalar::U64(200)));
        assert!(f[0].wasted.is_empty());
    }

    #[test]
    fn ignores_near_limits_servers_and_unbounded() {
        let mut e = engine();
        let near = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(499))
            .items(499)
            .platform(Platform::Browser)
            .build();
        let server = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(5_000))
            .items(5_000)
            .platform(Platform::Server)
            .build();
        let unbounded = EnvBuilder::query("posts")
            .items(5_000)
            .platform(Platform::Browser)
            .build();
        let short = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(500))
            .items(199)
            .platform(Platform::Browser)
            .build();
        let delta = EnvBuilder::new(Op::Snapshot { initial: false }, "posts")
            .with_query(|q| q.limit = Some(1_000))
            .items(400)
            .platform(Platform::Browser)
            .build();
        let cached = EnvBuilder::query("posts")
            .with_query(|q| q.limit = Some(1_000))
            .items(800)
            .platform(Platform::Browser)
            .cached()
            .build();
        assert!(run(&mut e, [near, server, unbounded, short, delta, cached]).is_empty());
    }
}
