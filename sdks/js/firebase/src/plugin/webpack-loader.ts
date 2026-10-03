/**
 * webpack loader: build-time callsites for `@readmeter/firebase` calls.
 * Register it with `enforce: "pre"` so it sees the original TypeScript/JSX:
 *
 * ```js
 * { test: /\.[cm]?[jt]sx?$/, exclude: /node_modules/, enforce: "pre",
 *   use: "@readmeter/firebase/webpack-loader" }
 * ```
 *
 * Needs `@babel/parser` and `magic-string` installed.
 */

import { transformCallsites } from "./transform.ts";

export interface ReadmeterLoaderOptions {
  /** Callsites are relative to this directory. Default: webpack's `rootContext`. */
  root?: string;
}

/** The subset of webpack's `LoaderContext` the loader uses. */
export interface LoaderContext {
  resourcePath: string;
  resourceQuery?: string;
  rootContext?: string;
  sourceMap?: boolean;
  getOptions?: () => ReadmeterLoaderOptions | undefined;
  callback(error: Error | null, content?: string, map?: unknown, meta?: unknown): void;
}

export default function readmeterLoader(this: LoaderContext, source: string, map?: unknown, meta?: unknown): void {
  let root: string | undefined;
  try {
    root = this.getOptions?.()?.root;
  } catch {
    root = undefined;
  }
  root ??= this.rootContext ?? process.cwd();
  const out = transformCallsites(source, { id: this.resourcePath + (this.resourceQuery ?? ""), root });
  if (!out) {
    this.callback(null, source, map, meta);
    return;
  }
  // A pre-loader sees the original file, so its map is the whole map.
  this.callback(null, out.code, this.sourceMap === false ? undefined : out.map, meta);
}
