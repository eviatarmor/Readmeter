/**
 * A jsdom window for react-dom. Imported first by each test file so the
 * globals exist before react-dom loads. The Firebase SDK sees a browser too,
 * so its page and route listeners attach to this window.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Tells React that `act` is in use, so it does not warn.
g.IS_REACT_ACT_ENVIRONMENT = true;

export function container(): HTMLElement {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  return el;
}
