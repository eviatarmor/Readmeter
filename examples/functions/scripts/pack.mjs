// The Functions emulator installs from package.json, so the SDK is a packed tarball.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../../../sdks/js/firebase", import.meta.url));
execSync("pnpm pack --pack-destination .", { cwd: sdk, stdio: "inherit", shell: true });
