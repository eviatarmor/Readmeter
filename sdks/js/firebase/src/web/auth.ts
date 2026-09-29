/**
 * Drop-in for `firebase/auth`. Wrappers call the real function and then
 * record a method template. Emails, phone numbers, uids, tokens, and
 * verification codes are never copied onto the record.
 *
 * `getIdToken` is patched on the User prototype (verified on `@firebase/auth`
 * 1.13.6). The modular wrapper only makes sure that patch is in place; the
 * prototype records a force refresh once. `getIdTokenResult(true)` is
 * counted because it calls that method. A refresh without `forceRefresh`
 * is not recorded.
 *
 * Node builds stub `signInWithPhoneNumber`. The throw is recorded and
 * rethrown. SMS is counted only when a phone verification send resolves.
 * `ConfirmationResult.confirm` is a sign-in and does not count a second SMS.
 *
 * `signInWithRedirect` navigates away. The record is written when the
 * promise settles, which a full page unload can skip.
 */

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId, nextListenerId } from "../core/session.ts";
import {
  PhoneAuthProvider,
  createUserWithEmailAndPassword as realCreateUserWithEmailAndPassword,
  getIdToken as realGetIdToken,
  initializeAuth as realInitializeAuth,
  onAuthStateChanged as realOnAuthStateChanged,
  onIdTokenChanged as realOnIdTokenChanged,
  sendEmailVerification as realSendEmailVerification,
  sendPasswordResetEmail as realSendPasswordResetEmail,
  setPersistence as realSetPersistence,
  signInAnonymously as realSignInAnonymously,
  signInWithCredential as realSignInWithCredential,
  signInWithCustomToken as realSignInWithCustomToken,
  signInWithEmailAndPassword as realSignInWithEmailAndPassword,
  signInWithEmailLink as realSignInWithEmailLink,
  signInWithPhoneNumber as realSignInWithPhoneNumber,
  signInWithPopup as realSignInWithPopup,
  signInWithRedirect as realSignInWithRedirect,
  signOut as realSignOut,
} from "firebase/auth";

export * from "firebase/auth";

type AnyFn = (...args: unknown[]) => unknown;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

const GET_ID_TOKEN = Symbol.for("readmeter.auth.getIdToken");
const CONFIRM = Symbol.for("readmeter.auth.confirm");
const VERIFY_PHONE = Symbol.for("readmeter.auth.verifyPhoneNumber");
const PROVIDER_ID = /^[a-z0-9._-]{1,32}$/;

let versionWarned = false;
let phonePatched = false;

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

function emit(op: string, at: Timing, extra: Record<string, unknown> = {}): void {
  try {
    const call: Record<string, unknown> = {
      service: "auth",
      op,
      ts_ms: at.ts,
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

/** Warn when Node can read `@firebase/auth` and the major is not 1. The browser has no package read. */
function warnAuthMajor(): void {
  if (versionWarned) return;
  versionWarned = true;
  try {
    const proc = globalThis.process as { versions?: { node?: string }; getBuiltinModule?: (name: string) => { createRequire?: (url: string) => NodeRequire } } | undefined;
    if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") return;
    const builtin = proc.getBuiltinModule("module");
    if (typeof builtin?.createRequire !== "function") return;
    const require = builtin.createRequire(import.meta.url);
    const pkg = require("@firebase/auth/package.json") as { version?: string };
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const major = Number(version.split(".")[0]);
    if (major !== 1) {
      console.debug(`[readmeter] @firebase/auth ${version || "unknown"} is outside the verified 1.x User.getIdToken`);
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function wrapGetIdToken(original: AnyFn): AnyFn {
  const wrapped = function (this: unknown, forceRefresh?: unknown): unknown {
    const at = timing();
    const force = forceRefresh === true;
    const pending = Promise.resolve().then(() => original.call(this, forceRefresh));
    return watch(
      pending,
      () => {
        if (force) emit("token_refresh", at, { method: "getIdToken", force: true });
      },
      (error) => {
        if (force) emit("token_refresh", at, { method: "getIdToken", force: true, error: errorCode(error) });
      },
    );
  } as AnyFn & { [GET_ID_TOKEN]?: boolean };
  wrapped[GET_ID_TOKEN] = true;
  return wrapped;
}

function ensureGetIdTokenPatch(user: unknown): void {
  try {
    if (!user || typeof user !== "object") return;
    const proto = Object.getPrototypeOf(user) as { getIdToken?: AnyFn & { [GET_ID_TOKEN]?: boolean } } | null;
    if (!proto || typeof proto.getIdToken !== "function" || proto.getIdToken[GET_ID_TOKEN]) return;
    warnAuthMajor();
    const desc = Object.getOwnPropertyDescriptor(proto, "getIdToken");
    const wrapped = wrapGetIdToken(proto.getIdToken);
    Object.defineProperty(proto, "getIdToken", {
      configurable: true,
      enumerable: desc?.enumerable ?? false,
      writable: true,
      value: wrapped,
    });
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function isAnonymous(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("user" in value)) return false;
  const user = (value as { user?: unknown }).user;
  if (!user || typeof user !== "object" || !("isAnonymous" in user)) return false;
  return (user as { isAnonymous?: unknown }).isAnonymous === true;
}

function safeProvider(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("providerId" in value)) return undefined;
  const id = (value as { providerId?: unknown }).providerId;
  if (typeof id !== "string" || !PROVIDER_ID.test(id)) return undefined;
  return id;
}

function signExtra(method: string, credential: unknown): { op: string; extra: Record<string, unknown> } {
  const op = method === "signInAnonymously" || isAnonymous(credential) ? "sign_in_anonymous" : "sign_in";
  const extra: Record<string, unknown> = { method };
  const provider = safeProvider(credential);
  if (provider) extra.provider = provider;
  return { op, extra };
}

function patchConfirm(result: unknown): void {
  try {
    if (!result || typeof result !== "object" || !("confirm" in result)) return;
    const host = result as { confirm?: AnyFn & { [CONFIRM]?: boolean } };
    if (typeof host.confirm !== "function" || host.confirm[CONFIRM]) return;
    const original = host.confirm;
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return traced(
        () => Promise.resolve(original.apply(this, args)),
        (credential, at) => {
          const provider = safeProvider(credential);
          const extra: Record<string, unknown> = { method: "confirm" };
          if (provider) extra.provider = provider;
          const op = isAnonymous(credential) ? "sign_in_anonymous" : "sign_in";
          emit(op, at, extra);
        },
        (error, at) => emit("sign_in", at, { method: "confirm", error: errorCode(error) }),
      );
    } as AnyFn & { [CONFIRM]?: boolean };
    wrapped[CONFIRM] = true;
    host.confirm = wrapped;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function persistenceToken(value: unknown): string | undefined {
  // Browser builds export persistence instances. The Node build stubs the
  // same names as functions and puts `type` on the function.
  if (!value || (typeof value !== "object" && typeof value !== "function") || !("type" in value)) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0 || type.length > 32) return undefined;
  return type;
}

function persistenceField(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const tokens: string[] = [];
    for (const item of value) {
      const token = persistenceToken(item);
      if (!token) return undefined;
      tokens.push(token);
    }
    return tokens.length > 0 ? tokens : undefined;
  }
  return persistenceToken(value);
}

function signIn<T>(method: string, run: () => Promise<T>, after?: (value: T) => void): Promise<T> {
  return traced(
    run,
    (value, at) => {
      try {
        after?.(value);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
      ensureGetIdTokenPatch(value && typeof value === "object" && "user" in value ? (value as { user?: unknown }).user : undefined);
      const signed = signExtra(method, value);
      emit(signed.op, at, signed.extra);
    },
    (error, at) => {
      const op = method === "signInAnonymously" ? "sign_in_anonymous" : "sign_in";
      emit(op, at, { method, error: errorCode(error) });
    },
  );
}

function listen(real: AnyFn, method: string): AnyFn {
  return (...args: unknown[]) => {
    const at = timing();
    const listener = nextListenerId();
    const observer = args[1];
    const next = args.slice();
    if (typeof observer === "function") {
      const userNext = observer as AnyFn;
      next[1] = (user: unknown) => {
        ensureGetIdTokenPatch(user);
        return userNext(user);
      };
    } else if (observer && typeof observer === "object" && typeof (observer as { next?: unknown }).next === "function") {
      const userNext = (observer as { next: AnyFn }).next;
      next[1] = { ...(observer as object), next: (user: unknown) => {
        ensureGetIdTokenPatch(user);
        return userNext(user);
      } };
    }
    emit("subscribe", at, { method, listener });
    let unsub: unknown;
    try {
      unsub = real(...next);
    } catch (error) {
      emit("unsubscribe", timing(), { method, listener });
      throw error;
    }
    return () => {
      try {
        if (typeof unsub === "function") (unsub as AnyFn)();
      } finally {
        emit("unsubscribe", timing(), { method, listener });
      }
    };
  };
}

function ensurePhonePatch(): void {
  if (phonePatched) return;
  phonePatched = true;
  try {
    const proto = PhoneAuthProvider.prototype as { verifyPhoneNumber?: AnyFn & { [VERIFY_PHONE]?: boolean } };
    if (typeof proto.verifyPhoneNumber !== "function" || proto.verifyPhoneNumber[VERIFY_PHONE]) return;
    const original = proto.verifyPhoneNumber;
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return traced(
        () => Promise.resolve(original.apply(this, args)),
        (_id, at) => emit("phone", at, { method: "verifyPhoneNumber" }),
        (error, at) => emit("phone", at, { method: "verifyPhoneNumber", error: errorCode(error) }),
      );
    } as AnyFn & { [VERIFY_PHONE]?: boolean };
    wrapped[VERIFY_PHONE] = true;
    proto.verifyPhoneNumber = wrapped;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

ensurePhonePatch();

export const signInWithEmailAndPassword: typeof realSignInWithEmailAndPassword = ((auth, email, password) =>
  signIn("signInWithPassword", () => realSignInWithEmailAndPassword(auth, email, password))) as typeof realSignInWithEmailAndPassword;

export const signInWithEmailLink: typeof realSignInWithEmailLink = ((auth, email, emailLink) =>
  signIn("signInWithEmailLink", () => realSignInWithEmailLink(auth, email, emailLink))) as typeof realSignInWithEmailLink;

export const signInWithCredential: typeof realSignInWithCredential = ((auth, credential) =>
  signIn("signInWithCredential", () => realSignInWithCredential(auth, credential))) as typeof realSignInWithCredential;

export const signInWithCustomToken: typeof realSignInWithCustomToken = ((auth, customToken) =>
  signIn("signInWithCustomToken", () => realSignInWithCustomToken(auth, customToken))) as typeof realSignInWithCustomToken;

export const signInWithPopup: typeof realSignInWithPopup = ((auth, provider, resolver) =>
  signIn("signInWithPopup", () => realSignInWithPopup(auth, provider, resolver))) as typeof realSignInWithPopup;

export const signInWithRedirect: typeof realSignInWithRedirect = ((auth, provider, resolver) =>
  signIn("signInWithRedirect", () => realSignInWithRedirect(auth, provider, resolver))) as typeof realSignInWithRedirect;

export const signInAnonymously: typeof realSignInAnonymously = ((auth) =>
  signIn("signInAnonymously", () => realSignInAnonymously(auth))) as typeof realSignInAnonymously;

export const createUserWithEmailAndPassword: typeof realCreateUserWithEmailAndPassword = ((auth, email, password) =>
  signIn("createUserWithEmailAndPassword", () => realCreateUserWithEmailAndPassword(auth, email, password))) as typeof realCreateUserWithEmailAndPassword;

export const signOut: typeof realSignOut = ((auth) =>
  traced(
    () => realSignOut(auth),
    (_value, at) => emit("sign_out", at, { method: "signOut" }),
    (error, at) => emit("sign_out", at, { method: "signOut", error: errorCode(error) }),
  )) as typeof realSignOut;

export const onAuthStateChanged: typeof realOnAuthStateChanged = listen(realOnAuthStateChanged as AnyFn, "onAuthStateChanged") as typeof realOnAuthStateChanged;

export const onIdTokenChanged: typeof realOnIdTokenChanged = listen(realOnIdTokenChanged as AnyFn, "onIdTokenChanged") as typeof realOnIdTokenChanged;

export const getIdToken: typeof realGetIdToken = ((user, forceRefresh) => {
  ensureGetIdTokenPatch(user);
  return realGetIdToken(user, forceRefresh);
}) as typeof realGetIdToken;

export const sendPasswordResetEmail: typeof realSendPasswordResetEmail = ((auth, email, actionCodeSettings) =>
  traced(
    () => realSendPasswordResetEmail(auth, email, actionCodeSettings),
    (_value, at) => emit("password_reset", at, { method: "sendPasswordResetEmail" }),
    (error, at) => emit("password_reset", at, { method: "sendPasswordResetEmail", error: errorCode(error) }),
  )) as typeof realSendPasswordResetEmail;

export const sendEmailVerification: typeof realSendEmailVerification = ((user, actionCodeSettings) =>
  traced(
    () => realSendEmailVerification(user, actionCodeSettings),
    (_value, at) => emit("email_verification", at, { method: "sendEmailVerification" }),
    (error, at) => emit("email_verification", at, { method: "sendEmailVerification", error: errorCode(error) }),
  )) as typeof realSendEmailVerification;

export const signInWithPhoneNumber: typeof realSignInWithPhoneNumber = ((auth, phoneNumber, appVerifier) =>
  traced(
    () => realSignInWithPhoneNumber(auth, phoneNumber, appVerifier),
    (result, at) => {
      patchConfirm(result);
      emit("phone", at, { method: "signInWithPhoneNumber" });
    },
    (error, at) => emit("phone", at, { method: "signInWithPhoneNumber", error: errorCode(error) }),
  )) as typeof realSignInWithPhoneNumber;

export const setPersistence: typeof realSetPersistence = ((auth, persistence) => {
  const kind = persistenceField(persistence);
  return traced(
    () => realSetPersistence(auth, persistence),
    (_value, at) => emit("init", at, { method: "setPersistence", ...(kind ? { persistence: kind } : {}) }),
    (error, at) => emit("init", at, { method: "setPersistence", ...(kind ? { persistence: kind } : {}), error: errorCode(error) }),
  );
}) as typeof realSetPersistence;

export const initializeAuth: typeof realInitializeAuth = ((app, deps) => {
  const at = timing();
  const kind = persistenceField(deps && typeof deps === "object" && "persistence" in deps ? (deps as { persistence?: unknown }).persistence : undefined);
  try {
    const auth = realInitializeAuth(app, deps);
    emit("init", at, { method: "initializeAuth", ...(kind ? { persistence: kind } : {}) });
    return auth;
  } catch (error) {
    emit("init", at, { method: "initializeAuth", ...(kind ? { persistence: kind } : {}), error: errorCode(error) });
    throw error;
  }
}) as typeof realInitializeAuth;
