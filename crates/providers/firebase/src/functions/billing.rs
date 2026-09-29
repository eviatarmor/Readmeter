//! Cloud Functions billable units.
//!
//! Verified 2026-09-30 against <https://firebase.google.com/pricing> and
//! the Cloud Run request-based prices it points at for current Cloud
//! Functions (2nd gen), us-central1, active time:
//! <https://cloud.google.com/run/pricing>.
//!
//! Prices in `pricing/firebase/functions.toml`:
//! - invocations: $0.40 per 1,000,000
//! - gb_seconds: $0.0000025 per GiB-second, stored as milli-GiB-seconds
//!   (1000 units = 1 GiB-second) so a short call is not rounded to 0
//! - cpu_seconds: $0.000024 per vCPU-second, stored as milli-vCPU-seconds,
//!   and omitted when CPU is not on the envelope
//! - egress_bytes: $0.12 per 1e9 bytes (Firebase's "GB"; Cloud Run quotes
//!   GiB at the same dollar rate)
//!
//! Cloud Run rounds active time up to the next 100 ms before the milli
//! conversion. `gb_seconds = rounded_ms * memory_mb / 1024`. A client
//! callable does not bill compute: its duration includes the network.
//! Memory comes from `FUNCTION_MEMORY_MB` when the shim could read it.
//! There is no CPU environment variable in `firebase-functions` 7.4.0, so
//! CPU is billed only when the raw call carries `cpu_milli`.
//!
//! The monthly no-cost tier (2,000,000 invocations, 400,000 GB-seconds,
//! 200,000 CPU-seconds, 5 GB egress) is not `free_per_day`. Estimates are
//! marginal. Invocations are billed on errors too: a function that ran
//! and returned an error still reached the container. A client timeout
//! that never reached the function is indistinguishable and can overcount.
//! Egress is the response size, and only on success.

use readmeter_core::{Envelope, Op, Units};

pub const INVOCATIONS: &str = "invocations";
pub const GB_SECONDS: &str = "gb_seconds";
pub const CPU_SECONDS: &str = "cpu_seconds";
pub const EGRESS_BYTES: &str = "egress_bytes";

pub fn units(env: &Envelope) -> Units {
    let mut u = Units::new();
    let server = match &env.op {
        Op::Other(name) if name == "invoke" => true,
        Op::Other(name) if name == "callable" => false,
        _ => return u,
    };
    u.add(INVOCATIONS, 1);
    if !env.outcome.is_error() {
        u.add(EGRESS_BYTES, env.bytes());
    }
    if !server {
        return u;
    }
    let Some(duration_us) = env.duration_us else {
        return u;
    };
    let billed = rounded_ms(duration_us);
    if let Some(memory_mb) = filter_u64(env, "memory_mb") {
        u.add(GB_SECONDS, billed.saturating_mul(memory_mb) / 1024);
    }
    if let Some(cpu_milli) = filter_u64(env, "cpu_milli") {
        u.add(CPU_SECONDS, cpu_milli.saturating_mul(billed) / 1000);
    }
    u
}

/// Active time rounded up to 100 ms, matching Cloud Run request billing.
fn rounded_ms(duration_us: u64) -> u64 {
    if duration_us == 0 {
        return 0;
    }
    let ms = duration_us.div_ceil(1_000);
    ms.div_ceil(100).saturating_mul(100)
}

fn filter_u64(env: &Envelope, field: &str) -> Option<u64> {
    let op = env
        .query
        .as_ref()?
        .filters
        .iter()
        .find(|filter| filter.field == field)?
        .op
        .as_str();
    op.parse().ok()
}

#[cfg(test)]
mod tests {
    use readmeter_core::{FilterShape, Op};
    use readmeter_rules::testing::EnvBuilder;

    use super::*;

    fn invoke() -> EnvBuilder {
        EnvBuilder::new(Op::Other("invoke".into()), "functions/echo")
            .provider("firebase", "functions")
    }

    fn with_filter(mut builder: EnvBuilder, field: &str, op: &str) -> EnvBuilder {
        builder = builder.with_query(move |query| {
            query.filters.push(FilterShape {
                field: field.to_owned(),
                op: op.to_owned(),
            });
        });
        builder
    }

    #[test]
    fn client_bills_an_invocation_and_response_bytes_only() {
        let mut call = EnvBuilder::new(Op::Other("callable".into()), "functions/echo")
            .provider("firebase", "functions")
            .bytes(20)
            .duration_us(1_000_000);
        call = with_filter(call, "memory_mb", "256");
        let got = units(&call.build());
        assert_eq!(got.get(INVOCATIONS), 1);
        assert_eq!(got.get(EGRESS_BYTES), 20);
        assert_eq!(got.get(GB_SECONDS), 0);
        assert_eq!(got.get(CPU_SECONDS), 0);
    }

    #[test]
    fn server_compute_uses_milli_units_and_100ms_rounding() {
        let mut slow = with_filter(invoke(), "memory_mb", "256");
        slow = with_filter(slow, "cpu_milli", "1000");
        slow = slow.duration_us(1_000_000).bytes(4);
        let got = units(&slow.build());
        assert_eq!(got.get(INVOCATIONS), 1);
        assert_eq!(got.get(EGRESS_BYTES), 4);
        // 256 MiB for 1000 ms = 0.250 GiB-seconds = 250 milli-GiB-seconds.
        assert_eq!(got.get(GB_SECONDS), 250);
        assert_eq!(got.get(CPU_SECONDS), 1000);

        let mut brief = with_filter(invoke(), "memory_mb", "256");
        brief = brief.duration_us(1);
        // 1 µs rounds up to 100 ms: 100 * 256 / 1024 = 25.
        assert_eq!(units(&brief.build()).get(GB_SECONDS), 25);
        assert_eq!(rounded_ms(0), 0);
        assert_eq!(rounded_ms(100_000), 100);
        assert_eq!(rounded_ms(100_001), 200);
    }

    #[test]
    fn errors_still_bill_the_invocation_and_not_egress() {
        let mut failed = with_filter(invoke(), "memory_mb", "256");
        failed = failed.duration_us(1_000_000).bytes(99).error("internal");
        let got = units(&failed.build());
        assert_eq!(got.get(INVOCATIONS), 1);
        assert_eq!(got.get(EGRESS_BYTES), 0);
        assert_eq!(got.get(GB_SECONDS), 250);
        assert!(units(&invoke().build()).get(GB_SECONDS) == 0);
    }
}
