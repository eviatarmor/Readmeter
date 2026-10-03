/**
 * Build-time callsites, shared by the Vite plugin and the webpack loader.
 *
 * Finds calls to wrapped functions imported from `@readmeter/firebase` and its
 * web subpaths and rewrites the callee `f` to `__rmcs("src/a.ts:10:5", f)`.
 * `__rmcs` returns a function that runs `f` with that callsite pending, so
 * arguments, `this`, return value and exceptions are unchanged. The position
 * is the callee's line and 1-based column in the original source, the same
 * convention as a V8 stack frame.
 *
 * Build-time only. Never imported by the runtime entries.
 */

import { parse, type ParserPlugin } from "@babel/parser";
import MagicString, { type SourceMap } from "magic-string";

/** Runtime module the injected import points at. */
export const RUNTIME_MODULE = "@readmeter/firebase/callsite";

/**
 * Exports that record a callsite, per import source. Keep in sync with
 * `src/web/*.ts` and `src/web/sink.ts`; a test checks every name exists.
 */
export const WRAPPED: Readonly<Record<string, readonly string[]>> = {
  "@readmeter/firebase": ["sink", "sinkWrite", "sinkListener"],
  "@readmeter/firebase/firestore": [
    "getDocs",
    "getDocsFromServer",
    "getDocsFromCache",
    "getDoc",
    "getDocFromServer",
    "getDocFromCache",
    "getCountFromServer",
    "getAggregateFromServer",
    "setDoc",
    "updateDoc",
    "deleteDoc",
    "addDoc",
    "runTransaction",
    "onSnapshot",
    "writeBatch",
  ],
  "@readmeter/firebase/database": [
    "get",
    "set",
    "update",
    "remove",
    "runTransaction",
    "push",
    "onValue",
    "onChildAdded",
    "onChildChanged",
    "onChildRemoved",
    "onChildMoved",
    "goOnline",
    "goOffline",
  ],
  "@readmeter/firebase/storage": [
    "getBytes",
    "getBlob",
    "getDownloadURL",
    "getStream",
    "getMetadata",
    "updateMetadata",
    "uploadBytes",
    "uploadString",
    "uploadBytesResumable",
    "deleteObject",
    "list",
    "listAll",
  ],
  "@readmeter/firebase/auth": [
    "signInWithEmailAndPassword",
    "signInWithEmailLink",
    "signInWithCredential",
    "signInWithCustomToken",
    "signInWithPopup",
    "signInWithRedirect",
    "signInAnonymously",
    "createUserWithEmailAndPassword",
    "signOut",
    "onAuthStateChanged",
    "onIdTokenChanged",
    "sendPasswordResetEmail",
    "sendEmailVerification",
    "signInWithPhoneNumber",
    "setPersistence",
    "initializeAuth",
  ],
  "@readmeter/firebase/functions": ["httpsCallable", "httpsCallableFromURL"],
};

const WRAPPED_SETS = new Map<string, Set<string>>(Object.entries(WRAPPED).map(([source, names]) => [source, new Set(names)]));

/** Extensions the transform parses. Others (`.vue`, `.svelte`, `.css`, ...) are left alone. */
export const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

export interface TransformResult {
  code: string;
  map: SourceMap;
  /** Number of calls that got a callsite. */
  calls: number;
}

export interface TransformOptions {
  /** Absolute path of the file being transformed (query string allowed). */
  id: string;
  /** Project root; callsites are relative to it, with forward slashes. */
  root: string;
}

interface Node {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

function stripQuery(id: string): string {
  const q = id.search(/[?#]/);
  return q >= 0 ? id.slice(0, q) : id;
}

/** `file` relative to `root`, forward slashes. Falls back to the absolute path off-root on another drive. */
export function relativePath(file: string, root: string): string {
  const f = slash(file);
  const r = slash(root).replace(/\/+$/, "");
  const fl = f.toLowerCase();
  const rl = r.toLowerCase();
  // Windows paths compare case-insensitively; keep the file's own casing.
  const caseless = /^[a-z]:\//i.test(f);
  if (r && (caseless ? fl.startsWith(`${rl}/`) : f.startsWith(`${r}/`))) return f.slice(r.length + 1);
  const fp = f.split("/");
  const rp = r.split("/");
  if (fp[0] && rp[0] && (caseless ? fp[0].toLowerCase() !== rp[0].toLowerCase() : fp[0] !== rp[0])) return f;
  let i = 0;
  while (i < fp.length && i < rp.length && (caseless ? fp[i]?.toLowerCase() === rp[i]?.toLowerCase() : fp[i] === rp[i])) i += 1;
  return [...rp.slice(i).map(() => ".."), ...fp.slice(i)].join("/");
}

/** Cheap check before parsing. */
export function shouldTransform(id: string, code: string): boolean {
  if (id.startsWith("\0") || id.includes("\0")) return false;
  const file = slash(stripQuery(id));
  if (!SCRIPT_FILE.test(file)) return false;
  if (file.includes("/node_modules/")) return false;
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")) return false;
  return code.includes("@readmeter/firebase");
}

function parserPlugins(file: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = ["decorators-legacy", "importAttributes", "explicitResourceManagement"];
  if (/\.[cm]?tsx?$/.test(file)) {
    plugins.push("typescript");
    if (file.endsWith(".tsx")) plugins.push("jsx");
  } else {
    plugins.push("jsx");
  }
  return plugins;
}

// ---- scope tracking -------------------------------------------------------
// A local binding with an imported name shadows the import inside its scope.
// Calls through a shadowed name are left alone.

type Scope = Set<string>;

function patternNames(node: unknown, out: string[]): void {
  if (!isNode(node)) return;
  switch (node.type) {
    case "Identifier":
      out.push(node.name as string);
      return;
    case "ObjectPattern":
      for (const prop of (node.properties as unknown[]) ?? []) {
        if (!isNode(prop)) continue;
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of (node.elements as unknown[]) ?? []) patternNames(el, out);
      return;
    case "AssignmentPattern":
      patternNames(node.left, out);
      return;
    case "RestElement":
      patternNames(node.argument, out);
      return;
    case "TSParameterProperty":
      patternNames(node.parameter, out);
      return;
    default:
      return;
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeParameters",
  "implements",
]);

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/** `var` names declared in a function body, not crossing nested functions. */
function hoistedVars(node: Node, out: string[]): void {
  for (const child of children(node)) {
    if (FUNCTION_TYPES.has(child.type) || child.type === "ClassBody") continue;
    if (child.type === "VariableDeclaration" && child.kind === "var") {
      for (const decl of (child.declarations as Node[]) ?? []) patternNames(decl.id, out);
    }
    hoistedVars(child, out);
  }
}

/** Lexical declarations directly in a statement list. */
function lexicalNames(statements: unknown, out: string[]): void {
  if (!Array.isArray(statements)) return;
  for (const raw of statements) {
    let stmt = raw as unknown;
    if (isNode(stmt) && (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration")) {
      stmt = stmt.declaration;
    }
    if (!isNode(stmt)) continue;
    if (stmt.type === "VariableDeclaration" && stmt.kind !== "var") {
      for (const decl of (stmt.declarations as Node[]) ?? []) patternNames(decl.id, out);
    } else if (
      stmt.type === "FunctionDeclaration" ||
      stmt.type === "ClassDeclaration" ||
      stmt.type === "TSEnumDeclaration" ||
      stmt.type === "TSImportEqualsDeclaration"
    ) {
      if (isNode(stmt.id)) patternNames(stmt.id, out);
    } else if (stmt.type === "TSModuleDeclaration" && isNode(stmt.id) && stmt.id.type === "Identifier") {
      patternNames(stmt.id, out);
    }
  }
}

/** Names a node binds for its own subtree, or undefined when it opens no scope. */
function scopeOf(node: Node, parent: Node | undefined): Scope | undefined {
  const names: string[] = [];
  if (FUNCTION_TYPES.has(node.type)) {
    for (const param of (node.params as unknown[]) ?? []) patternNames(param, names);
    if (node.type === "FunctionExpression" && isNode(node.id)) patternNames(node.id, names);
    if (isNode(node.body)) {
      if (node.body.type === "BlockStatement") {
        hoistedVars(node.body, names);
        lexicalNames(node.body.body, names);
      }
    }
    return new Set(names);
  }
  if (node.type === "ClassExpression" && isNode(node.id)) {
    patternNames(node.id, names);
    return new Set(names);
  }
  if (node.type === "BlockStatement" || node.type === "StaticBlock") {
    // A function body was already handled by its function.
    if (parent && FUNCTION_TYPES.has(parent.type) && parent.body === node) return undefined;
    lexicalNames(node.body, names);
    return new Set(names);
  }
  if (node.type === "SwitchStatement") {
    for (const c of (node.cases as Node[]) ?? []) lexicalNames(c.consequent, names);
    return new Set(names);
  }
  if (node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement") {
    const init = node.type === "ForStatement" ? node.init : node.left;
    if (isNode(init) && init.type === "VariableDeclaration" && init.kind !== "var") {
      for (const decl of (init.declarations as Node[]) ?? []) patternNames(decl.id, names);
    }
    return new Set(names);
  }
  if (node.type === "CatchClause") {
    patternNames(node.param, names);
    return new Set(names);
  }
  return undefined;
}

// ---- transform ------------------------------------------------------------

interface Imports {
  /** Local name -> imported name, for named imports of wrapped functions. */
  named: Map<string, string>;
  /** Namespace local -> source. */
  namespaces: Map<string, string>;
  /** End offset of the last import declaration of a wrapped source. */
  insertAt: number;
}

function collectImports(program: Node): Imports {
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  let insertAt = -1;
  for (const stmt of (program.body as Node[]) ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    if (stmt.importKind === "type" || stmt.importKind === "typeof") continue;
    const source = (stmt.source as Node | undefined)?.value;
    if (typeof source !== "string") continue;
    const wrapped = WRAPPED_SETS.get(source);
    if (!wrapped) continue;
    let used = false;
    for (const spec of (stmt.specifiers as Node[]) ?? []) {
      if (spec.type === "ImportSpecifier") {
        if (spec.importKind === "type" || spec.importKind === "typeof") continue;
        const imported = spec.imported as Node;
        const name = imported.type === "Identifier" ? (imported.name as string) : (imported.value as string);
        const local = (spec.local as Node).name as string;
        if (wrapped.has(name)) {
          named.set(local, `${source}#${name}`);
          used = true;
        }
      } else if (spec.type === "ImportNamespaceSpecifier") {
        namespaces.set((spec.local as Node).name as string, source);
        used = true;
      }
    }
    if (used && typeof stmt.end === "number") insertAt = Math.max(insertAt, stmt.end);
  }
  return { named, namespaces, insertAt };
}

function shadowed(name: string, scopes: Scope[]): boolean {
  for (const scope of scopes) if (scope.has(name)) return true;
  return false;
}

/** The node whose start is the reported column, or undefined when the callee is not a wrapped function. */
function wrappedCallee(callee: Node, imports: Imports, scopes: Scope[]): Node | undefined {
  if (callee.type === "Identifier") {
    const name = callee.name as string;
    if (!imports.named.has(name) || shadowed(name, scopes)) return undefined;
    return callee;
  }
  if (callee.type === "MemberExpression" && isNode(callee.object) && callee.object.type === "Identifier") {
    const ns = callee.object.name as string;
    const source = imports.namespaces.get(ns);
    if (!source || shadowed(ns, scopes)) return undefined;
    const prop = callee.property as Node;
    let name: string | undefined;
    if (!callee.computed && prop.type === "Identifier") name = prop.name as string;
    else if (callee.computed && prop.type === "StringLiteral") name = prop.value as string;
    if (!name || !WRAPPED_SETS.get(source)?.has(name)) return undefined;
    return prop;
  }
  return undefined;
}

function freeName(code: string): string {
  let name = "__rmcs";
  for (let i = 1; new RegExp(`\\b${name}\\b`).test(code); i += 1) name = `__rmcs${i}`;
  return name;
}

/**
 * Returns `undefined` when the file has nothing to rewrite or does not parse
 * (the bundler then reports its own syntax error).
 */
export function transformCallsites(code: string, options: TransformOptions): TransformResult | undefined {
  if (!shouldTransform(options.id, code)) return undefined;
  const file = stripQuery(options.id);
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: "unambiguous",
      plugins: parserPlugins(file),
      errorRecovery: false,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as Node;
  } catch {
    return undefined;
  }
  const program = ast.program as Node;
  const imports = collectImports(program);
  if (imports.insertAt < 0 || (imports.named.size === 0 && imports.namespaces.size === 0)) return undefined;

  const rel = relativePath(file, options.root);
  const helper = freeName(code);
  const s = new MagicString(code);
  let calls = 0;

  const scopes: Scope[] = [];
  const visit = (node: Node, parent: Node | undefined): void => {
    const scope = scopeOf(node, parent);
    if (scope) scopes.push(scope);
    if (node.type === "CallExpression" && isNode(node.callee)) {
      const callee = node.callee;
      const at = wrappedCallee(callee, imports, scopes);
      if (at?.loc && typeof callee.start === "number" && typeof callee.end === "number") {
        const site = `${rel}:${at.loc.start.line}:${at.loc.start.column + 1}`;
        s.appendLeft(callee.start, `${helper}(${JSON.stringify(site)}, `);
        s.prependRight(callee.end, ")");
        calls += 1;
      }
    }
    for (const child of children(node)) visit(child, node);
    if (scope) scopes.pop();
  };
  visit(program, undefined);

  if (calls === 0) return undefined;
  // Same line as the last wrapped import, so later line numbers do not move.
  s.appendRight(imports.insertAt, `;import { __rmcs as ${helper} } from ${JSON.stringify(RUNTIME_MODULE)};`);
  const map = s.generateMap({ hires: true, source: file, includeContent: true });
  return { code: s.toString(), map, calls };
}
