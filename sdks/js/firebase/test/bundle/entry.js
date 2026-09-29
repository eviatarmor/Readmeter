import { init } from "@readmeter/firebase";
import { get as getDb } from "@readmeter/firebase/database";
import { getDocs } from "@readmeter/firebase/firestore";
import { getDownloadURL } from "@readmeter/firebase/storage";

// Runtime flag so the bundler keeps both the dev and prod wasm branches.
const dev = globalThis.__RM_DEV__ === true;

init({
  apiKey: "rm_bundle_check",
  endpoint: "http://127.0.0.1:9",
  hashKey: "000102030405060708090a0b0c0d0e0f",
  dev,
});

globalThis.__rmGetDocs = getDocs;
globalThis.__rmGetDb = getDb;
globalThis.__rmGetDownloadURL = getDownloadURL;
