/**
 * Runtime for build-time callsites. The Vite plugin and webpack loader import
 * `__rmcs` from here into files that call the wrapped Firebase functions.
 * It shares state with the wrappers through `core/callsite.ts`.
 */
export { __rmcs } from "./core/callsite.ts";
