//! C ABI for native hosts.
//!
//! Conventions:
//! - Every function returns an [`RmStatus`]; 0 is success.
//! - Inputs are UTF-8 JSON as `(ptr, len)`; nothing needs NUL termination.
//! - Outputs are [`RmBuf`]s owned by Rust; release them with `rm_buf_free`.
//! - After a non-zero status, `rm_last_error` returns the message for the
//!   calling thread.
//! - No function panics across the boundary.
//!
//! A client is not thread-safe; hosts serialize access (one client per
//! thread, or a mutex).
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use readmeter_runtime::Client;

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RmStatus {
    Ok = 0,
    NullArgument = 1,
    Error = 2,
    Panic = 3,
}

/// Byte buffer owned by Rust.
#[repr(C)]
pub struct RmBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl RmBuf {
    const EMPTY: RmBuf = RmBuf {
        ptr: ptr::null_mut(),
        len: 0,
        cap: 0,
    };

    fn from_vec(v: Vec<u8>) -> Self {
        let mut v = std::mem::ManuallyDrop::new(v);
        RmBuf {
            ptr: v.as_mut_ptr(),
            len: v.len(),
            cap: v.capacity(),
        }
    }
}

/// Opaque client handle.
pub struct RmClient(Client);

thread_local! {
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_error(msg: String) {
    LAST_ERROR.with(|e| *e.borrow_mut() = msg.into_bytes());
}

fn guard(f: impl FnOnce() -> Result<(), String>) -> RmStatus {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => RmStatus::Ok,
        Ok(Err(msg)) => {
            set_error(msg);
            RmStatus::Error
        }
        Err(_) => {
            set_error("internal panic".into());
            RmStatus::Panic
        }
    }
}

/// # Safety
/// `ptr` must be valid for `len` bytes, or null with `len == 0`.
unsafe fn slice<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if ptr.is_null() {
        return (len == 0).then_some(&[]);
    }
    // SAFETY: caller guarantees ptr/len describe a live allocation.
    Some(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// Creates a client. On success `*out` receives a handle to free with
/// `rm_client_free`.
///
/// `config_json` is UTF-8 JSON. `bundle` is the bytes of `bundle.bin`.
///
/// # Safety
/// Pointers must be valid for their lengths; `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_client_new(
    config_json: *const u8,
    config_len: usize,
    bundle: *const u8,
    bundle_len: usize,
    out: *mut *mut RmClient,
) -> RmStatus {
    if out.is_null() {
        return RmStatus::NullArgument;
    }
    // SAFETY: forwarded caller contract.
    let (Some(config), Some(bundle)) = (unsafe { slice(config_json, config_len) }, unsafe {
        slice(bundle, bundle_len)
    }) else {
        return RmStatus::NullArgument;
    };
    guard(|| {
        let client = Client::from_bytes(config, bundle).map_err(|e| e.to_string())?;
        // SAFETY: `out` checked non-null above.
        unsafe { *out = Box::into_raw(Box::new(RmClient(client))) };
        Ok(())
    })
}

/// Records one raw call. `*findings_out` receives a JSON array of findings
/// from local rules (possibly `[]`). Each object has `rule`, `severity`,
/// `template`, `message` and `wasted` (unit name to an integer). `evidence`
/// is not included; it stays in the batch.
///
/// # Safety
/// `client` must come from `rm_client_new`; other pointers valid as usual.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_client_record(
    client: *mut RmClient,
    raw_json: *const u8,
    raw_len: usize,
    findings_out: *mut RmBuf,
) -> RmStatus {
    if client.is_null() || findings_out.is_null() {
        return RmStatus::NullArgument;
    }
    // SAFETY: forwarded caller contract.
    let Some(raw) = (unsafe { slice(raw_json, raw_len) }) else {
        return RmStatus::NullArgument;
    };
    guard(|| {
        // SAFETY: non-null, created by rm_client_new, not aliased per contract.
        let client = unsafe { &mut (*client).0 };
        let json = client.record_json(raw).map_err(|e| e.to_string())?;
        // SAFETY: checked non-null.
        unsafe { *findings_out = RmBuf::from_vec(json.into_bytes()) };
        Ok(())
    })
}

/// Drains buffered events into an encoded batch to POST to ingest.
/// `*batch_out` has `len == 0` when there is nothing to send.
///
/// # Safety
/// `client` must come from `rm_client_new`; `batch_out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_client_flush(
    client: *mut RmClient,
    now_ms: u64,
    batch_out: *mut RmBuf,
) -> RmStatus {
    if client.is_null() || batch_out.is_null() {
        return RmStatus::NullArgument;
    }
    guard(|| {
        // SAFETY: see rm_client_record.
        let client = unsafe { &mut (*client).0 };
        let bytes = client.flush(now_ms).map_err(|e| e.to_string())?;
        let buf = bytes.map_or(RmBuf::EMPTY, RmBuf::from_vec);
        // SAFETY: checked non-null.
        unsafe { *batch_out = buf };
        Ok(())
    })
}

/// Copies the calling thread's last error message into `*out`.
///
/// # Safety
/// `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_last_error(out: *mut RmBuf) -> RmStatus {
    if out.is_null() {
        return RmStatus::NullArgument;
    }
    let msg = LAST_ERROR.with(|e| e.borrow().clone());
    // SAFETY: checked non-null.
    unsafe { *out = RmBuf::from_vec(msg) };
    RmStatus::Ok
}

/// # Safety
/// `buf` must come from this library and not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_buf_free(buf: RmBuf) {
    if buf.ptr.is_null() {
        return;
    }
    // SAFETY: ptr/len/cap came from a Vec<u8> leaked by RmBuf::from_vec.
    drop(unsafe { Vec::from_raw_parts(buf.ptr, buf.len, buf.cap) });
}

/// # Safety
/// `client` must come from `rm_client_new` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rm_client_free(client: *mut RmClient) {
    if client.is_null() {
        return;
    }
    // SAFETY: created by Box::into_raw in rm_client_new.
    drop(unsafe { Box::from_raw(client) });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(buf: &RmBuf) -> &[u8] {
        if buf.ptr.is_null() {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(buf.ptr, buf.len) }
    }

    #[test]
    fn roundtrip_through_c_abi() {
        let config = serde_json::json!({
            "provider": "firebase",
            "sdk": {"name": "readmeter-cpp", "version": "0"},
            "session": 1,
            "hash_key": "0123456789abcdef0123456789abcdef"
        })
        .to_string();
        let bundle = readmeter_rules::Bundle::default().encode().expect("bundle");
        let raw =
            r#"{"service":"firestore","op":"get","ts_ms":1,"path":"a/b","result":{"docs":1}}"#;

        unsafe {
            let mut client = ptr::null_mut();
            let s = rm_client_new(
                config.as_ptr(),
                config.len(),
                bundle.as_ptr(),
                bundle.len(),
                &mut client,
            );
            assert_eq!(s, RmStatus::Ok);

            let mut findings = RmBuf::EMPTY;
            assert_eq!(
                rm_client_record(client, raw.as_ptr(), raw.len(), &mut findings),
                RmStatus::Ok
            );
            assert_eq!(bytes(&findings), b"[]");
            rm_buf_free(findings);

            let mut batch = RmBuf::EMPTY;
            assert_eq!(rm_client_flush(client, 2, &mut batch), RmStatus::Ok);
            assert!(bytes(&batch).starts_with(b"RM"));
            rm_buf_free(batch);

            let bad = b"{";
            let mut ignored = RmBuf::EMPTY;
            assert_eq!(
                rm_client_record(client, bad.as_ptr(), bad.len(), &mut ignored),
                RmStatus::Error
            );
            let mut err = RmBuf::EMPTY;
            rm_last_error(&mut err);
            assert!(!bytes(&err).is_empty());
            rm_buf_free(err);

            rm_client_free(client);
        }
    }
}
