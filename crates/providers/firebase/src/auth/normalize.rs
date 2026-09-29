use readmeter_core::{
    CacheKind, CallContext, ClientSetup, Envelope, FilterShape, Op, Outcome, QueryShape,
    ResultStats, Target,
};
use readmeter_provider_api::{NormalizeContext, NormalizeError};

use super::SERVICE_ID;
use super::billing;
use super::raw::{RawCall, RawOp};

use crate::PROVIDER_ID;

pub fn normalize(raw: RawCall, cx: &NormalizeContext) -> Result<Envelope, NormalizeError> {
    let template = format!("auth/{}", raw.method);
    // Identity is the method. Filters must not change the key, or two
    // calls of the same method would miss each other.
    let key = cx.hasher.start().str(SERVICE_ID).str(&raw.method).finish();
    let filters = attributes(&raw);
    let query = if filters.is_empty() && !raw.page_token {
        None
    } else {
        Some(shape(cx, &filters, raw.page_token))
    };
    let op = match raw.op {
        RawOp::SignIn => Op::Other("sign_in".into()),
        RawOp::SignInAnonymous => Op::Other("sign_in_anonymous".into()),
        RawOp::SignOut => Op::Other("sign_out".into()),
        RawOp::Subscribe => Op::Subscribe,
        RawOp::Unsubscribe => Op::Unsubscribe,
        RawOp::TokenRefresh => Op::Other("token_refresh".into()),
        RawOp::PasswordReset => Op::Other("password_reset".into()),
        RawOp::EmailVerification => Op::Other("email_verification".into()),
        RawOp::Phone => Op::Other("phone".into()),
        RawOp::Init => Op::Init,
        RawOp::VerifyIdToken => Op::Other("verify_id_token".into()),
        RawOp::GetUser => Op::Other("get_user".into()),
        RawOp::ListUsers => Op::Other("list_users".into()),
        RawOp::CustomToken => Op::Other("custom_token".into()),
        RawOp::SetClaims => Op::Other("set_claims".into()),
    };
    let items = if matches!(raw.op, RawOp::ListUsers) {
        raw.items
    } else {
        0
    };
    let listener = match raw.op {
        RawOp::Subscribe | RawOp::Unsubscribe => raw.listener,
        _ => None,
    };
    // There is no invocation field. `list_users` is the only op that
    // borrows `ctx.transaction` for the `withFlush` id, so other admin
    // calls do not look like Firestore transactions.
    let invocation = match raw.op {
        RawOp::ListUsers => raw.invocation,
        _ => None,
    };
    let setup = if matches!(raw.op, RawOp::Init) {
        Some(ClientSetup {
            cache: raw.persistence.unwrap_or(CacheKind::Unknown),
            shared_tabs: false,
        })
    } else {
        None
    };

    let mut env = Envelope {
        ts_ms: raw.ts_ms,
        provider: PROVIDER_ID.to_owned(),
        service: SERVICE_ID.to_owned(),
        op,
        target: Target {
            template,
            key,
            id_shape: None,
            collection_group: false,
        },
        query,
        result: Some(ResultStats {
            items,
            bytes: 0,
            from_cache: raw.from_cache,
            index_entries: None,
        }),
        usage: None,
        source: Default::default(),
        write: None,
        setup,
        outcome: match raw.error {
            Some(code) => Outcome::Error { code },
            None => Outcome::Ok,
        },
        duration_us: raw.duration_us,
        ctx: CallContext {
            session: cx.session,
            call_id: raw.call_id,
            callsite: raw.callsite.as_deref().map(|c| cx.hasher.hash_str(c)),
            listener,
            transaction: invocation,
            mount: None,
            platform: cx.platform,
            attempt: raw.attempt.max(1),
            dev: cx.dev,
        },
        units: Default::default(),
    };
    env.units = billing::units(&env);
    Ok(env)
}

fn attributes(raw: &RawCall) -> Vec<FilterShape> {
    let mut filters = Vec::new();
    if raw.force {
        filters.push(FilterShape {
            field: "force".into(),
            op: "true".into(),
        });
    }
    if matches!(raw.op, RawOp::SignInAnonymous) {
        filters.push(FilterShape {
            field: "anonymous".into(),
            op: "true".into(),
        });
    }
    if let Some(kind) = raw.persistence {
        let op = match kind {
            CacheKind::Memory => "memory",
            CacheKind::Persistent => "persistent",
            CacheKind::Unknown => "unknown",
        };
        filters.push(FilterShape {
            field: "persistence".into(),
            op: op.into(),
        });
    }
    if let Some(provider) = &raw.provider {
        filters.push(FilterShape {
            field: "provider".into(),
            op: provider.clone(),
        });
    }
    filters
}

fn shape(cx: &NormalizeContext, filters: &[FilterShape], page_token: bool) -> QueryShape {
    let mut h = cx.hasher.start().str(SERVICE_ID);
    for f in filters {
        h = h.str(&f.field).str(&f.op);
    }
    let fingerprint = h.bool(page_token).finish();
    QueryShape {
        filters: filters.to_vec(),
        order_by: Vec::new(),
        limit: None,
        limit_to_last: false,
        offset: None,
        start_cursor: page_token,
        end_cursor: false,
        projection: None,
        aggregations: Vec::new(),
        base_key: fingerprint,
        fingerprint,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use readmeter_core::{KeyedHasher, Platform};
    use readmeter_provider_api::Provider;
    use serde_json::json;

    use super::*;

    fn cx() -> NormalizeContext {
        NormalizeContext {
            hasher: KeyedHasher::new(11, 22),
            session: 5,
            platform: Platform::Browser,
            dev: false,
        }
    }

    fn norm(v: serde_json::Value) -> Envelope {
        let bytes = serde_json::to_vec(&v).unwrap();
        crate::FirebaseProvider.normalize(&bytes, &cx()).unwrap()
    }

    fn attr<'a>(env: &'a Envelope, field: &str) -> Option<&'a str> {
        env.query
            .as_ref()
            .and_then(|q| q.filters.iter().find(|f| f.field == field))
            .map(|f| f.op.as_str())
    }

    #[test]
    fn the_key_is_the_method_and_filters_do_not_change_it() {
        let plain = norm(json!({
            "service": "auth",
            "op": "sign_in",
            "method": "signInWithPassword",
            "ts_ms": 1
        }));
        let forced = norm(json!({
            "service": "auth",
            "op": "token_refresh",
            "method": "getIdToken",
            "ts_ms": 2,
            "force": true,
            "provider": "google.com"
        }));
        let same_method = norm(json!({
            "service": "auth",
            "op": "token_refresh",
            "method": "getIdToken",
            "ts_ms": 3,
            "force": false
        }));
        assert_eq!(plain.target.template, "auth/signInWithPassword");
        assert_eq!(plain.units.get("sign_ins"), 1);
        assert_eq!(forced.target.key, same_method.target.key);
        assert_ne!(plain.target.key, forced.target.key);
        assert_eq!(attr(&forced, "force"), Some("true"));
        assert_eq!(attr(&forced, "provider"), Some("google.com"));
        assert_eq!(attr(&same_method, "force"), None);
        assert!(forced.units.is_empty());
    }

    #[test]
    fn units_follow_the_op_and_errors_are_free() {
        let anon = norm(json!({
            "service": "auth",
            "op": "sign_in_anonymous",
            "method": "signInAnonymously",
            "ts_ms": 1
        }));
        assert_eq!(anon.op, Op::Other("sign_in_anonymous".into()));
        assert_eq!(anon.units.get("anonymous_sign_ins"), 1);
        assert_eq!(anon.units.get("sign_ins"), 0);
        assert_eq!(attr(&anon, "anonymous"), Some("true"));

        let phone = norm(json!({
            "service": "auth",
            "op": "phone",
            "method": "signInWithPhoneNumber",
            "ts_ms": 1
        }));
        assert_eq!(phone.units.get("sms"), 1);
        assert_eq!(phone.units.get("sign_ins"), 0);

        let confirm = norm(json!({
            "service": "auth",
            "op": "sign_in",
            "method": "confirm",
            "ts_ms": 1,
            "provider": "phone"
        }));
        assert_eq!(confirm.units.get("sign_ins"), 1);
        assert_eq!(confirm.units.get("sms"), 0);
        assert_eq!(attr(&confirm, "provider"), Some("phone"));

        let failed = norm(json!({
            "service": "auth",
            "op": "sign_in",
            "method": "signInWithPassword",
            "ts_ms": 1,
            "error": "auth/wrong-password"
        }));
        assert!(failed.units.is_empty());
        assert_eq!(
            failed.outcome,
            Outcome::Error {
                code: "wrong-password".into()
            }
        );
    }

    #[test]
    fn persistence_maps_onto_setup_without_changing_the_key() {
        let memory = norm(json!({
            "service": "auth",
            "op": "init",
            "method": "initializeAuth",
            "ts_ms": 1,
            "persistence": "NONE"
        }));
        let session = norm(json!({
            "service": "auth",
            "op": "init",
            "method": "setPersistence",
            "ts_ms": 2,
            "persistence": "SESSION"
        }));
        let mixed = norm(json!({
            "service": "auth",
            "op": "init",
            "method": "initializeAuth",
            "ts_ms": 3,
            "persistence": ["LOCAL", "NONE"]
        }));
        let only_memory = norm(json!({
            "service": "auth",
            "op": "init",
            "method": "initializeAuth",
            "ts_ms": 4,
            "persistence": ["NONE", "none"]
        }));
        assert_eq!(memory.op, Op::Init);
        assert_eq!(memory.setup.map(|s| s.cache), Some(CacheKind::Memory));
        assert_eq!(attr(&memory, "persistence"), Some("memory"));
        assert_eq!(session.setup.map(|s| s.cache), Some(CacheKind::Persistent));
        assert_eq!(mixed.setup.map(|s| s.cache), Some(CacheKind::Persistent));
        assert_eq!(only_memory.setup.map(|s| s.cache), Some(CacheKind::Memory));
        assert_eq!(memory.target.key, only_memory.target.key);
        assert_ne!(memory.target.key, session.target.key);

        let failed = norm(json!({
            "service": "auth",
            "op": "init",
            "method": "setPersistence",
            "ts_ms": 5,
            "persistence": "NONE",
            "error": "auth/invalid-persistence-type"
        }));
        assert!(failed.outcome.is_error());
        assert_eq!(failed.setup.map(|s| s.cache), Some(CacheKind::Memory));
    }

    #[test]
    fn listeners_and_list_users_keep_ids_off_other_ops() {
        let sub = norm(json!({
            "service": "auth",
            "op": "subscribe",
            "method": "onAuthStateChanged",
            "ts_ms": 1,
            "listener": 4,
            "invocation": 9
        }));
        assert_eq!(sub.op, Op::Subscribe);
        assert_eq!(sub.ctx.listener, Some(4));
        assert_eq!(sub.ctx.transaction, None);

        let listed = norm(json!({
            "service": "auth",
            "op": "list_users",
            "method": "listUsers",
            "ts_ms": 2,
            "invocation": 9,
            "page_token": "next-page-secret",
            "result": { "items": 3 }
        }));
        assert_eq!(listed.op, Op::Other("list_users".into()));
        assert_eq!(listed.ctx.transaction, Some(9));
        assert_eq!(listed.ctx.listener, None);
        assert_eq!(listed.items(), 3);
        assert!(listed.query.as_ref().is_some_and(|q| q.start_cursor));
        assert!(listed.units.is_empty());
    }

    #[test]
    fn no_raw_values_or_ids_leak() {
        let env = norm(json!({
            "service": "auth",
            "op": "sign_in",
            "method": "leak.check@example.com",
            "ts_ms": 1,
            "callsite": "src/leak.check@example.com:1",
            "error": "auth/UidShouldNotLeak99abcd",
            "page_token": "eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "provider": "leak.check@example.com",
            "persistence": "+15555550123",
            "email": "leak.check@example.com",
            "phone": "+15555550123",
            "uid": "UidShouldNotLeak99abcd",
            "token": "eyJhbGciOiJIUzI1NiJ9.payload.sig"
        }));
        let dump = format!("{env:?}");
        for secret in [
            "leak.check@example.com",
            "+15555550123",
            "UidShouldNotLeak99abcd",
            "eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "payload",
        ] {
            assert!(!dump.contains(secret), "{secret} in {dump}");
        }
        assert_eq!(env.target.template, "auth/unknown");
        assert!(env.outcome.is_error());
        assert_eq!(attr(&env, "provider"), None);
        assert_eq!(attr(&env, "persistence"), Some("unknown"));
        assert!(env.query.as_ref().is_some_and(|q| q.start_cursor));
    }

    #[test]
    fn hostile_raw_calls_never_panic() {
        let provider = crate::FirebaseProvider;
        let cases = [
            "",
            "null",
            "[]",
            "{}",
            r#"{"service":"auth"}"#,
            r#"{"service":"auth","op":"sign_in","ts_ms":-1}"#,
            r#"{"service":"auth","op":"nope","ts_ms":1}"#,
            r#"{"service":"auth","op":"init","ts_ms":1,"persistence":{"a":1}}"#,
            r#"{"service":"auth","op":"list_users","ts_ms":1,"page_token":[]}"#,
            r#"{"service":"auth","op":"sign_in","ts_ms":1,"method":{"email":"a@b.c"}}"#,
            r#"{"service":"auth","op":"phone","ts_ms":1,"attempt":0,"error":1}"#,
        ];
        for case in cases {
            let _ = provider.normalize(case.as_bytes(), &cx());
        }
    }
}
