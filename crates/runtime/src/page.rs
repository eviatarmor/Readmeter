//! Page-visibility, navigation and connection events. These are not a
//! provider call: the browser SDK reports them and the runtime builds the
//! envelope itself.
//!
//! A navigation (`{"op":"navigate","route":"/users/abc"}`) becomes a `page`
//! envelope with `Op::Other("navigate")` and the route template in
//! `target.template`, so the wire format does not change. The raw route never
//! leaves: see [`route_template`].

use readmeter_core::{CallContext, Envelope, Op, Outcome, ReadSource, Target};
use readmeter_provider_api::json::{self, JsonTypeError, JsonValue};
use readmeter_provider_api::{NormalizeContext, NormalizeError};
use readmeter_rules::def::HOST_PROVIDER;

/// `Op::Other` name of a client-side route change.
pub const NAVIGATE: &str = "navigate";

/// Route segments kept after this many are folded into one placeholder.
const MAX_ROUTE_SEGMENTS: usize = 12;
/// Longest segment kept as a static route name.
const MAX_STATIC_SEGMENT: usize = 32;

/// True when the raw object is a page-visibility (`page`), navigation
/// (`navigate`) or connection (`connection`) event.
///
/// A non-object, a missing `op`, or a wrong-typed `op` is not a page event,
/// so the provider still reports its usual parse error.
pub fn is_page(value: &JsonValue) -> bool {
    matches!(
        json::get_str(value, "op"),
        Ok(Some("page" | "connection" | NAVIGATE))
    )
}

/// Templates a route so it can leave the process.
///
/// The query string and fragment are dropped. A segment survives only when
/// it is 1 to 32 lowercase ASCII letters, `-` or `_` (`settings`,
/// `order-history`). Anything else (digits, uppercase, `%`, `.`, `@`, `:`,
/// long slugs) becomes `{id}`, so a full URL passed by mistake keeps no
/// scheme or host. Segments past the twelfth fold into one `{rest}`.
pub fn route_template(raw: &str) -> String {
    // Byte-level on purpose: `str` pattern searching costs SDK wasm size.
    let bytes = raw.as_bytes();
    let end = bytes
        .iter()
        .position(|&b| b == b'?' || b == b'#')
        .unwrap_or(bytes.len());
    let mut out = String::new();
    let mut kept = 0;
    for segment in bytes[..end].split(|&b| b == b'/') {
        if segment.is_empty() {
            continue;
        }
        out.push('/');
        if kept == MAX_ROUTE_SEGMENTS {
            out.push_str("{rest}");
            break;
        }
        kept += 1;
        if is_static_segment(segment) {
            // ASCII only, checked above.
            out.extend(segment.iter().map(|&b| char::from(b)));
        } else {
            out.push_str("{id}");
        }
    }
    if out.is_empty() {
        out.push('/');
    }
    out
}

fn is_static_segment(segment: &[u8]) -> bool {
    segment.len() <= MAX_STATIC_SEGMENT
        && segment
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b == b'-' || b == b'_')
}

pub fn normalize(value: &JsonValue, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let mut template = String::new();
    let (op, service) = match json::get_str(value, "op") {
        Ok(Some("connection")) => {
            let online = req_bool(value, "online")?;
            (Op::Connection { online }, "connection")
        }
        Ok(Some(NAVIGATE)) => {
            let route = match json::get_str(value, "route").map_err(|e| map_ty("route", e))? {
                Some(route) => route,
                None => return Err(NormalizeError::Invalid("missing `route`".into())),
            };
            template = route_template(route);
            (Op::Other(NAVIGATE.into()), "page")
        }
        _ => {
            let visible = req_bool(value, "visible")?;
            (Op::Page { visible }, "page")
        }
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
        provider: HOST_PROVIDER.into(),
        service: service.into(),
        op,
        target: Target {
            // Navigations group by route template; other page events hash
            // exactly as before (`str("")` would change their key).
            key: if template.is_empty() {
                cx.hasher.start().str(service).finish()
            } else {
                cx.hasher.start().str(service).str(&template).finish()
            },
            template,
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

fn req_bool(value: &JsonValue, key: &str) -> Result<bool, NormalizeError> {
    match json::get_bool(value, key).map_err(|e| map_ty(key, e))? {
        Some(v) => Ok(v),
        None => Err(NormalizeError::Invalid(format!("missing `{key}`"))),
    }
}

fn map_ty(field: &str, err: JsonTypeError) -> NormalizeError {
    let why = match err {
        JsonTypeError::NotObject => "expected an object",
        JsonTypeError::WrongType => "wrong type",
        JsonTypeError::OutOfRange => "out of range",
    };
    NormalizeError::Invalid(format!("`{field}`: {why}"))
}

#[cfg(test)]
mod tests {
    use super::route_template;

    #[test]
    fn route_templates_keep_static_names_only() {
        assert_eq!(route_template("/"), "/");
        assert_eq!(route_template(""), "/");
        assert_eq!(
            route_template("/settings/order-history"),
            "/settings/order-history"
        );
        assert_eq!(
            route_template("/users/abc123/orders/42/"),
            "/users/{id}/orders/{id}"
        );
        assert_eq!(route_template("/users/Alice"), "/users/{id}");
        assert_eq!(route_template("/u/alice%40example.com"), "/u/{id}");
        assert_eq!(
            route_template("/p/550e8400-e29b-41d4-a716-446655440000"),
            "/p/{id}"
        );
        assert_eq!(
            route_template("/blog/a-very-long-post-title-that-names-someone"),
            "/blog/{id}"
        );
        assert_eq!(route_template("/search?q=secret#frag"), "/search");
        assert_eq!(route_template("#/inbox"), "/");
        assert_eq!(
            route_template("https://app.example.com/teams/t9?x=1"),
            "/{id}/{id}/teams/{id}"
        );
        assert_eq!(route_template("https://app.example.com"), "/{id}/{id}");
        let deep = "/a".repeat(20);
        assert_eq!(
            route_template(&deep),
            format!("{}/{{rest}}", "/a".repeat(12))
        );
    }
}
