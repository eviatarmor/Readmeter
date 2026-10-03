"""Runs every single-session fixture in conformance/fixtures through the Python client.

Same checks as the JS runner (sdks/js/firebase/test/conformance.test.ts):
findings by rule, in order, with `wasted` compared exactly when given, and
an `RM` batch from flush. When the server core is built
(`./scripts/build-wasm-server.sh`) and Node is on PATH, the flushed batches
are also decoded by the evaluator and the envelopes compared with
`expect_envelopes`, as the Rust runner does.

The library must include every service and the window rules:
`cargo build -p readmeter-ffi --release --features firebase,database,storage,auth,functions,window`.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from readmeter import Client

from .support import HASH_KEY, ROOT, fixture_paths, load_fixture


def same_units(got: dict, want: dict) -> bool:
    keys = set(got) | set(want)
    return all(got.get(k, 0) == want.get(k, 0) for k in keys)


def run_fixture(path: Path, fixture: dict) -> tuple[list[str], bytes]:
    """Returns failures and the flushed batch."""
    failures: list[str] = []
    name = path.relative_to(ROOT / "conformance" / "fixtures").as_posix()
    with Client(
        HASH_KEY,
        platform=fixture["platform"],
        evaluations=fixture["evaluations"],
        session=1,
        sample_rate=1,
        sdk_name="conformance",
        sdk_version="0",
    ) as client:
        got = []
        for i, call in enumerate(fixture["calls"]):
            try:
                got.extend(client.record(call))
            except Exception as e:  # noqa: BLE001 - reported as a fixture failure
                failures.append(f"{name}: call {i}: {e}")
        if failures:
            return failures, b""
        if client.findings() != got:
            failures.append(f"{name}: findings() differs from what record returned")
        got_rules = [f["rule"] for f in got]
        want_rules = [f["rule"] for f in fixture["expect_findings"]]
        if got_rules != want_rules:
            failures.append(f"{name}: findings {got_rules} want {want_rules}")
        else:
            for finding, want in zip(got, fixture["expect_findings"]):
                if "wasted" in want and not same_units(finding["wasted"], want["wasted"]):
                    failures.append(
                        f"{name}: {finding['rule']} wasted {finding['wasted']} want {want['wasted']}"
                    )
        batch = client.flush(0)
        if not batch.startswith(b"RM"):
            failures.append(f"{name}: flush did not return an RM batch")
        if client.flush(0) != b"":
            failures.append(f"{name}: second flush was not empty")
    return failures, batch


def server_core() -> tuple[str, Path, Path] | None:
    node = shutil.which("node")
    wasm = Path(os.environ.get("READMETER_SERVER_WASM", ROOT / "apps" / "ingest" / "wasm"))
    bundle_json = ROOT / "target" / "rules" / "bundle.json"
    if node and (wasm / "readmeter_wasm_server.js").is_file() and bundle_json.is_file():
        return node, wasm, bundle_json
    return None


class ConformanceTest(unittest.TestCase):
    def test_fixtures(self) -> None:
        paths = fixture_paths()
        self.assertTrue(paths, "no fixtures found")
        failures: list[str] = []
        flushed: list[tuple[Path, dict, bytes]] = []
        ran = 0
        for path in paths:
            fixture = load_fixture(path)
            # Aggregate fixtures name many sessions and run in the Rust evaluator.
            if not fixture.get("calls"):
                continue
            ran += 1
            got, batch = run_fixture(path, fixture)
            failures.extend(got)
            if batch:
                flushed.append((path, fixture, batch))
        self.assertGreater(ran, 0)
        self.assertTrue(
            any(p.parent.name == "firestore" for p, _, _ in flushed), "no Firestore fixture ran"
        )
        self.assertEqual(failures, [], "\n" + "\n".join(failures))
        self._check_envelopes(flushed)

    def _check_envelopes(self, flushed: list[tuple[Path, dict, bytes]]) -> None:
        core = server_core()
        if core is None:
            if os.environ.get("READMETER_REQUIRE_ENVELOPES") == "1":
                self.fail("READMETER_REQUIRE_ENVELOPES=1 but the server core or node is missing")
            print("\nconformance: server core or node not found; envelope check skipped")
            return
        node, wasm, bundle_json = core
        request = {
            "wasm_dir": str(wasm),
            "bundle_json": str(bundle_json),
            "batches": [base64.b64encode(b).decode() for _, _, b in flushed],
        }
        proc = subprocess.run(
            [node, str(Path(__file__).with_name("evaluate.mjs"))],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        results = json.loads(proc.stdout)
        failures: list[str] = []
        for (path, fixture, _), result in zip(flushed, results):
            name = path.name
            if "error" in result:
                failures.append(f"{name}: evaluator rejected batch: {result['error']}")
                continue
            events, want = result["events"], fixture["expect_envelopes"]
            if len(events) != len(want):
                failures.append(f"{name}: expected {len(want)} envelopes, got {len(events)}")
                continue
            for i, (env, exp) in enumerate(zip(events, want)):
                if (
                    env["op"] != exp["op"]
                    or env["template"] != exp["template"]
                    or not same_units(env["units"], exp["units"])
                ):
                    failures.append(f"{name}: envelope {i}: got {env}, want {exp}")
        self.assertEqual(failures, [], "\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
