from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path

from readmeter import Client, ConfigError, LibraryNotFoundError, ReadmeterError

from .support import HASH_KEY

OFFSET_QUERY = {
    "service": "firestore",
    "op": "query",
    "ts_ms": 1,
    "path": "posts",
    "query": {"limit": 20, "offset": 200},
    "result": {"docs": 20, "bytes": 2000},
}
GET = {"service": "firestore", "op": "get", "ts_ms": 1, "path": "users/u1", "result": {"docs": 1}}


class ClientTest(unittest.TestCase):
    def test_sink_returns_local_findings_and_flush_returns_a_batch(self) -> None:
        with Client(HASH_KEY) as client:
            found = client.sink(OFFSET_QUERY)
            self.assertEqual([f["rule"] for f in found], ["firebase.firestore/offset-pagination"])
            self.assertEqual(found[0]["wasted"], {"reads": 200})
            self.assertEqual(set(found[0]), {"rule", "severity", "template", "message", "wasted"})
            self.assertEqual(client.findings(), found)
            self.assertEqual(client.findings(), [])
            batch = client.flush()
            self.assertTrue(batch.startswith(b"RM"))
            self.assertEqual(client.flush(), b"")

    def test_batch_does_not_contain_raw_ids(self) -> None:
        with Client(HASH_KEY) as client:
            client.sink({**GET, "path": "users/secret-user-id-123"})
            self.assertNotIn(b"secret-user-id-123", client.flush())

    def test_sink_never_raises(self) -> None:
        with Client(HASH_KEY) as client:
            with self.assertLogs("readmeter", level="WARNING"):
                self.assertEqual(client.sink({"service": "firestore"}), [])
                self.assertEqual(client.sink("{not json"), [])
                self.assertEqual(client.sink({"bad": float("nan")}), [])
                self.assertEqual(client.sink(object()), [])  # type: ignore[arg-type]
            self.assertEqual(client.dropped_calls, 4)
            with self.assertRaises(ReadmeterError):
                client.record({"service": "firestore"})
            self.assertEqual(client.sink(GET), [])
            self.assertTrue(client.flush().startswith(b"RM"))

    def test_closed_client_is_inert(self) -> None:
        client = Client(HASH_KEY)
        client.close()
        client.close()
        self.assertTrue(client.closed)
        with self.assertLogs("readmeter", level="WARNING"):
            self.assertEqual(client.sink(GET), [])
        self.assertEqual(client.flush(), b"")

    def test_bad_config_raises_clear_errors(self) -> None:
        with self.assertRaisesRegex(ConfigError, "hash_key"):
            Client("nothex")
        with self.assertRaisesRegex(ConfigError, "platform"):
            Client(HASH_KEY, platform="desktop")
        with self.assertRaisesRegex(ConfigError, "sample_rate"):
            Client(HASH_KEY, sample_rate=2)
        with self.assertRaisesRegex(ConfigError, "evaluations"):
            Client(HASH_KEY, evaluations=["everything"])
        with self.assertRaisesRegex(ConfigError, "provider"):
            Client(HASH_KEY, provider="nope")
        with self.assertRaisesRegex(ConfigError, "bundle"):
            Client(HASH_KEY, bundle=b"not a bundle")
        with self.assertRaisesRegex(ConfigError, "bundle"):
            Client(HASH_KEY, bundle=Path(tempfile.gettempdir()) / "readmeter-missing.bin")
        self.assertIsInstance(ConfigError("x"), ValueError)

    def test_missing_library_is_reported(self) -> None:
        with self.assertRaisesRegex(LibraryNotFoundError, "READMETER_LIB"):
            Client(HASH_KEY, library=os.path.join(tempfile.gettempdir(), "no-such-readmeter.dll"))

    def test_on_finding_callback_errors_are_contained(self) -> None:
        seen = []

        def callback(finding: dict) -> None:
            seen.append(finding["rule"])
            raise RuntimeError("host bug")

        with Client(HASH_KEY, on_finding=callback) as client:
            with self.assertLogs("readmeter", level="ERROR"):
                self.assertEqual(len(client.sink(OFFSET_QUERY)), 1)
        self.assertEqual(seen, ["firebase.firestore/offset-pagination"])

    def test_concurrent_sinks_are_all_recorded(self) -> None:
        with Client(HASH_KEY) as client:
            per_thread, threads = 200, 8

            def work(t: int) -> None:
                for i in range(per_thread):
                    client.sink({**OFFSET_QUERY, "path": f"c{t}_{i}"})

            pool = [threading.Thread(target=work, args=(t,)) for t in range(threads)]
            for t in pool:
                t.start()
            for t in pool:
                t.join()
            self.assertEqual(client.dropped_calls, 0)
            # Findings are capped at max_findings (200 by default).
            self.assertEqual(len(client.findings()), 200)
            self.assertTrue(client.flush().startswith(b"RM"))


if __name__ == "__main__":
    unittest.main()
