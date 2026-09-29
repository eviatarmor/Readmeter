//! Full path: real rule catalog from `rules/`, raw Firestore JSON in,
//! findings and an encoded batch out.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::Path;

use readmeter_core::Batch;
use readmeter_rules::{Bundle, Catalog};
use readmeter_runtime::Client;
use serde_json::json;

fn catalog() -> Catalog {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rules");
    Catalog::load_dir(&dir).expect("load rules")
}

fn bundle() -> Bundle {
    catalog().bundle("test", Default::default())
}

fn config(evaluations: &[&str]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "provider": "firebase",
        "sdk": {"name": "@readmeter/firebase", "version": "0.0.0"},
        "session": "18446744073709551615",
        "hash_key": "000102030405060708090a0b0c0d0e0f",
        "platform": "browser",
        "evaluations": evaluations,
    }))
    .expect("json")
}

fn client(evaluations: &[&str]) -> Client {
    let bundle = bundle().encode().expect("bundle");
    Client::from_bytes(&config(evaluations), &bundle).expect("client")
}

#[test]
fn every_enabled_rule_has_a_detector() {
    let c = client(&["local", "window", "aggregate"]);
    let catalog = catalog();
    // Aggregate rules run on the backend; everything else must be linked in.
    let missing: Vec<&String> = c
        .unavailable_rules()
        .iter()
        .filter(|id| {
            catalog
                .get(id)
                .is_some_and(|r| r.evaluation != readmeter_rules::Evaluation::Aggregate)
        })
        .collect();
    assert!(
        missing.is_empty(),
        "enabled rules without detectors: {missing:?}"
    );
}

#[test]
fn every_detector_has_a_rule_definition() {
    use readmeter_provider_api::Provider;
    let catalog = catalog();
    let mut registry = readmeter_rules::Registry::with_generic();
    registry.extend(readmeter_provider_firebase::FirebaseProvider.detectors());
    let orphans: Vec<&str> = registry
        .ids()
        .filter(|id| catalog.get(id).is_none())
        .collect();
    assert!(
        orphans.is_empty(),
        "detectors without rules/*.toml: {orphans:?}"
    );
}

#[test]
fn unbounded_query_is_reported_and_batched() {
    let mut c = client(&["local"]);
    let raw = json!({
        "service": "firestore", "op": "query", "ts_ms": 1_000,
        "path": "users/u_123/orders",
        "query": {"filters": [{"field": "status", "op": "==", "value": "open"}]},
        "result": {"docs": 5_000, "bytes": 2_000_000},
        "callsite": "src/Orders.tsx:12:5"
    });
    let findings = c
        .record(&serde_json::to_vec(&raw).expect("json"))
        .expect("record");
    let rules: Vec<&str> = findings.iter().map(|f| f.rule.as_str()).collect();
    assert!(
        rules.contains(&"firebase.firestore/unbounded-list"),
        "{rules:?}"
    );
    assert!(rules.contains(&"generic/oversized-payload"), "{rules:?}");

    let bytes = c.flush(2_000).expect("flush").expect("non-empty");
    let batch = Batch::decode(&bytes).expect("decode");
    assert_eq!(batch.session, u64::MAX);
    assert_eq!(batch.events.len(), 1);
    assert_eq!(batch.events[0].target.template, "users/{id}/orders");
    assert_eq!(batch.findings.len(), findings.len());
    assert!(c.flush(3_000).expect("flush").is_none());
}

#[test]
fn window_rules_run_only_when_enabled() {
    let get = |ts: u64, id: u64| {
        serde_json::to_vec(&json!({
            "service": "firestore", "op": "get", "ts_ms": ts,
            "path": format!("products/p{id}"), "result": {"docs": 1}
        }))
        .expect("json")
    };
    let mut local = client(&["local"]);
    let mut window = client(&["local", "window"]);
    let mut local_hits = 0;
    let mut window_hits = 0;
    for i in 0..20 {
        local_hits += local.record(&get(i, i)).expect("record").len();
        window_hits += window
            .record(&get(i, i))
            .expect("record")
            .iter()
            .filter(|f| f.rule == "generic/n-plus-one")
            .count();
    }
    assert_eq!(local_hits, 0);
    assert_eq!(window_hits, 1);
}

#[test]
fn bad_input_is_an_error_not_a_panic() {
    let mut c = client(&["local"]);
    assert!(c.record(b"not json").is_err());
    assert!(
        c.record(br#"{"service":"nope","op":"get","ts_ms":0,"path":"a"}"#)
            .is_err()
    );
    assert!(
        c.record(br#"{"service":"firestore","op":"get","ts_ms":0,"path":""}"#)
            .is_err()
    );
}
