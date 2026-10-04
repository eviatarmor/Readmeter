# readmeter (Python)

Record raw Firebase calls from Python and find cost problems. The package
loads the Readmeter Rust core through its C ABI (`crates/bindings/ffi`) with
`ctypes`; normalization, redaction, rules and batching all happen in Rust.
Standard library only, Python 3.9+, MIT.

This is the sink API only: you build each raw call yourself. Drop-in
wrappers for the Firebase Admin SDK come later.

## Install from source

From the repository root:

```sh
cargo build -p readmeter-ffi --release --features firebase,database,storage,auth,functions
cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
pip install ./sdks/python/readmeter
```

The shared library is looked up in `READMETER_LIB`, next to the package,
then in the checkout's `target/release` and `target/debug`. The rule bundle
comes from `bundle=`, `READMETER_BUNDLE`, a `bundle.bin` next to the package,
then `target/rules/bundle.bin`. To ship both inside the package, copy them
into `src/readmeter/` before installing or building a wheel.

## Use

```python
from readmeter import Client

with Client(hash_key="000102030405060708090a0b0c0d0e0f") as client:
    findings = client.sink({
        "service": "firestore", "op": "query", "ts_ms": 1000,
        "path": "posts", "query": {"limit": 20, "offset": 200},
        "result": {"docs": 20, "bytes": 20000},
    })
    # findings[0]["rule"] == "firebase.firestore/offset-pagination"
    client.send("http://127.0.0.1:8090", "rm_dev_key")  # or: body = client.flush()
```

- `sink(raw)` never raises; rejected calls are logged on the `readmeter`
  logger and counted in `client.dropped_calls`. `record(raw)` raises instead.
- `findings()` returns local findings since the last call.
- `flush()` returns the encoded batch for `POST /v1/batches` (`b""` when empty).
- `send(endpoint, api_key)` posts it with Bearer auth, honoring `Retry-After`
  on 429/503, and keeps up to 8 undelivered batches for the next call.
- The constructor raises `ConfigError` on bad config and
  `LibraryNotFoundError` when the library is missing.
- Every method is thread-safe.

Raw call format: `docs/content/docs/reference/raw-calls.mdx`. Full guide:
`docs/content/docs/sdk/python.mdx`.

## Tests

```sh
cargo build -p readmeter-ffi --release --features firebase,database,storage,auth,functions,window
cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
./scripts/build-wasm-server.sh   # optional: also checks envelopes through the evaluator
cd sdks/python/readmeter && PYTHONPATH=src python -m unittest discover -s tests -t .
```

The conformance test runs every single-session fixture in
`conformance/fixtures/` and checks findings like the JS runner. With the
server core built and Node on `PATH`, it also decodes each flushed batch
with the evaluator and compares envelopes with `expect_envelopes`.
