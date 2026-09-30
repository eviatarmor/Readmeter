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
