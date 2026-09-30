# Conformance fixtures

One contract, checked from both sides:

- **SDK shims** must turn the scenario in `description` into exactly the raw
  calls in `calls` (ignoring `ts_ms`, `call_id`, `listener` and `callsite`
  values, which only need to be consistent within the fixture).
- **The Rust runtime** must turn `calls` into envelopes matching
  `expect_envelopes` and findings matching `expect_findings`.
  Runner: `crates/runtime/tests/conformance.rs`.

## Format

```jsonc
{
  "description": "What the app does, in words an SDK test can reproduce.",
  "platform": "browser",               // browser | server | mobile
  "evaluations": ["local", "window"],  // tiers to run
  "calls": [ /* raw calls, provider schema */ ],
  // Or, for aggregate rules, several sessions of one project. Exactly one
  // of `calls` and `sessions` is set. The Rust runner normalizes each
  // session, checks envelopes in this order, then runs the backend
  // evaluator on the calls sorted by `ts_ms`. SDK shims skip `sessions`
  // fixtures: aggregate rules do not run in the SDK.
  "sessions": [ { "session": 1, "calls": [ /* raw calls */ ] } ],
  "expect_envelopes": [                // same length as calls, or as every session's calls concatenated
    { "op": "query", "template": "users/{id}/orders", "units": { "reads": 20 } }
  ],
  "expect_findings": [                 // exact, in order
    { "rule": "firebase.firestore/offset-pagination", "wasted": { "reads": 200 } }
  ]
}
```

`units` and `wasted` are compared exactly (missing unit = 0). Omit `wasted`
to skip that check.

Layout: `fixtures/<provider>/<service>/<scenario>.json`.
