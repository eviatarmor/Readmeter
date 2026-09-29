//! Realtime Database billable units.
//!
//! Downloaded bytes are the priced unit. A successful get, query, value
//! snapshot, or child event bills `download_bytes` from the JSON size the
//! SDK observed. That size is a lower bound: the wire bill includes protocol
//! and encryption overhead the SDK never sees
//! (`https://firebase.google.com/docs/database/usage/billing`).
//!
//! `runTransaction` is a write that also downloads the current value, so an
//! update with result bytes bills those bytes too. Other writes do not.
//! Results marked `from_cache` are not billed. The SDK cannot tell a local
//! echo from a server download, so echoes are counted when the flag is unset.
//! Failed calls are unbilled.
//!
//! `connections` is an observation on `go_online` only. The SDK's automatic
//! connect is not visible here, and connections are a quota, not a price
//! (`pricing/firebase/database.toml` leaves them unpriced).

use readmeter_core::{Envelope, Op, Units};

pub const DOWNLOAD_BYTES: &str = "download_bytes";
pub const CONNECTIONS: &str = "connections";

pub fn units(env: &Envelope) -> Units {
    let mut u = Units::new();
    if env.outcome.is_error() {
        return u;
    }
    if matches!(env.op, Op::Other(ref name) if name == "go_online") {
        u.add(CONNECTIONS, 1);
    }
    if !env.from_cache() && downloads(env) {
        u.add(DOWNLOAD_BYTES, env.bytes());
    }
    u
}

fn downloads(env: &Envelope) -> bool {
    match &env.op {
        Op::Get | Op::Query | Op::Snapshot { .. } => true,
        Op::Other(name) if name.starts_with("child_") => true,
        Op::Update => env.bytes() > 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::EnvBuilder;

    use super::*;

    fn downloaded(env: Envelope) -> u64 {
        units(&env).get(DOWNLOAD_BYTES)
    }

    #[test]
    fn reads_and_snapshots_bill_json_bytes() {
        assert_eq!(
            downloaded(EnvBuilder::get("posts/{id}").bytes(40).build()),
            40
        );
        assert_eq!(downloaded(EnvBuilder::query("posts").bytes(80).build()), 80);
        assert_eq!(
            downloaded(
                EnvBuilder::new(Op::Snapshot { initial: true }, "/")
                    .bytes(12)
                    .build()
            ),
            12
        );
        assert_eq!(
            downloaded(
                EnvBuilder::new(Op::Other("child_added".into()), "posts")
                    .bytes(9)
                    .build()
            ),
            9
        );
    }

    #[test]
    fn transaction_bills_the_read_and_plain_writes_do_not() {
        assert_eq!(
            downloaded(EnvBuilder::new(Op::Update, "posts/{id}").bytes(30).build()),
            30
        );
        assert_eq!(
            downloaded(EnvBuilder::new(Op::Set, "posts/{id}").bytes(30).build()),
            0
        );
        assert_eq!(
            downloaded(EnvBuilder::new(Op::Update, "posts/{id}").build()),
            0
        );
    }

    #[test]
    fn cache_and_errors_are_free() {
        assert_eq!(
            downloaded(EnvBuilder::get("posts/{id}").bytes(40).cached().build()),
            0
        );
        assert_eq!(
            downloaded(
                EnvBuilder::get("posts/{id}")
                    .bytes(40)
                    .error("permission-denied")
                    .build()
            ),
            0
        );
    }

    #[test]
    fn go_online_counts_a_connection() {
        let u = units(&EnvBuilder::new(Op::Other("go_online".into()), "/").build());
        assert_eq!(u.get(CONNECTIONS), 1);
        assert_eq!(u.get(DOWNLOAD_BYTES), 0);
        let off = units(&EnvBuilder::new(Op::Other("go_offline".into()), "/").build());
        assert!(off.is_empty());
    }
}
