from __future__ import annotations

import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from readmeter import Client, Sender
from readmeter.transport import retry_after_s

from .support import HASH_KEY

GET = {"service": "firestore", "op": "get", "ts_ms": 1, "path": "users/u1", "result": {"docs": 1}}


class FakeIngest:
    """Answers each POST with the next scripted (status, headers)."""

    def __init__(self, script: list[tuple[int, dict]]) -> None:
        self.script = list(script)
        self.requests: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = self.rfile.read(int(self.headers["Content-Length"]))
                fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                status, headers = fake.script.pop(0) if fake.script else (202, {})
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class TransportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.waits: list[float] = []

    def ingest(self, script: list[tuple[int, dict]]) -> FakeIngest:
        fake = FakeIngest(script)
        self.addCleanup(fake.close)
        return fake

    def test_send_posts_flushed_bytes_with_bearer_auth(self) -> None:
        fake = self.ingest([])
        with Client(HASH_KEY) as client:
            client.sink(GET)
            self.assertTrue(client.send(fake.endpoint + "/", "rm_key", sleep=self.waits.append))
            self.assertTrue(client.send(fake.endpoint, "rm_key"))  # nothing to send
        self.assertEqual(len(fake.requests), 1)
        req = fake.requests[0]
        self.assertEqual(req["path"], "/v1/batches")
        self.assertEqual(req["headers"]["Authorization"], "Bearer rm_key")
        self.assertEqual(req["headers"]["Content-Type"], "application/octet-stream")
        self.assertTrue(req["body"].startswith(b"RM"))

    def test_retry_after_is_honored_on_429_and_503(self) -> None:
        fake = self.ingest([(429, {"Retry-After": "3"}), (503, {"Retry-After": "0"}), (202, {})])
        sender = Sender(fake.endpoint, "k", sleep=self.waits.append)
        self.assertTrue(sender.send(b"RM\x01\x00"))
        self.assertEqual(self.waits, [3.0, 1.0])  # at least one second
        self.assertEqual(len(fake.requests), 3)

    def test_undelivered_batches_are_kept_for_the_next_send(self) -> None:
        fake = self.ingest([(500, {})] * 2)
        sender = Sender(fake.endpoint, "k", max_attempts=2, sleep=self.waits.append)
        with self.assertLogs("readmeter", level="WARNING"):
            self.assertFalse(sender.send(b"first"))
        self.assertEqual(self.waits, [1.0])
        self.assertTrue(sender.send(b"second"))
        self.assertEqual([r["body"] for r in fake.requests[-2:]], [b"first", b"second"])

    def test_client_errors_drop_the_batch(self) -> None:
        fake = self.ingest([(400, {})])
        sender = Sender(fake.endpoint, "k", sleep=self.waits.append)
        with self.assertLogs("readmeter", level="WARNING"):
            self.assertTrue(sender.send(b"bad"))
        self.assertEqual(len(fake.requests), 1)
        self.assertEqual(self.waits, [])

    def test_unreachable_ingest_never_raises(self) -> None:
        sender = Sender("http://127.0.0.1:9", "k", timeout=1, max_attempts=2, sleep=self.waits.append)
        with self.assertLogs("readmeter", level="WARNING"):
            self.assertFalse(sender.send(b"x"))

    def test_retry_after_parsing(self) -> None:
        self.assertEqual(retry_after_s("5"), 5.0)
        self.assertIsNone(retry_after_s(None))
        self.assertIsNone(retry_after_s("soon"))
        self.assertEqual(retry_after_s("Thu, 01 Jan 1970 00:00:10 GMT", now=4.0), 6.0)


if __name__ == "__main__":
    unittest.main()
