//! Cloud Storage billable units.
//!
//! Verified 2026-09-30 against
//! <https://firebase.google.com/pricing> and
//! <https://cloud.google.com/storage/pricing>.
//!
//! Legacy `*.appspot.com` buckets bill as regional Standard storage:
//! class A is $0.05 per 10,000 operations, class B is $0.004 per 10,000,
//! and downloaded data is $0.12 per GB after 1 GB/day. Prices live in
//! `pricing/firebase/storage.toml`. This table uses one regional price.
//! Dual-region and multi-region Standard class A is $0.01 per 1,000 and
//! is not encoded. `*.firebasestorage.app` buckets use Cloud Storage
//! prices directly; their no-cost quotas are monthly and regional, and
//! are not this daily free tier.
//!
//! Class A (JSON `insert`, `list`, `patch` / `update`): uploads, object
//! lists, metadata updates. A resumable upload of one object is still one
//! class A operation. `list()` is one class A. `listAll` and an
//! auto-paginated `getFiles` are one class A per page of at most 1,000
//! objects (or the caller's `maxResults`, when set). The shim may pass
//! the real page count; otherwise the count is estimated from the number
//! of returned entries. Listed prefixes count as entries because they are
//! part of the same page. Zero entries is still one class A.
//!
//! Class B (`objects.get`): object downloads, `getMetadata`, and
//! `getDownloadURL` (a metadata read; it does not transfer the object).
//! `egress_bytes` is set only on a download of the object body.
//!
//! `objects.delete` is free. `getSignedUrl` is local signing or an IAM
//! `signBlob` call, not a class A or class B storage operation, so it
//! adds no priced units.
//!
//! `stored_bytes` is an observation of an object size seen on metadata or
//! a completed upload. It is not the bucket total: summing it overcalls
//! the stock. Downloads do not emit it (egress already has the transfer
//! size). The unit is left unpriced. Failed calls and results marked
//! `from_cache` are unbilled. Storage has no local cache that zeroes the
//! bill; the flag is honored when a shim sets it.

use readmeter_core::{Envelope, Op, Units};

pub const CLASS_A: &str = "class_a";
pub const CLASS_B: &str = "class_b";
pub const EGRESS_BYTES: &str = "egress_bytes";
pub const STORED_BYTES: &str = "stored_bytes";

/// Default and maximum page size of `list` / `listAll` in
/// `@firebase/storage` 0.14.5.
pub const DEFAULT_PAGE_SIZE: u64 = 1000;

/// Extra facts that do not belong on the envelope.
#[derive(Debug, Clone, Copy, Default)]
pub struct Observed {
    /// Pages the shim counted. `None` asks billing to estimate.
    pub pages: Option<u64>,
    /// Object size in bytes, when metadata or the upload reported one.
    pub object_bytes: Option<u64>,
}

pub fn units(env: &Envelope, observed: &Observed) -> Units {
    let mut u = Units::new();
    if env.outcome.is_error() || env.from_cache() {
        return u;
    }
    match &env.op {
        Op::Other(name) if name == "upload" => {
            u.add(CLASS_A, 1);
            if let Some(n) = observed.object_bytes {
                u.add(STORED_BYTES, n);
            }
        }
        Op::Update => u.add(CLASS_A, 1),
        Op::Other(name) if name == "list" => u.add(CLASS_A, 1),
        Op::Other(name) if name == "list_all" => u.add(CLASS_A, list_pages(env, observed.pages)),
        Op::Other(name) if name == "download" => {
            u.add(CLASS_B, 1);
            u.add(EGRESS_BYTES, env.bytes());
        }
        Op::Other(name) if name == "download_url" => u.add(CLASS_B, 1),
        Op::Get => {
            u.add(CLASS_B, 1);
            if let Some(n) = observed.object_bytes {
                u.add(STORED_BYTES, n);
            }
        }
        _ => {}
    }
    u
}

fn list_pages(env: &Envelope, pages: Option<u64>) -> u64 {
    if let Some(n) = pages {
        return n.max(1);
    }
    let page_size = env
        .query
        .as_ref()
        .and_then(|q| q.limit)
        .filter(|n| *n > 0)
        .map(u64::from)
        .unwrap_or(DEFAULT_PAGE_SIZE);
    let items = env.items();
    if items == 0 {
        1
    } else {
        items.div_ceil(page_size).max(1)
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::EnvBuilder;

    use super::*;

    fn call(op: Op) -> EnvBuilder {
        EnvBuilder::new(op, "photos/a")
    }

    #[test]
    fn operations_and_egress() {
        let download = units(
            &call(Op::Other("download".into())).bytes(40).build(),
            &Observed::default(),
        );
        assert_eq!(download.get(CLASS_B), 1);
        assert_eq!(download.get(EGRESS_BYTES), 40);

        let url = units(
            &call(Op::Other("download_url".into())).build(),
            &Observed::default(),
        );
        assert_eq!(url.get(CLASS_B), 1);
        assert_eq!(url.get(EGRESS_BYTES), 0);

        let upload = units(
            &call(Op::Other("upload".into())).bytes(9).build(),
            &Observed {
                object_bytes: Some(9),
                ..Observed::default()
            },
        );
        assert_eq!(upload.get(CLASS_A), 1);
        assert_eq!(upload.get(STORED_BYTES), 9);
        assert_eq!(upload.get(EGRESS_BYTES), 0);

        assert_eq!(
            units(&call(Op::Update).build(), &Observed::default()).get(CLASS_A),
            1
        );
        assert!(units(&call(Op::Delete).build(), &Observed::default()).is_empty());
        assert!(
            units(
                &call(Op::Other("signed_url".into())).build(),
                &Observed::default()
            )
            .is_empty()
        );

        let meta = units(
            &call(Op::Get).build(),
            &Observed {
                object_bytes: Some(80),
                ..Observed::default()
            },
        );
        assert_eq!(meta.get(CLASS_B), 1);
        assert_eq!(meta.get(STORED_BYTES), 80);
        assert_eq!(meta.get(EGRESS_BYTES), 0);
    }

    #[test]
    fn list_pages_follow_the_item_count_unless_the_shim_counted() {
        let listed = EnvBuilder::new(Op::Other("list_all".into()), "photos").items(0);
        assert_eq!(units(&listed.build(), &Observed::default()).get(CLASS_A), 1);

        let page = EnvBuilder::new(Op::Other("list_all".into()), "photos").items(1000);
        assert_eq!(units(&page.build(), &Observed::default()).get(CLASS_A), 1);

        let two = EnvBuilder::new(Op::Other("list_all".into()), "photos").items(1001);
        assert_eq!(units(&two.build(), &Observed::default()).get(CLASS_A), 2);

        let limited = EnvBuilder::new(Op::Other("list_all".into()), "photos")
            .items(150)
            .with_query(|q| q.limit = Some(100));
        assert_eq!(
            units(&limited.build(), &Observed::default()).get(CLASS_A),
            2
        );

        let known = EnvBuilder::new(Op::Other("list_all".into()), "photos").items(1001);
        assert_eq!(
            units(
                &known.build(),
                &Observed {
                    pages: Some(4),
                    ..Observed::default()
                }
            )
            .get(CLASS_A),
            4
        );

        let one = units(
            &EnvBuilder::new(Op::Other("list".into()), "photos").build(),
            &Observed::default(),
        );
        assert_eq!(one.get(CLASS_A), 1);
    }

    #[test]
    fn cache_and_errors_are_free() {
        let cached = EnvBuilder::new(Op::Other("download".into()), "photos/a")
            .bytes(40)
            .cached();
        assert!(units(&cached.build(), &Observed::default()).is_empty());
        let failed = EnvBuilder::new(Op::Other("upload".into()), "photos/a")
            .bytes(40)
            .error("object-not-found");
        assert!(
            units(
                &failed.build(),
                &Observed {
                    object_bytes: Some(40),
                    ..Observed::default()
                }
            )
            .is_empty()
        );
    }
}
