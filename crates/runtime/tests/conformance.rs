//! Runs every fixture under `conformance/fixtures/` through the runtime.
//! Format: `conformance/README.md`.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use readmeter_core::{Batch, Envelope, Units};
use readmeter_evaluator::Evaluator;
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
    /// One session. Mutually exclusive with [`Fixture::sessions`].
    #[serde(default)]
    calls: Vec<Value>,
    /// Several sessions of one project. Aggregate fixtures use this.
    /// Envelopes are checked in this order; rules see the calls sorted by
    /// `ts_ms` so a later session can be interleaved in time.
    #[serde(default)]
    sessions: Vec<SessionCalls>,
    expect_envelopes: Vec<ExpectEnvelope>,
    expect_findings: Vec<ExpectFinding>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionCalls {
    session: u64,
    calls: Vec<Value>,
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

fn client_config(fixture: &Fixture, session: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "provider": "firebase",
        "sdk": {"name": "conformance", "version": "0"},
        "session": session,
        "hash_key": "000102030405060708090a0b0c0d0e0f",
        "platform": fixture.platform,
        "evaluations": fixture.evaluations,
    }))
    .expect("config json")
}

fn check_envelopes(events: &[Envelope], want: &[ExpectEnvelope]) -> Result<(), String> {
    if events.len() != want.len() {
        return Err(format!(
            "expected {} envelopes, got {}",
            want.len(),
            events.len()
        ));
    }
    for (i, (env, want)) in events.iter().zip(want).enumerate() {
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
    Ok(())
}

fn check_findings(
    findings: &[readmeter_core::Finding],
    want: &[ExpectFinding],
) -> Result<(), String> {
    let got_rules: Vec<&str> = findings.iter().map(|f| f.rule.as_str()).collect();
    let want_rules: Vec<&str> = want.iter().map(|f| f.rule.as_str()).collect();
    if got_rules != want_rules {
        return Err(format!("findings: got {got_rules:?}, want {want_rules:?}"));
    }
    for (f, want) in findings.iter().zip(want) {
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

fn record_session(
    fixture: &Fixture,
    bundle: &[u8],
    session: u64,
    calls: &[Value],
) -> Result<Batch, String> {
    let mut client =
        Client::from_bytes(&client_config(fixture, session), bundle).map_err(|e| e.to_string())?;
    for (i, call) in calls.iter().enumerate() {
        client
            .record(call.to_string().as_bytes())
            .map_err(|e| format!("session {session} call {i}: {e}"))?;
    }
    client
        .drain(0)
        .ok_or_else(|| format!("session {session} produced no batch"))
}

fn run_fixture(path: &Path, bundle: &[u8], evaluator: &mut Evaluator) -> Result<(), String> {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("parse: {e}"))?;
    if fixture.description.trim().is_empty() {
        return Err("empty description".into());
    }
    if fixture.calls.is_empty() == fixture.sessions.is_empty() {
        return Err("fixture needs exactly one of `calls` or `sessions`".into());
    }

    if fixture.sessions.is_empty() {
        if fixture.calls.len() != fixture.expect_envelopes.len() {
            return Err("calls and expect_envelopes differ in length".into());
        }
        let mut client =
            Client::from_bytes(&client_config(&fixture, 1), bundle).map_err(|e| e.to_string())?;
        let mut findings = Vec::new();
        for (i, call) in fixture.calls.iter().enumerate() {
            let got = client
                .record(call.to_string().as_bytes())
                .map_err(|e| format!("call {i}: {e}"))?;
            findings.extend(got);
        }
        let events = client.drain(0).map(|b| b.events).unwrap_or_default();
        check_envelopes(&events, &fixture.expect_envelopes)?;
        return check_findings(&findings, &fixture.expect_findings);
    }

    let mut events = Vec::new();
    let mut shell: Option<Batch> = None;
    for group in &fixture.sessions {
        let batch = record_session(&fixture, bundle, group.session, &group.calls)?;
        if shell.is_none() {
            shell = Some(Batch {
                events: Vec::new(),
                findings: Vec::new(),
                ..batch.clone()
            });
        }
        events.extend(batch.events);
    }
    check_envelopes(&events, &fixture.expect_envelopes)?;
    let mut ordered: Vec<(u64, usize, Envelope)> = events
        .into_iter()
        .enumerate()
        .map(|(i, env)| (env.ts_ms, i, env))
        .collect();
    ordered.sort_by_key(|(ts, i, _)| (*ts, *i));
    let mut batch = shell.ok_or("no sessions")?;
    batch.events = ordered.into_iter().map(|(_, _, env)| env).collect();
    let project = path.to_string_lossy();
    let findings = evaluator
        .process(&project, &batch)
        .map_err(|e| e.to_string())?;
    check_findings(&findings, &fixture.expect_findings)
}

#[test]
fn conformance_fixtures() {
    let catalog = Catalog::load_dir(&root().join("rules")).expect("rules");
    let rules = catalog.bundle("conformance", Default::default());
    let bundle = rules.encode().expect("bundle");
    let mut evaluator = Evaluator::with_all_providers(rules).expect("evaluator");
    let mut paths = Vec::new();
    fixtures(&root().join("conformance/fixtures"), &mut paths);
    paths.sort();
    assert!(!paths.is_empty(), "no fixtures found");

    let failures: Vec<String> = paths
        .iter()
        .filter_map(|p| {
            run_fixture(p, &bundle, &mut evaluator)
                .err()
                .map(|e| format!("{}: {e}", p.display()))
        })
        .collect();
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
