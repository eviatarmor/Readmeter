import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import readmeter from "../../../dist/plugin/vite.js";

const pkg = fileURLToPath(new URL("../../..", import.meta.url));
const dist = (file: string): string => path.join(pkg, "dist", file);

export default defineConfig({
  root: pkg,
  logLevel: "warn",
  plugins: [readmeter()],
  build: {
    outDir: path.join(pkg, "test/bundle/app/dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: { main: path.join(pkg, "test/bundle/app/main.js") },
      preserveEntrySignatures: "exports-only",
      external: [/^firebase(\/|$)/],
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
      onwarn(warning, warn) {
        const message = warning.message ?? "";
        if (warning.code === "UNRESOLVED_IMPORT" || /could not be resolved|externalized for browser compatibility/i.test(message)) {
          throw new Error(message);
        }
        warn(warning);
      },
    },
  },
  resolve: {
    alias: [
      { find: "@readmeter/firebase/callsite", replacement: dist("callsite.js") },
      { find: "@readmeter/firebase/firestore", replacement: dist("web/firestore.js") },
      { find: "@readmeter/firebase", replacement: dist("index.js") },
    ],
  },
});
