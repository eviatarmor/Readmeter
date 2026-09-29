use readmeter_core::Envelope;
use readmeter_rules::{Detector, Emitter, ParamError, Params};

use super::named;

pub const ID: &str = "firebase.functions/large-callable-payload";

pub fn build(params: &Params) -> Result<Box<dyn Detector>, ParamError> {
    Ok(Box::new(LargeCallablePayload {
        max_bytes: params.u64("max_bytes")?.max(1),
    }))
}

/// A callable request or response is larger than a function call should be.
struct LargeCallablePayload {
    max_bytes: u64,
}

impl Detector for LargeCallablePayload {
    fn observe(&mut self, env: &Envelope, out: &mut Emitter<'_>) {
        if !named(env, "callable") {
            return;
        }
        let request = env
            .write
            .as_ref()
            .map(|write| write.payload_bytes)
            .unwrap_or(0);
        let response = env.bytes();
        if request < self.max_bytes && response < self.max_bytes {
            return;
        }
        out.emit(
            env,
            format!(
                "`{}` moved {request} request bytes and {response} response bytes; keep callable payloads under {} bytes",
                env.target.template, self.max_bytes
            ),
        )
        .evidence("request_bytes", request)
        .evidence("response_bytes", response);
    }
}

#[cfg(test)]
mod tests {
    use readmeter_core::{Op, WriteStats};
    use readmeter_rules::testing::{EnvBuilder, int, run, single_rule_engine};

    use super::*;

    fn engine() -> readmeter_rules::Engine {
        single_rule_engine(ID, build, &[("max_bytes", int(1_048_576))])
    }

    fn call(request: u64, response: u64) -> Envelope {
        let mut builder = EnvBuilder::new(Op::Other("callable".into()), "functions/echo")
            .provider("firebase", "functions")
            .bytes(response);
        if request > 0 {
            builder = builder.write(WriteStats {
                payload_bytes: request,
                ..WriteStats::default()
            });
        }
        builder.build()
    }

    #[test]
    fn flags_a_request_or_response_at_the_cap() {
        let mut e = engine();
        assert!(run(&mut e, [call(1_048_575, 1_048_575)]).is_empty());
        assert_eq!(run(&mut engine(), [call(1_048_576, 1)]).len(), 1);
        assert_eq!(run(&mut engine(), [call(1, 1_048_576)]).len(), 1);
    }

    #[test]
    fn ignores_server_invokes() {
        let invoke = EnvBuilder::new(Op::Other("invoke".into()), "functions/echo")
            .provider("firebase", "functions")
            .bytes(2_000_000)
            .build();
        assert!(run(&mut engine(), [invoke]).is_empty());
    }
}
