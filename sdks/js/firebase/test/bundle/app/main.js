// A minimal app: `init` plus the Firestore drop-in, with `firebase` external.
// Built with the Vite plugin; check.mjs measures the JS glue and runs it.
import { flush, init, shutdown, sinkWrite as recordWrite } from "@readmeter/firebase";
import * as fs from "@readmeter/firebase/firestore";
import { getDocs } from "@readmeter/firebase/firestore";

export { flush, init, shutdown };

/** Records two writes: one here, one from a nested arrow function. */
export function run(ref) {
  recordWrite(ref, "set");
  const later = () => recordWrite(ref, "delete");
  later();
}

// Not called by the check (they would reach Firestore); only their callsites are asserted.
export const load = (q) => getDocs(q);
export const loadOne = (r) => fs.getDoc(r);
