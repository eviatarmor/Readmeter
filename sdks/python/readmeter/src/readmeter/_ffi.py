"""ctypes bindings for the C ABI in ``crates/bindings/ffi/include/readmeter.h``.

Ownership: every ``RmBuf`` the library fills belongs to Rust. It is copied
into Python ``bytes`` and released with ``rm_buf_free`` before returning.
The client handle is released with ``rm_client_free``.
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path
from typing import Optional

STATUS_OK = 0
STATUS_NULL_ARGUMENT = 1
STATUS_ERROR = 2
STATUS_PANIC = 3

_PKG_DIR = Path(__file__).resolve().parent


class LibraryNotFoundError(OSError):
    """The Readmeter shared library could not be located or loaded."""


class RmBuf(ctypes.Structure):
    _fields_ = [
        ("ptr", ctypes.POINTER(ctypes.c_uint8)),
        ("len", ctypes.c_size_t),
        ("cap", ctypes.c_size_t),
    ]


def library_name() -> str:
    if sys.platform == "win32":
        return "readmeter_ffi.dll"
    if sys.platform == "darwin":
        return "libreadmeter_ffi.dylib"
    return "libreadmeter_ffi.so"


def repo_root() -> Optional[Path]:
    """The source checkout this package lives in, if any (development)."""
    for parent in _PKG_DIR.parents:
        if (parent / "Cargo.toml").is_file() and (parent / "crates" / "bindings" / "ffi").is_dir():
            return parent
    return None


def candidate_paths() -> list[Path]:
    """Search order: ``READMETER_LIB``, next to the package, then the repo's ``target/``."""
    out: list[Path] = []
    env = os.environ.get("READMETER_LIB")
    if env:
        out.append(Path(env))
    name = library_name()
    out.append(_PKG_DIR / name)
    root = repo_root()
    if root is not None:
        out.append(root / "target" / "release" / name)
        out.append(root / "target" / "debug" / name)
    return out


class Lib:
    """A loaded library with typed function pointers."""

    def __init__(self, path: Path) -> None:
        self.path = path
        lib = ctypes.CDLL(str(path))
        buf_p = ctypes.POINTER(RmBuf)
        bytes_p = ctypes.c_char_p
        client_p = ctypes.c_void_p

        lib.rm_client_new.argtypes = [
            bytes_p,
            ctypes.c_size_t,
            bytes_p,
            ctypes.c_size_t,
            ctypes.POINTER(client_p),
        ]
        lib.rm_client_new.restype = ctypes.c_int32
        lib.rm_client_record.argtypes = [client_p, bytes_p, ctypes.c_size_t, buf_p]
        lib.rm_client_record.restype = ctypes.c_int32
        lib.rm_client_flush.argtypes = [client_p, ctypes.c_uint64, buf_p]
        lib.rm_client_flush.restype = ctypes.c_int32
        lib.rm_last_error.argtypes = [buf_p]
        lib.rm_last_error.restype = ctypes.c_int32
        lib.rm_buf_free.argtypes = [RmBuf]
        lib.rm_buf_free.restype = None
        lib.rm_client_free.argtypes = [client_p]
        lib.rm_client_free.restype = None
        self._lib = lib

    def take(self, buf: RmBuf) -> bytes:
        """Copies a Rust-owned buffer into ``bytes`` and frees it."""
        try:
            if not buf.ptr or buf.len == 0:
                return b""
            return ctypes.string_at(buf.ptr, buf.len)
        finally:
            self._lib.rm_buf_free(buf)

    def last_error(self, status: int) -> str:
        """Message for a failed call. Must run on the thread that made the call."""
        if status == STATUS_NULL_ARGUMENT:
            return "null argument"
        buf = RmBuf()
        if self._lib.rm_last_error(ctypes.byref(buf)) != STATUS_OK:
            return f"status {status}"
        msg = self.take(buf).decode("utf-8", "replace")
        return msg or f"status {status}"

    def client_new(self, config: bytes, bundle: bytes) -> tuple[int, Optional[int]]:
        out = ctypes.c_void_p()
        status = self._lib.rm_client_new(config, len(config), bundle, len(bundle), ctypes.byref(out))
        return status, out.value

    def client_record(self, handle: int, raw: bytes) -> tuple[int, bytes]:
        buf = RmBuf()
        status = self._lib.rm_client_record(handle, raw, len(raw), ctypes.byref(buf))
        if status != STATUS_OK:
            return status, b""
        return status, self.take(buf)

    def client_flush(self, handle: int, now_ms: int) -> tuple[int, bytes]:
        buf = RmBuf()
        status = self._lib.rm_client_flush(handle, now_ms, ctypes.byref(buf))
        if status != STATUS_OK:
            return status, b""
        return status, self.take(buf)

    def client_free(self, handle: int) -> None:
        self._lib.rm_client_free(handle)


_loaded: dict[str, Lib] = {}


def load(path: Optional[os.PathLike[str] | str] = None) -> Lib:
    """Loads (once per path) the library at ``path`` or the first candidate found."""
    tried = [Path(path)] if path is not None else candidate_paths()
    for candidate in tried:
        key = str(candidate)
        if key in _loaded:
            return _loaded[key]
        if not candidate.is_file():
            continue
        try:
            lib = Lib(candidate)
        except (OSError, AttributeError) as e:
            raise LibraryNotFoundError(f"could not load {candidate}: {e}") from e
        _loaded[key] = lib
        return lib
    listed = "\n  ".join(str(p) for p in tried)
    raise LibraryNotFoundError(
        "Readmeter shared library not found. Set READMETER_LIB, or build it with "
        "`cargo build -p readmeter-ffi --release`. Tried:\n  " + listed
    )
