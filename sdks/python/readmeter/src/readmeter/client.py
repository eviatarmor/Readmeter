"""The Python client: a thin, thread-safe wrapper over the Rust core."""

from __future__ import annotations

import collections
import json
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Union

from . import _ffi
from ._version import __version__
from .transport import Sender

log = logging.getLogger("readmeter")

_HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")
_PLATFORMS = ("browser", "server", "mobile")
_EVALUATIONS = ("local", "window", "aggregate")

Finding = dict
BundleSource = Union[bytes, bytearray, memoryview, str, os.PathLike]


class ReadmeterError(Exception):
    """An error reported by the Rust core."""


class ConfigError(ReadmeterError, ValueError):
    """The client configuration or rule bundle was rejected."""


def find_bundle() -> Optional[Path]:
    """Default rule bundle: ``READMETER_BUNDLE``, next to the package, then the repo build."""
    env = os.environ.get("READMETER_BUNDLE")
    candidates = [Path(env)] if env else []
    candidates.append(Path(__file__).resolve().parent / "bundle.bin")
    root = _ffi.repo_root()
    if root is not None:
        candidates.append(root / "target" / "rules" / "bundle.bin")
    for path in candidates:
        if path.is_file():
            return path
    return None


def _bundle_bytes(bundle: Optional[BundleSource]) -> bytes:
    if isinstance(bundle, (bytes, bytearray, memoryview)):
        return bytes(bundle)
    if bundle is None:
        path = find_bundle()
        if path is None:
            raise ConfigError(
                "no rule bundle: pass bundle=, set READMETER_BUNDLE, or build one with "
                "`cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec "
                "-- build rules target/rules`"
            )
    else:
        path = Path(bundle)
    try:
        return path.read_bytes()
    except OSError as e:
        raise ConfigError(f"cannot read rule bundle {path}: {e}") from e


class Client:
    """Records raw provider calls and turns them into upload batches.

    ``sink`` never raises: a call the core rejects is logged and dropped.
    The constructor raises :class:`ConfigError` on bad configuration and
    :class:`readmeter.LibraryNotFoundError` when the shared library is missing.
    All methods are safe to call from several threads.
    """

    def __init__(
        self,
        hash_key: str,
        *,
        bundle: Optional[BundleSource] = None,
        provider: str = "firebase",
        platform: str = "server",
        dev: bool = False,
        session: Optional[int] = None,
        sample_rate: float = 1.0,
        evaluations: Optional[Iterable[str]] = None,
        max_events: Optional[int] = None,
        max_findings: Optional[int] = None,
        sdk_name: str = "readmeter-python",
        sdk_version: str = __version__,
        library: Optional[Union[str, os.PathLike]] = None,
        on_finding: Optional[Callable[[Finding], None]] = None,
    ) -> None:
        """
        :param hash_key: The project's 32-hex-character hash key from the console.
            It never leaves the process; the core uses it only to hash ids.
        :param bundle: Rule bundle (``bundle.bin``) as bytes or a path.
            Default: see :func:`find_bundle`.
        :param platform: ``server`` (default), ``browser`` or ``mobile``.
        :param dev: Marks events as coming from a development build.
        :param session: Random 64-bit id for this process. Generated when omitted.
        :param evaluations: Rule tiers to run in-process. The core defaults to ``local``.
            ``window`` needs a library built with the ``window`` feature.
        :param library: Path to the shared library. Default: see ``readmeter._ffi.candidate_paths``.
        :param on_finding: Called with each local finding. Exceptions it raises are logged.
        """
        if not isinstance(hash_key, str) or not _HEX32.match(hash_key):
            raise ConfigError("hash_key must be 32 hex characters")
        if platform not in _PLATFORMS:
            raise ConfigError(f"platform must be one of {', '.join(_PLATFORMS)}")
        if not (isinstance(sample_rate, (int, float)) and 0.0 <= sample_rate <= 1.0):
            raise ConfigError("sample_rate must be within 0..1")
        if session is None:
            session = secrets.randbits(64)
        if not (isinstance(session, int) and 0 <= session < 2**64):
            raise ConfigError("session must be an unsigned 64-bit integer")

        config: dict[str, Any] = {
            "provider": provider,
            "sdk": {"name": sdk_name, "version": sdk_version},
            # Decimal string: the core accepts it and it keeps all 64 bits.
            "session": str(session),
            "hash_key": hash_key,
            "platform": platform,
            "dev": bool(dev),
            "sample_rate": float(sample_rate),
        }
        if evaluations is not None:
            evaluations = list(evaluations)
            bad = [e for e in evaluations if e not in _EVALUATIONS]
            if bad:
                raise ConfigError(f"unknown evaluations {bad}; expected {', '.join(_EVALUATIONS)}")
            config["evaluations"] = evaluations
        if max_events is not None:
            config["max_events"] = int(max_events)
        if max_findings is not None:
            config["max_findings"] = int(max_findings)

        self.session = session
        self._lib = _ffi.load(library)
        self._lock = threading.Lock()
        self._on_finding = on_finding
        self._findings: collections.deque[Finding] = collections.deque(
            maxlen=int(max_findings) if max_findings else 200
        )
        self._send_lock = threading.Lock()
        self._sender: Optional[Sender] = None
        self.dropped_calls = 0
        """Calls ``sink`` dropped because the core rejected them."""

        status, handle = self._lib.client_new(
            json.dumps(config, separators=(",", ":")).encode(), _bundle_bytes(bundle)
        )
        if status != _ffi.STATUS_OK or not handle:
            raise ConfigError(f"core rejected the config or rule bundle: {self._lib.last_error(status)}")
        self._handle: Optional[int] = handle

    # Context manager and lifetime.

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001 - interpreter shutdown
            pass

    @property
    def closed(self) -> bool:
        return self._handle is None

    def close(self) -> None:
        """Frees the core client. Unflushed events are discarded; call ``flush`` first."""
        lock = getattr(self, "_lock", None)
        if lock is None:
            return
        with lock:
            handle, self._handle = getattr(self, "_handle", None), None
            if handle:
                self._lib.client_free(handle)

    # Recording.

    def record(self, raw: Union[dict, str, bytes]) -> list[Finding]:
        """Records one raw call and returns its local findings.

        Raises :class:`ReadmeterError` when the core rejects the call. Prefer
        :meth:`sink` in application code.
        """
        if isinstance(raw, dict):
            data = json.dumps(raw, separators=(",", ":"), allow_nan=False).encode()
        elif isinstance(raw, str):
            data = raw.encode()
        elif isinstance(raw, (bytes, bytearray)):
            data = bytes(raw)
        else:
            raise TypeError("raw call must be a dict, str or bytes")
        with self._lock:
            if self._handle is None:
                raise ReadmeterError("client is closed")
            status, out = self._lib.client_record(self._handle, data)
            if status != _ffi.STATUS_OK:
                raise ReadmeterError(self._lib.last_error(status))
            findings: list[Finding] = json.loads(out) if out else []
            self._findings.extend(findings)
        if self._on_finding is not None:
            for finding in findings:
                try:
                    self._on_finding(finding)
                except Exception:  # noqa: BLE001 - host callback must not break recording
                    log.exception("readmeter: on_finding callback failed")
        return findings

    def sink(self, raw: Union[dict, str, bytes]) -> list[Finding]:
        """Records one raw call (see the raw call reference). Never raises.

        Returns the call's local findings, or ``[]`` when the call was dropped.
        """
        try:
            return self.record(raw)
        except Exception as e:  # noqa: BLE001 - never break the host app
            self.dropped_calls += 1
            log.warning("readmeter: dropped raw call: %s", e)
            return []

    def findings(self) -> list[Finding]:
        """Local findings recorded since the last call (oldest first), then clears them.

        Each finding has ``rule``, ``severity``, ``template``, ``message`` and
        ``wasted``. At most ``max_findings`` (default 200) are kept; older ones are dropped.
        """
        with self._lock:
            out = list(self._findings)
            self._findings.clear()
        return out

    def flush(self, now_ms: Optional[int] = None) -> bytes:
        """Drains buffered events into an encoded batch for ``POST /v1/batches``.

        Returns ``b""`` when there is nothing to send or the client is closed.
        """
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        with self._lock:
            if self._handle is None:
                return b""
            status, out = self._lib.client_flush(self._handle, now_ms)
            if status != _ffi.STATUS_OK:
                raise ReadmeterError(self._lib.last_error(status))
            return out

    def send(self, endpoint: str, api_key: str, **options: Any) -> bool:
        """Flushes and posts the batch to ``{endpoint}/v1/batches``. Never raises.

        Undelivered batches (ingest down, 429/503 after retries) are kept, up
        to a few, and retried on the next ``send``. Returns ``True`` when
        nothing is left pending. ``options`` go to :class:`readmeter.Sender`.
        """
        with self._send_lock:
            sender = self._sender
            url = endpoint.rstrip("/") + "/v1/batches"
            if sender is None or sender.url != url or sender.api_key != api_key:
                sender = self._sender = Sender(endpoint, api_key, **options)
            try:
                batch = self.flush()
            except Exception as e:  # noqa: BLE001 - never break the host app
                log.warning("readmeter: flush failed: %s", e)
                batch = b""
            return sender.send(batch)
