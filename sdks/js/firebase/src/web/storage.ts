/**
 * Drop-in for `firebase/storage`. Wrappers call the real function and then
 * record. Object bytes, download URLs, page tokens, and bucket names stay
 * off the record. `getStream` in the browser build throws; that throw is
 * recorded and rethrown. A stream that is never read is not recorded.
 */

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";
import {
  deleteObject as realDeleteObject,
  getBlob as realGetBlob,
  getBytes as realGetBytes,
  getDownloadURL as realGetDownloadURL,
  getMetadata as realGetMetadata,
  getStream as realGetStream,
  list as realList,
  listAll as realListAll,
  updateMetadata as realUpdateMetadata,
  uploadBytes as realUploadBytes,
  uploadBytesResumable as realUploadBytesResumable,
  uploadString as realUploadString,
} from "firebase/storage";

export * from "firebase/storage";

/** Ten years. Longer max-age values are clamped before they reach the core. */
const MAX_CACHE_AGE_S = 315_360_000;
const MAX_AGE = /(?:^|[,\s])max-age=(\d+)/i;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

let pathWarned = false;

function timing(): Timing {
  const site = callsite();
  const at: Timing = { ts: Date.now(), start: performance.now() };
  if (site) at.site = site;
  return at;
}

function elapsed(start: number): number {
  const us = Math.round((performance.now() - start) * 1000);
  return us < 0 ? 0 : us;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  const text = typeof code === "string" ? code : typeof code === "number" && Number.isFinite(code) ? String(code) : "";
  if (text.length === 0) return "unknown";
  const slash = text.lastIndexOf("/");
  const part = slash >= 0 ? text.slice(slash + 1) : text;
  if (part.length === 0) return "unknown";
  return part.length > 64 ? part.slice(0, 64) : part;
}

function readPath(ref: unknown): string {
  if (ref && typeof ref === "object" && "fullPath" in ref) {
    const path = (ref as { fullPath?: unknown }).fullPath;
    if (typeof path === "string") return path;
  }
  if (!pathWarned) {
    pathWarned = true;
    console.debug("[readmeter] StorageReference.fullPath is missing; recording an empty path");
  }
  return "";
}

function emit(op: string, target: unknown, at: Timing, extra: Record<string, unknown> = {}): void {
  try {
    const call: Record<string, unknown> = {
      service: "storage",
      op,
      ts_ms: at.ts,
      path: readPath(target),
      call_id: nextCallId(),
      duration_us: elapsed(at.start),
    };
    if (at.site) call.callsite = at.site;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) call[key] = value;
    }
    recordRaw(call);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function byteLength(data: unknown): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

function metadataSize(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || !("size" in metadata)) return undefined;
  const size = (metadata as { size?: unknown }).size;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
  if (typeof size === "string" && /^[0-9]+$/.test(size)) {
    const parsed = Number(size);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function contentMajor(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const head = value.split(";", 1)[0] ?? "";
  const major = (head.split("/", 1)[0] ?? "").trim().toLowerCase();
  return /^[a-z]{1,32}$/.test(major) ? major : undefined;
}

/**
 * `undefined` when this call did not observe a metadata object.
 * `"none"` when it did and there is no max-age. A number is max-age seconds.
 */
function cacheControl(metadata: unknown): number | "none" | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as { cacheControl?: unknown }).cacheControl;
  if (typeof raw !== "string" || raw.trim().length === 0) return "none";
  const match = MAX_AGE.exec(raw);
  const digits = match?.[1];
  if (digits === undefined) return "none";
  const seconds = Number(digits);
  if (!Number.isFinite(seconds)) return "none";
  return Math.min(Math.floor(seconds), MAX_CACHE_AGE_S);
}

function contentOf(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || !("contentType" in metadata)) return undefined;
  return contentMajor((metadata as { contentType?: unknown }).contentType);
}

function uploadFacts(data: unknown, metadata: unknown, resumable: boolean): Record<string, unknown> {
  const extra: Record<string, unknown> = { resumable };
  const size = metadataSize(metadata) ?? byteLength(data);
  if (size !== undefined) extra.bytes = size;
  const type = contentOf(metadata);
  if (type) extra.content_type = type;
  const cache = cacheControl(metadata);
  if (cache !== undefined) extra.cache_control = cache;
  return extra;
}

function watch<T>(pending: Promise<T>, ok: (value: T) => void, bad: (error: unknown) => void): Promise<T> {
  return pending.then(
    (value) => {
      try {
        ok(value);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
      return value;
    },
    (error: unknown) => {
      try {
        bad(error);
      } catch (inner) {
        debugOnce(sdkDebug(), inner);
      }
      throw error;
    },
  );
}

function traced<T>(run: () => Promise<T>, ok: (value: T, at: Timing) => void, bad: (error: unknown, at: Timing) => void): Promise<T> {
  const at = timing();
  let pending: Promise<T>;
  try {
    pending = run();
  } catch (error) {
    try {
      bad(error, at);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  return watch(pending, (value) => ok(value, at), (error) => bad(error, at));
}

function countedStream(stream: ReadableStream<Uint8Array>, done: (error: unknown | undefined, bytes: number) => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let settled = false;
  let bytes = 0;
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    try {
      done(error, bytes);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        if (next.value) bytes += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        finish(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      const error = reason && typeof reason === "object" ? reason : undefined;
      finish(error);
      return reader.cancel(reason);
    },
  });
}

export const getBytes: typeof realGetBytes = ((ref, maxDownloadSizeBytes?) =>
  traced(
    () => (maxDownloadSizeBytes === undefined ? realGetBytes(ref) : realGetBytes(ref, maxDownloadSizeBytes)),
    (buf, at) => emit("download", ref, at, { bytes: buf.byteLength }),
    (error, at) => emit("download", ref, at, { error: errorCode(error) }),
  )) as typeof realGetBytes;

export const getBlob: typeof realGetBlob = ((ref, maxDownloadSizeBytes?) =>
  traced(
    () => (maxDownloadSizeBytes === undefined ? realGetBlob(ref) : realGetBlob(ref, maxDownloadSizeBytes)),
    (blob, at) => {
      const extra: Record<string, unknown> = { bytes: blob.size };
      const type = contentMajor(blob.type);
      if (type) extra.content_type = type;
      emit("download", ref, at, extra);
    },
    (error, at) => emit("download", ref, at, { error: errorCode(error) }),
  )) as typeof realGetBlob;

export const getDownloadURL: typeof realGetDownloadURL = ((ref) =>
  traced(
    () => realGetDownloadURL(ref),
    (_url, at) => emit("download_url", ref, at),
    (error, at) => emit("download_url", ref, at, { error: errorCode(error) }),
  )) as typeof realGetDownloadURL;

export const getStream: typeof realGetStream = ((ref, maxDownloadSizeBytes?) => {
  const at = timing();
  let stream: ReturnType<typeof realGetStream>;
  try {
    stream = maxDownloadSizeBytes === undefined ? realGetStream(ref) : realGetStream(ref, maxDownloadSizeBytes);
  } catch (error) {
    try {
      emit("download", ref, at, { error: errorCode(error) });
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  if (!stream || typeof stream.getReader !== "function") {
    emit("download", ref, at, { error: "unknown" });
    return stream;
  }
  try {
    return countedStream(stream as ReadableStream<Uint8Array>, (error, bytes) => {
      const extra: Record<string, unknown> = {};
      if (error) extra.error = errorCode(error);
      else if (bytes > 0) extra.bytes = bytes;
      emit("download", ref, at, extra);
    });
  } catch (error) {
    emit("download", ref, at, { error: errorCode(error) });
    throw error;
  }
}) as typeof realGetStream;

export const getMetadata: typeof realGetMetadata = ((ref) =>
  traced(
    () => realGetMetadata(ref),
    (meta, at) => {
      const extra: Record<string, unknown> = {
        result: { bytes: metadataSize(meta) ?? 0, items: 0 },
        cache_control: cacheControl(meta),
      };
      const type = contentOf(meta);
      if (type) extra.content_type = type;
      emit("get_metadata", ref, at, extra);
    },
    (error, at) => emit("get_metadata", ref, at, { error: errorCode(error) }),
  )) as typeof realGetMetadata;

export const updateMetadata: typeof realUpdateMetadata = ((ref, metadata) =>
  traced(
    () => realUpdateMetadata(ref, metadata),
    (meta, at) => {
      const extra: Record<string, unknown> = { cache_control: cacheControl(meta) };
      const type = contentOf(meta);
      if (type) extra.content_type = type;
      emit("update_metadata", ref, at, extra);
    },
    (error, at) => emit("update_metadata", ref, at, { error: errorCode(error) }),
  )) as typeof realUpdateMetadata;

export const uploadBytes: typeof realUploadBytes = ((ref, data, metadata?) =>
  traced(
    () => (metadata === undefined ? realUploadBytes(ref, data) : realUploadBytes(ref, data, metadata)),
    (result, at) => emit("upload", ref, at, uploadFacts(data, result.metadata, false)),
    (error, at) => emit("upload", ref, at, { resumable: false, error: errorCode(error) }),
  )) as typeof realUploadBytes;

export const uploadString: typeof realUploadString = ((ref, value, format?, metadata?) =>
  traced(
    () => realUploadString(ref, value, format, metadata),
    (result, at) => emit("upload", ref, at, uploadFacts(value, result.metadata, false)),
    (error, at) => emit("upload", ref, at, { resumable: false, error: errorCode(error) }),
  )) as typeof realUploadString;

export const uploadBytesResumable: typeof realUploadBytesResumable = ((ref, data, metadata?) => {
  const at = timing();
  let task: ReturnType<typeof realUploadBytesResumable>;
  try {
    task = metadata === undefined ? realUploadBytesResumable(ref, data) : realUploadBytesResumable(ref, data, metadata);
  } catch (error) {
    emit("upload", ref, at, { resumable: true, error: errorCode(error) });
    throw error;
  }
  try {
    void Promise.resolve(task).then(
      (snap) => {
        const meta = snap && typeof snap === "object" && "metadata" in snap ? (snap as { metadata?: unknown }).metadata : undefined;
        const total = snap && typeof snap === "object" && "totalBytes" in snap ? (snap as { totalBytes?: unknown }).totalBytes : undefined;
        const facts = uploadFacts(data, meta, true);
        if (typeof total === "number" && Number.isFinite(total) && total >= 0) facts.bytes = Math.floor(total);
        emit("upload", ref, at, facts);
      },
      (error: unknown) => emit("upload", ref, at, { resumable: true, error: errorCode(error) }),
    );
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return task;
}) as typeof realUploadBytesResumable;

export const deleteObject: typeof realDeleteObject = ((ref) =>
  traced(
    () => realDeleteObject(ref),
    (_value, at) => emit("delete", ref, at),
    (error, at) => emit("delete", ref, at, { error: errorCode(error) }),
  )) as typeof realDeleteObject;

export const list: typeof realList = ((ref, options?) =>
  traced(
    () => (options === undefined ? realList(ref) : realList(ref, options)),
    (result, at) => {
      const extra: Record<string, unknown> = {
        result: { items: result.items.length, prefixes: result.prefixes.length },
      };
      if (options && typeof options.maxResults === "number" && Number.isFinite(options.maxResults)) {
        extra.max_results = Math.max(0, Math.floor(options.maxResults));
      }
      if (typeof result.nextPageToken === "string" && result.nextPageToken.length > 0) extra.page_token = true;
      emit("list", ref, at, extra);
    },
    (error, at) => emit("list", ref, at, { error: errorCode(error) }),
  )) as typeof realList;

export const listAll: typeof realListAll = ((ref) =>
  traced(
    () => realListAll(ref),
    (result, at) =>
      emit("list_all", ref, at, {
        result: { items: result.items.length, prefixes: result.prefixes.length },
      }),
    (error, at) => emit("list_all", ref, at, { error: errorCode(error) }),
  )) as typeof realListAll;
