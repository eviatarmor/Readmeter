use readmeter_core::{Envelope, Platform};
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::named;

pub const ID: &str = "firebase.functions/reads-per-invocation";

pub fn build(params: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(ReadsPerInvocation {
        max_reads: params.u64("max_reads")?.max(1),
    }))
}

/// One server invocation billed more Firestore reads than a request should.
/// One sample is enough. `items` on the invoke envelope is that read count.
struct ReadsPerInvocation {
    max_reads: u64,
}

impl Detector for ReadsPerInvocation {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "invoke") || env.ctx.platform != Platform::Server {
            return;
        }
        let reads = env.items();
        if reads <= self.max_reads {
            return;
        }
        let wasted = reads.saturating_sub(self.max_reads);
        out.emit(
            env,
            format!(
                "`{}` billed {reads} Firestore reads in one invocation; page the query or split the work",
                env.target.template
            ),
        )
        .evidence("reads", reads)
        .wasted("reads", wasted);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Op, Platform};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("max_reads", int(500))])
    }

    fn invoke(reads: u64, platform: Platform) -> Envelope {
        EnvBuilder::new(Op::Other("invoke".into()), "functions/readStorm")
            .provider("firebase", "functions")
            .platform(platform)
            .items(reads)
            .build()
    }

    #[test]
    fn flags_more_than_500_reads_and_wastes_the_excess() {
        assert!(run(&mut engine(), [invoke(500, Platform::Server)]).is_empty());
        let findings = run(&mut engine(), [invoke(501, Platform::Server)]);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].wasted.get("reads"), 1);
    }

    #[test]
    fn ignores_browser_invokes_and_callables() {
        let callable = EnvBuilder::new(Op::Other("callable".into()), "functions/echo")
            .provider("firebase", "functions")
            .platform(Platform::Server)
            .items(900)
            .build();
        assert!(run(&mut engine(), [invoke(900, Platform::Browser), callable]).is_empty());
    }
}
