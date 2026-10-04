"""Readmeter for Python: record provider calls and find cost problems.

The Rust core does all normalization, redaction and rule evaluation; this
package loads it through the C ABI with ``ctypes``.
"""

from ._ffi import LibraryNotFoundError
from ._version import __version__
from .client import Client, ConfigError, ReadmeterError, find_bundle
from .transport import Sender

__all__ = [
    "Client",
    "ConfigError",
    "LibraryNotFoundError",
    "ReadmeterError",
    "Sender",
    "__version__",
    "find_bundle",
]
