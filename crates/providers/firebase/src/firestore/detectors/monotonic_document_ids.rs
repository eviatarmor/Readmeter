use std::hash::{DefaultHasher, Hash, Hasher};

use readmeter_core::{Envelope, Op};
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/monotonic-document-ids";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?;
    Ok(Box::new(MonotonicIds {
        min_writes: p.u64("min_writes")?.max(2) as usize,
        window: KeyedWindow::new(window_ms),
    }))
}

/// New documents keyed by timestamps or sequential numbers all land on the
/// same index range, capping write throughput and causing contention.
struct MonotonicIds {
    min_writes: usize,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for MonotonicIds {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !matches!(env.op, Op::Create | Op::Set) {
            return;
        }
        let Some(shape) = env.target.id_shape.filter(|s| s.is_monotonic()) else {
            return;
        };
        let mut h = DefaultHasher::new();
        env.target.template.hash(&mut h);
        let group = (env.ctx.session, h.finish());
        let writes = self.window.push(group, env.ts_ms, ()).len();
        if writes < self.min_writes {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "`{}` documents are created with sequential ids; use auto-generated ids",
                env.target.template
            ),
        )
        .evidence("writes", writes)
        .evidence("id_shape", format!("{shape:?}"));
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::IdShape;
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    #[test]
    fn sequential_creates_are_flagged() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[("window_ms", int(60_000)), ("min_writes", int(5))],
        );
        let seq = (0..5).map(|i| {
            EnvBuilder::new(Op::Create, "events/{id}")
                .key(i)
                .id_shape(IdShape::TimestampLike)
                .at(i)
                .build()
        });
        assert_eq!(run(&mut e, seq).len(), 1);
        let auto = (0..5).map(|i| {
            EnvBuilder::new(Op::Create, "logs/{id}")
                .id_shape(IdShape::AutoId)
                .at(i)
                .build()
        });
        assert!(run(&mut e, auto).is_empty());
    }
}
