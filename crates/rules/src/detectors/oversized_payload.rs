use readmeter_core::{Envelope, Op};

use super::billed;
use crate::config::{ParamError, Params};
use crate::detector::{Detector, Emitter};

pub const ID: &str = "generic/oversized-payload";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(Oversized {
        max_response_bytes: p.u64("max_response_bytes")?,
        max_avg_item_bytes: p.u64("max_avg_item_bytes")?,
    }))
}

/// A response, or the average item in it, is far larger than a UI needs.
struct Oversized {
    max_response_bytes: u64,
    max_avg_item_bytes: u64,
}

impl Detector for Oversized {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        let is_data = env.op.is_read() || matches!(env.op, Op::Snapshot { .. });
        if !is_data || !billed(env) {
            return;
        }
        let bytes = env.bytes();
        let items = env.items();
        let avg = bytes.checked_div(items).unwrap_or(0);
        if bytes >= self.max_response_bytes {
            out.emit(
                env,
                format!(
                    "response from `{}` is {bytes} bytes; page it or project fewer fields",
                    env.target.template
                ),
            )
            .evidence("bytes", bytes)
            .evidence("items", items);
        } else if avg >= self.max_avg_item_bytes {
            out.emit(
                env,
                format!(
                    "items in `{}` average {avg} bytes; move large fields to a separate document or storage",
                    env.target.template
                ),
            )
            .evidence("avg_item_bytes", avg)
            .evidence("items", items);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{EnvBuilder, int, run, single_rule_engine};

    fn engine() -> crate::Engine {
        single_rule_engine(
            ID,
            build,
            &[
                ("max_response_bytes", int(500_000)),
                ("max_avg_item_bytes", int(100_000)),
            ],
        )
    }

    #[test]
    fn flags_large_response_and_large_items() {
        let mut e = engine();
        let big = EnvBuilder::query("a").items(100).bytes(600_000).build();
        let fat = EnvBuilder::get("b/{id}").items(1).bytes(200_000).build();
        let ok = EnvBuilder::query("c").items(100).bytes(50_000).build();
        let f = run(&mut e, [big, fat, ok]);
        assert_eq!(f.len(), 2);
    }
}
