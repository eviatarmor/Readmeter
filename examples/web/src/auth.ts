/**
 * Bad Authentication patterns, one function per client rule.
 * Phone verification runs in the browser. Node's auth build throws on
 * `signInWithPhoneNumber`, so the end-to-end runner does not call that one.
 * `listUsers` inside a request is a Cloud Function, not a button.
 */
import {
  RecaptchaVerifier,
  getIdToken,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signInWithPhoneNumber,
  signOut,
  type Auth,
} from "@readmeter/firebase/auth";

/** memory-persistence: switch the default app to in-memory persistence. */
export async function memoryPersistence(auth: Auth): Promise<string> {
  await setPersistence(auth, inMemoryPersistence);
  return "auth persistence is in memory";
}

/** anonymous-user-churn: two anonymous sign-ins in one session. */
export async function anonymousUserChurn(auth: Auth): Promise<string> {
  if (auth.currentUser) await signOut(auth);
  await signInAnonymously(auth);
  await signOut(auth);
  await signInAnonymously(auth);
  return "signed in anonymously twice";
}

/** id-token-refresh-storm: force-refresh the ID token five times. */
export async function idTokenRefreshStorm(auth: Auth): Promise<string> {
  if (!auth.currentUser) await signInAnonymously(auth);
  const user = auth.currentUser;
  if (!user) return "no user to refresh";
  for (let i = 0; i < 5; i += 1) await getIdToken(user, true);
  return "force-refreshed the ID token 5 times";
}

/** generic/listener-leak: twenty auth listeners from this callsite, none closed. */
export async function authListenerLeak(auth: Auth): Promise<string> {
  for (let i = 0; i < 20; i += 1) onAuthStateChanged(auth, () => {});
  return "opened 20 auth listeners";
}

/**
 * phone-auth-retry: three verification sends. The emulator does not send an SMS.
 * The test number is Firebase's public fictional number.
 */
export async function phoneAuthRetry(auth: Auth): Promise<string> {
  auth.settings.appVerificationDisabledForTesting = true;
  let sent = 0;
  for (let i = 0; i < 3; i += 1) {
    const verifier = new RecaptchaVerifier(auth, "recaptcha", { size: "invisible" });
    try {
      await signInWithPhoneNumber(auth, "+16505553434", verifier);
      sent += 1;
    } finally {
      verifier.clear();
    }
  }
  return `sent ${sent} phone verification codes`;
}
