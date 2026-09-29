import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: pkg,
  build: {
    outDir: path.join(pkg, "test/bundle/dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      input: path.join(pkg, "test/bundle/index.html"),
      onwarn(warning, warn) {
        const message = warning.message ?? "";
        if (
          warning.code === "UNRESOLVED_IMPORT" ||
          /could not be resolved|unresolved|externalized for browser compatibility/i.test(message)
        ) {
          throw new Error(message);
        }
        warn(warning);
      },
    },
  },
  resolve: {
    alias: [
      { find: "@readmeter/firebase/auth", replacement: path.join(pkg, "dist/web/auth.js") },
      { find: "@readmeter/firebase/database", replacement: path.join(pkg, "dist/web/database.js") },
      { find: "@readmeter/firebase/storage", replacement: path.join(pkg, "dist/web/storage.js") },
      { find: "@readmeter/firebase/firestore", replacement: path.join(pkg, "dist/web/firestore.js") },
      { find: "@readmeter/firebase", replacement: path.join(pkg, "dist/index.js") },
    ],
  },
  server: {
    fs: { allow: [pkg] },
  },
});
