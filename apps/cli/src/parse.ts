export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `rm project create <id> [--name <name>] [--org <org_id>]
rm key create <project_id> [--origin <origin>]...
rm key list <project_id>
rm key revoke <key_prefix>
rm findings [--project <id>] [--since 1h|24h|7d] [--rule <id>] [--limit 50] [--json]
rm events [--project <id>] [--limit 20] [--json]
rm stats [--project <id>] [--json]`;

export type Since = "1h" | "24h" | "7d";

export type Command =
  | { kind: "project-create"; id: string; name: string; org: string }
  | { kind: "key-create"; projectId: string; origins: string[] }
  | { kind: "key-list"; projectId: string }
  | { kind: "key-revoke"; prefix: string }
  | { kind: "findings"; project?: string; since?: Since; rule?: string; limit: number; json: boolean }
  | { kind: "events"; project?: string; limit: number; json: boolean }
  | { kind: "stats"; project?: string; json: boolean };

const SINCE = new Set<string>(["1h", "24h", "7d"]);

type FlagKind = "string" | "number" | "boolean" | "strings";

function parseFlags(
  args: string[],
  spec: Record<string, FlagKind>,
): { flags: Record<string, string | number | boolean | string[]>; rest: string[] } {
  const flags: Record<string, string | number | boolean | string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === "boolean") {
      if (flags[name] === true) throw new UsageError(`duplicate flag --${name}`);
      flags[name] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    i += 1;
    if (kind === "strings") {
      const list = Array.isArray(flags[name]) ? (flags[name] as string[]) : [];
      list.push(value);
      flags[name] = list;
      continue;
    }
    if (flags[name] !== undefined) throw new UsageError(`duplicate flag --${name}`);
    if (kind === "number") {
      if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} must be a positive integer`);
      flags[name] = Number(value);
    } else {
      flags[name] = value;
    }
  }
  return { flags, rest };
}

function one(rest: string[], what: string): string {
  const value = rest[0];
  if (!value) throw new UsageError(`missing ${what}`);
  if (rest.length > 1) throw new UsageError(`unexpected argument ${rest[1]}`);
  return value;
}

function optionalString(flags: Record<string, string | number | boolean | string[]>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function parseArgs(argv: string[]): Command {
  // pnpm forwards the `--` separator into the script (`pnpm run rm -- findings`).
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [head, ...rest] = args;
  if (!head) throw new UsageError("missing command");
  if (head === "project") return parseProject(rest);
  if (head === "key") return parseKey(rest);
  if (head === "findings") return parseFindings(rest);
  if (head === "events") return parseEvents(rest);
  if (head === "stats") return parseStats(rest);
  throw new UsageError(`unknown command ${head}`);
}

function parseProject(args: string[]): Command {
  const [action, ...tail] = args;
  if (action !== "create") throw new UsageError("unknown command project");
  const { flags, rest } = parseFlags(tail, { name: "string", org: "string" });
  const id = one(rest, "project id");
  return {
    kind: "project-create",
    id,
    name: optionalString(flags, "name") ?? id,
    org: optionalString(flags, "org") ?? "org_local",
  };
}

function parseKey(args: string[]): Command {
  const [action, ...tail] = args;
  if (action === "create") {
    const { flags, rest } = parseFlags(tail, { origin: "strings" });
    const origins = flags.origin;
    return { kind: "key-create", projectId: one(rest, "project id"), origins: Array.isArray(origins) ? origins : [] };
  }
  if (action === "list") {
    const { rest } = parseFlags(tail, {});
    return { kind: "key-list", projectId: one(rest, "project id") };
  }
  if (action === "revoke") {
    const { rest } = parseFlags(tail, {});
    return { kind: "key-revoke", prefix: one(rest, "key prefix") };
  }
  throw new UsageError("unknown command key");
}

function parseFindings(args: string[]): Command {
  const { flags, rest } = parseFlags(args, {
    project: "string",
    since: "string",
    rule: "string",
    limit: "number",
    json: "boolean",
  });
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  const since = optionalString(flags, "since");
  if (since !== undefined && !SINCE.has(since)) throw new UsageError("--since must be 1h, 24h or 7d");
  const project = optionalString(flags, "project");
  const rule = optionalString(flags, "rule");
  return {
    kind: "findings",
    ...(project !== undefined ? { project } : {}),
    ...(since !== undefined ? { since: since as Since } : {}),
    ...(rule !== undefined ? { rule } : {}),
    limit: typeof flags.limit === "number" ? flags.limit : 50,
    json: flags.json === true,
  };
}

function parseEvents(args: string[]): Command {
  const { flags, rest } = parseFlags(args, { project: "string", limit: "number", json: "boolean" });
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  const project = optionalString(flags, "project");
  return {
    kind: "events",
    ...(project !== undefined ? { project } : {}),
    limit: typeof flags.limit === "number" ? flags.limit : 20,
    json: flags.json === true,
  };
}

function parseStats(args: string[]): Command {
  const { flags, rest } = parseFlags(args, { project: "string", json: "boolean" });
  if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
  const project = optionalString(flags, "project");
  return {
    kind: "stats",
    ...(project !== undefined ? { project } : {}),
    json: flags.json === true,
  };
}
