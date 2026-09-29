//! Runs every fixture under `conformance/fixtures/` through the runtime.
//! Format: `conformance/README.md`.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use readmeter_core::{Envelope, Units};
use readmeter_rules::Catalog;
use readmeter_runtime::Client;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    description: String,
    platform: String,
    evaluations: Vec<String>,
    calls: Vec<Value>,
    expect_envelopes: Vec<ExpectEnvelope>,
    expect_findings: Vec<ExpectFinding>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectEnvelope {
    op: String,
    template: String,
    units: BTreeMap<String, u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectFinding {
    rule: String,
    wasted: Option<BTreeMap<String, u64>>,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixtures(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read fixtures dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            fixtures(&path, out);
        } else if path.extension().is_some_and(|e| e == "json") {
            out.push(path);
        }
    }
}

fn op_name(env: &Envelope) -> String {
    match serde_json::to_value(&env.op).expect("op json") {
        Value::String(s) => s,
        Value::Object(m) => m.keys().next().cloned().unwrap_or_default(),
        other => panic!("unexpected op encoding {other}"),
    }
}

fn units_map(u: &Units) -> BTreeMap<String, u64> {
    u.iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

fn run_fixture(path: &Path, bundle: &[u8]) -> Result<(), String> {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("parse: {e}"))?;
    if fixture.description.trim().is_empty() {
        return Err("empty description".into());
    }
    if fixture.calls.len() != fixture.expect_envelopes.len() {
        return Err("calls and expect_envelopes differ in length".into());
    }
    let config = json!({
        "provider": "firebase",
        "sdk": {"name": "conformance", "version": "0"},
        "session": 1,
        "hash_key": "000102030405060708090a0b0c0d0e0f",
        "platform": fixture.platform,
        "evaluations": fixture.evaluations,
    });
    let mut client =
        Client::from_bytes(config.to_string().as_bytes(), bundle).map_err(|e| e.to_string())?;

    let mut findings = Vec::new();
    for (i, call) in fixture.calls.iter().enumerate() {
        let got = client
            .record(call.to_string().as_bytes())
            .map_err(|e| format!("call {i}: {e}"))?;
        findings.extend(got);
    }
    let events = client.drain(0).map(|b| b.events).unwrap_or_default();
    if events.len() != fixture.expect_envelopes.len() {
        return Err(format!(
            "expected {} envelopes, got {}",
            fixture.expect_envelopes.len(),
            events.len()
        ));
    }
    for (i, (env, want)) in events.iter().zip(&fixture.expect_envelopes).enumerate() {
        let got = (
            op_name(env),
            env.target.template.clone(),
            units_map(&env.units),
        );
        let want = (want.op.clone(), want.template.clone(), want.units.clone());
        if got != want {
            return Err(format!("envelope {i}: got {got:?}, want {want:?}"));
        }
    }

    let got_rules: Vec<&str> = findings.iter().map(|f| f.rule.as_str()).collect();
    let want_rules: Vec<&str> = fixture
        .expect_findings
        .iter()
        .map(|f| f.rule.as_str())
        .collect();
    if got_rules != want_rules {
        return Err(format!("findings: got {got_rules:?}, want {want_rules:?}"));
    }
    for (f, want) in findings.iter().zip(&fixture.expect_findings) {
        if let Some(wasted) = &want.wasted {
            if &units_map(&f.wasted) != wasted {
                return Err(format!(
                    "{}: wasted {:?}, want {wasted:?}",
                    f.rule,
                    units_map(&f.wasted)
                ));
            }
        }
    }
    Ok(())
}

#[test]
fn conformance_fixtures() {
    let catalog = Catalog::load_dir(&root().join("rules")).expect("rules");
    let bundle = catalog
        .bundle("conformance", Default::default())
        .encode()
        .expect("bundle");
    let mut paths = Vec::new();
    fixtures(&root().join("conformance/fixtures"), &mut paths);
    paths.sort();
    assert!(!paths.is_empty(), "no fixtures found");

    let failures: Vec<String> = paths
        .iter()
        .filter_map(|p| {
            run_fixture(p, &bundle)
                .err()
                .map(|e| format!("{}: {e}", p.display()))
        })
        .collect();
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
