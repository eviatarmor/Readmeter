// Bundle signing key helper.
//
//   bundle-key keygen          print a new private seed and its public key
//   bundle-key sign <file>     write the raw 64-byte signature of <file> to stdout,
//                              using READMETER_BUNDLE_SIGNING_KEY
//   bundle-key public          print the public key of READMETER_BUNDLE_SIGNING_KEY
//
// In the server image: `readmeter bundle-keygen`.
import { readFileSync } from "node:fs";

import { generateSigningKey, loadSigner } from "./signing.ts";

function signerFromEnv() {
  const value = process.env.READMETER_BUNDLE_SIGNING_KEY;
  if (!value) throw new Error("READMETER_BUNDLE_SIGNING_KEY is not set");
  return loadSigner(value);
}

const [command, file] = process.argv.slice(2);
switch (command ?? "keygen") {
  case "keygen": {
    const key = generateSigningKey();
    console.log(`READMETER_BUNDLE_SIGNING_KEY=${key.privateSeed}`);
    console.log(`bundlePublicKey: ${key.publicKey}`);
    console.log(`key id: ${key.keyId}`);
    console.error("Keep the first line secret (ingest env). Pass the public key to init({ bundlePublicKey }).");
    break;
  }
  case "public": {
    const signer = signerFromEnv();
    console.log(signer.publicKey);
    break;
  }
  case "sign": {
    if (!file) throw new Error("usage: bundle-key sign <file>");
    process.stdout.write(signerFromEnv().signRaw(readFileSync(file)));
    break;
  }
  default:
    console.error("usage: bundle-key [keygen | public | sign <file>]");
    process.exit(2);
}
