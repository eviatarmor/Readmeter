let warned = false;

/** One console.debug when a Firestore object does not match the shape we read. */
export function warnShape(detail: string): void {
  if (warned) return;
  warned = true;
  void import("firebase/app")
    .then((mod) => {
      const version = (mod as { SDK_VERSION?: string }).SDK_VERSION ?? "unknown";
      console.debug(`[readmeter] Firestore query shape was not recognized (firebase ${version}). ${detail}`);
    })
    .catch(() => {
      console.debug(`[readmeter] Firestore query shape was not recognized (firebase unknown). ${detail}`);
    });
}
