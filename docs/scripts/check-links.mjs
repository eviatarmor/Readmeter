// Fails when a page links to a /docs path that has no page. Run after
// gen-rules.mjs so the generated rule pages exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../content/docs");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".mdx")) files.push(full);
  }
})(root);

const pages = new Set(
  files.map((file) => {
    const rel = path.relative(root, file).split(path.sep).join("/").replace(/\.mdx$/, "");
    return ("/docs/" + rel.replace(/(^|\/)index$/, "")).replace(/\/$/, "");
  }),
);

let bad = 0;
const pattern = /\]\((\/docs[^)#\s]*)|href="(\/docs[^"#]*)/g;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(pattern)) {
    const url = (match[1] ?? match[2]).replace(/\/$/, "");
    if (!pages.has(url)) {
      bad += 1;
      console.error(`${path.relative(root, file)}: broken link ${url}`);
    }
  }
}
console.log(`links: ${files.length} pages checked, ${bad} broken`);
if (bad > 0) process.exit(1);
