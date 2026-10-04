/**
 * Vite plugin: build-time callsites for `@readmeter/firebase` calls.
 *
 * ```ts
 * import readmeter from "@readmeter/firebase/vite";
 * export default defineConfig({ plugins: [readmeter()] });
 * ```
 *
 * Needs `@babel/parser` and `magic-string` installed next to Vite.
 */

import { transformCallsites } from "./transform.ts";

export interface ReadmeterPluginOptions {
  /** Callsites are relative to this directory. Default: Vite's `root`. */
  root?: string;
}

/** The subset of Vite's `Plugin` this plugin uses, so the types do not depend on a Vite version. */
export interface ReadmeterVitePlugin {
  name: string;
  enforce: "pre";
  configResolved(config: { root: string }): void;
  transform(code: string, id: string): { code: string; map: unknown } | undefined;
}

export function readmeter(options: ReadmeterPluginOptions = {}): ReadmeterVitePlugin {
  let root = options.root ?? process.cwd();
  return {
    name: "readmeter-callsites",
    // Before esbuild/oxc strips types, so positions are the original source's.
    enforce: "pre",
    configResolved(config) {
      if (options.root === undefined) root = config.root;
    },
    transform(code, id) {
      const out = transformCallsites(code, { id, root });
      if (!out) return undefined;
      return { code: out.code, map: out.map };
    },
  };
}

export default readmeter;
