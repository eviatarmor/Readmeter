/**
 * Wasteful callable patterns. The Functions emulator must be on 127.0.0.1:5001.
 * Payloads are sent to the function and are not copied into the Readmeter record.
 */
import { httpsCallable, type Functions } from "@readmeter/firebase/functions";

export async function callableInLoop(fns: Functions): Promise<string> {
  const echo = httpsCallable(fns, "echo");
  for (let i = 0; i < 10; i += 1) await echo({ n: i });
  return "called echo 10 times";
}

export async function largeCallablePayload(fns: Functions): Promise<string> {
  const echo = httpsCallable(fns, "echo");
  const blob = "x".repeat(1_048_576);
  await echo({ blob });
  return `sent ${blob.length} bytes`;
}

export async function callableRetryStorm(fns: Functions): Promise<string> {
  const fail = httpsCallable(fns, "fail");
  for (let i = 0; i < 5; i += 1) {
    try {
      await fail({ n: i });
    } catch {
      // The function rejects on purpose.
    }
  }
  return "failed fail 5 times";
}
