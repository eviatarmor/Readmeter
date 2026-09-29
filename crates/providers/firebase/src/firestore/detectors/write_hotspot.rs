use readmeter_core::Envelope;
use readmeter_rules::window::KeyedWindow;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

pub const ID: &str = "firebase.firestore/write-hotspot";

pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError> {
    let window_ms = p.u64("window_ms")?.max(1_000);
    let rate = p.f64("max_writes_per_sec")?;
    let threshold = (rate * window_ms as f64 / 1_000.0).floor() as usize + 1;
    Ok(Box::new(WriteHotspot {
        window_ms,
        rate,
        threshold: threshold.max(2),
        window: KeyedWindow::new(window_ms),
    }))
}

/// One document written faster than Firestore's sustained ~1 write/sec per
/// document: contention, retries and failed writes.
///
/// This sees one session only. Hotspots caused by many clients writing the
/// same document are an aggregate rule on the backend.
struct WriteHotspot {
    window_ms: u64,
    rate: f64,
    threshold: usize,
    window: KeyedWindow<(u64, u64), ()>,
}

impl Detector for WriteHotspot {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !env.op.is_single_write() {
            return;
        }
        let group = (env.ctx.session, env.target.key);
        let writes = self.window.push(group, env.ts_ms, ()).len();
        if writes < self.threshold {
            return;
        }
        self.window.remove(&group);
        out.emit(
            env,
            format!(
                "one `{}` document written {writes} times in {}ms (limit ~{} /s); shard the counter or batch updates",
                env.target.template, self.window_ms, self.rate
            ),
        )
        .evidence("writes", writes)
        .evidence("window_ms", self.window_ms);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::Op;
    use readmeter_rules::testing::{EnvBuilder, float, int, run, single_rule_engine};

    use super::*;

    #[test]
    fn sustained_writes_to_one_doc() {
        let mut e = single_rule_engine(
            ID,
            build,
            &[
                ("window_ms", int(10_000)),
                ("max_writes_per_sec", float(1.0)),
            ],
        );
        let hot = (0..11).map(|i| {
            EnvBuilder::new(Op::Update, "counters/{id}")
                .at(i * 500)
                .build()
        });
        assert_eq!(run(&mut e, hot).len(), 1);
        let calm = (0..11).map(|i| {
            EnvBuilder::new(Op::Update, "stats/{id}")
                .at(i * 2_000)
                .build()
        });
        assert!(run(&mut e, calm).is_empty());
    }
}
