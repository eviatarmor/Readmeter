//! Page-visibility events. These are not a provider call: the browser SDK
//! reports them and the runtime builds the envelope itself.

use readmeter_core::{CallContext, Envelope, Op, Outcome, ReadSource, Target};
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};
use readmeter_provider_api::{NormalizeContext, NormalizeError};

/// True when the raw object is a page-visibility event.
///
/// A non-object, a missing `op`, or a wrong-typed `op` is not a page event,
/// so the provider still reports its usual parse error.
pub fn is_page(value: &JsonValue) -> bool {
    matches!(json::get_str(value, "op"), Ok(Some("page")))
}

pub fn normalize(value: &JsonValue, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let visible = match json::get_bool(value, "visible").map_err(|e| map_ty("visible", e))? {
        Some(v) => v,
        None => return Err(NormalizeError::Invalid("missing `visible`".into())),
    };
    let ts_ms = match json::get_u64(value, "ts_ms").map_err(|e| map_ty("ts_ms", e))? {
        Some(n) => n,
        None => return Err(NormalizeError::Invalid("missing `ts_ms`".into())),
    };
    let call_id = json::get_u64(value, "call_id")
        .map_err(|e| map_ty("call_id", e))?
        .unwrap_or(0);
    Ok(Envelope {
        ts_ms,
        provider: "sdk".into(),
        service: "page".into(),
        op: Op::Page { visible },
        target: Target {
            template: String::new(),
            key: cx.hasher.start().str("page").finish(),
            ..Target::default()
        },
        query: None,
        result: None,
        usage: None,
        source: ReadSource::Default,
        write: None,
        setup: None,
        outcome: Outcome::Ok,
        duration_us: None,
        ctx: CallContext {
            session: cx.session,
            call_id,
            platform: cx.platform,
            attempt: 1,
            dev: cx.dev,
            ..CallContext::default()
        },
        units: Default::default(),
    })
}

fn map_ty(field: &str, err: JsonTypeError) -> NormalizeError {
    let why = match err {
        JsonTypeError::NotObject => "expected an object",
        JsonTypeError::WrongType => "wrong type",
        JsonTypeError::OutOfRange => "out of range",
    };
    NormalizeError::Invalid(format!("`{field}`: {why}"))
}
