"""Optional uploader: ``POST {endpoint}/v1/batches`` with the standard library."""

from __future__ import annotations

import collections
import email.utils
import logging
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

from ._version import __version__

log = logging.getLogger("readmeter")

MAX_PENDING = 8
"""Batches kept for retry when ingest is unreachable. The oldest is dropped beyond this."""


def retry_after_s(header: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Seconds from a ``Retry-After`` header (delta seconds or an HTTP date)."""
    if not header:
        return None
    header = header.strip()
    try:
        return max(0.0, float(header))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return max(0.0, when.timestamp() - (time.time() if now is None else now))


class Sender:
    """Posts batches with backoff and keeps a few undelivered ones for the next attempt.

    429 and 503 honor ``Retry-After`` (at least one second). Other 5xx and
    network errors back off exponentially. Other 4xx responses drop the
    batch: resending the same bytes cannot succeed.
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        timeout: float = 10.0,
        max_attempts: int = 4,
        max_wait: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.url = endpoint.rstrip("/") + "/v1/batches"
        self.api_key = api_key
        self.timeout = timeout
        self.max_attempts = max(1, max_attempts)
        self.max_wait = max_wait
        self._sleep = sleep
        self._pending: collections.deque[bytes] = collections.deque(maxlen=MAX_PENDING)

    def send(self, batch: bytes) -> bool:
        """Queues ``batch`` (if non-empty) and posts everything pending, oldest first.

        Returns ``True`` when nothing is left pending. Never raises.
        """
        if batch:
            if len(self._pending) == self._pending.maxlen:
                log.warning("readmeter: dropping an undelivered batch (queue full)")
            self._pending.append(batch)
        while self._pending:
            if not self._post(self._pending[0]):
                return False
            self._pending.popleft()
        return True

    def _post(self, body: bytes) -> bool:
        """``True`` when the batch is done with (delivered or permanently rejected)."""
        backoff = 1.0
        for attempt in range(self.max_attempts):
            last = attempt == self.max_attempts - 1
            request = urllib.request.Request(
                self.url,
                data=body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/octet-stream",
                    "User-Agent": f"readmeter-python/{__version__}",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as res:
                    res.read()
                return True
            except urllib.error.HTTPError as e:
                status = e.code
                header = e.headers.get("Retry-After") if e.headers else None
                e.close()
                if status in (429, 503):
                    wait = retry_after_s(header)
                    wait = max(1.0, backoff if wait is None else wait)
                elif status >= 500:
                    wait = backoff
                else:
                    log.warning("readmeter: ingest rejected batch with %d; dropping it", status)
                    return True
                reason = f"HTTP {status}"
            except (urllib.error.URLError, OSError) as e:
                wait = backoff
                reason = str(e)
            if last:
                log.warning("readmeter: upload failed (%s); keeping batch for the next send", reason)
                return False
            self._sleep(min(wait, self.max_wait))
            backoff = min(backoff * 2, self.max_wait)
        return False
