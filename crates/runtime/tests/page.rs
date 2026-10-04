//! Page visibility goes through `Client::record` and never the Firebase provider.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::Path;

use readmeter_core::Op;
use readmeter_rules::Catalog;
use readmeter_runtime::Client;
use serde_json::json;

fn client() -> Client {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rules");
    let bundle = Catalog::load_dir(&dir)
        .expect("rules")
        .bundle("test", Default::default())
        .encode()
        .expect("bundle");
    let config = serde_json::to_vec(&json!({
        "provider": "firebase",
        "sdk": {"name": "t", "version": "0"},
        "session": "1",
        "hash_key": "000102030405060708090a0b0c0d0e0f",
        "platform": "browser",
        "evaluations": ["local"],
    }))
    .expect("json");
    Client::from_bytes(&config, &bundle).expect("client")
}

#[test]
fn page_event_is_recorded() {
    let mut c = client();
    let findings = c
        .record(br#"{"op":"page","ts_ms":1,"call_id":3,"visible":false}"#)
        .expect("record");
    assert!(findings.is_empty());
    let batch = c.drain(10).expect("batch");
    let event = &batch.events[0];
    assert_eq!(event.provider, "sdk");
    assert_eq!(event.service, "page");
    assert_eq!(event.op, Op::Page { visible: false });
    assert_eq!(event.target.template, "");
    assert!(event.units.is_empty());
    assert_eq!(event.ctx.call_id, 3);
    assert_eq!(event.ctx.attempt, 1);
    assert!(event.write.is_none());
    assert!(event.setup.is_none());
    assert!(event.query.is_none());
}

#[test]
fn page_requires_a_bool_visible_and_a_timestamp() {
    let mut c = client();
    assert!(c.record(br#"{"op":"page","ts_ms":1}"#).is_err());
    assert!(
        c.record(br#"{"op":"page","ts_ms":1,"visible":"yes"}"#)
            .is_err()
    );
    assert!(c.record(br#"{"op":"page","visible":true}"#).is_err());
    assert!(
        c.record(br#"{"op":"page","ts_ms":1,"visible":true,"call_id":-1}"#)
            .is_err()
    );
}

#[test]
fn navigation_is_a_page_event_with_a_templated_route() {
    let mut c = client();
    c.record(
        br#"{"op":"navigate","ts_ms":5,"call_id":6,"route":"/users/aliceSmith42/orders/Xk9pQ?token=s3cr3tval#frag-mark"}"#,
    )
    .expect("record");
    c.record(br#"{"op":"navigate","ts_ms":6,"call_id":7,"route":"/users/bob77/orders/Zz1"}"#)
        .expect("record");
    c.record(br#"{"op":"navigate","ts_ms":7,"call_id":8,"route":"/settings"}"#)
        .expect("record");
    // A full URL by mistake: scheme and host are not static names either.
    c.record(
        br#"{"op":"navigate","ts_ms":8,"call_id":9,"route":"https://app.example.com/teams/t9"}"#,
    )
    .expect("record");
    let batch = c.drain(10).expect("batch");
    let [first, second, third, fourth] = &batch.events[..] else {
        panic!("four events: {:?}", batch.events);
    };
    assert_eq!(fourth.target.template, "/{id}/{id}/teams/{id}");
    assert_eq!(first.provider, "sdk");
    assert_eq!(first.service, "page");
    assert_eq!(first.op, Op::Other("navigate".into()));
    assert_eq!(first.target.template, "/users/{id}/orders/{id}");
    assert_eq!(first.ctx.call_id, 6);
    assert!(first.units.is_empty());
    // Same template, same key: the concrete ids are not part of it.
    assert_eq!(first.target.key, second.target.key);
    assert_ne!(first.target.key, third.target.key);
    assert_eq!(third.target.template, "/settings");

    // Nothing from the raw URL survives in the encoded batch.
    let bytes = batch.encode().expect("encode");
    let text = String::from_utf8_lossy(&bytes);
    for secret in [
        "aliceSmith42",
        "Xk9pQ",
        "s3cr3tval",
        "token",
        "frag-mark",
        "example.com",
        "bob77",
        "Zz1",
    ] {
        assert!(!text.contains(secret), "{secret} leaked");
    }
}

#[test]
fn navigation_requires_a_string_route() {
    let mut c = client();
    assert!(c.record(br#"{"op":"navigate","ts_ms":1}"#).is_err());
    assert!(
        c.record(br#"{"op":"navigate","ts_ms":1,"route":3}"#)
            .is_err()
    );
    assert!(c.record(br#"{"op":"navigate","route":"/"}"#).is_err());
}

#[test]
fn connection_event_is_recorded() {
    let mut c = client();
    c.record(br#"{"op":"connection","ts_ms":1,"call_id":4,"online":false}"#)
        .expect("record");
    assert!(c.record(br#"{"op":"connection","ts_ms":1}"#).is_err());
    assert!(
        c.record(br#"{"op":"connection","ts_ms":1,"online":1}"#)
            .is_err()
    );
    let batch = c.drain(10).expect("batch");
    let event = &batch.events[0];
    assert_eq!(event.provider, "sdk");
    assert_eq!(event.service, "connection");
    assert_eq!(event.op, Op::Connection { online: false });
    assert_eq!(event.ctx.call_id, 4);
    assert!(event.units.is_empty());
}
