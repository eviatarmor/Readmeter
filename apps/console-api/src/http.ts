import type { Context, MiddlewareHandler } from "hono";

import type { Db } from "@readmeter/db";
import { schema } from "@readmeter/db";

export type Role = "owner" | "admin" | "member";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface SessionInfo {
  id: string;
  activeOrganizationId: string | null;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: Date;
}

export type AppVars = {
  user: SessionUser;
  session: SessionInfo;
  workspace?: WorkspaceInfo;
  role?: Role;
};

export function ws(c: Context<AppEnv>): { workspace: WorkspaceInfo; role: Role; user: SessionUser } {
  const workspace = c.var.workspace;
  const role = c.var.role;
  if (!workspace || !role) throw new Error("workspace middleware did not run");
  return { workspace, role, user: c.var.user };
}

export type AppEnv = { Variables: AppVars };

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function rank(role: string): number {
  return RANK[role as Role] ?? -1;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export function fail(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

export function requireRole(min: "admin" | "owner"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (rank(c.var.role ?? "") < rank(min)) return fail(c, 403, "forbidden", "not allowed for this role");
    await next();
  };
}

export async function writeAudit(
  db: Db,
  row: {
    orgId: string;
    actor: string | null;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  await db.insert(schema.auditLog).values({
    orgId: row.orgId,
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    metadata: row.metadata ?? null,
  });
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** `limit` defaults to 50 and caps at 200. A bad value is a 400. */
export function listQuery(url: URL): { limit: number; cursor: string | null } | { error: string } {
  const raw = url.searchParams.get("limit");
  let limit = 50;
  if (raw !== null && raw !== "") {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { error: "limit must be an integer from 1 to 200" };
    }
  }
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor && cursor.length > 0 ? cursor : null };
}

export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function parseTime(value: string | null): Date | null | "bad" {
  if (value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "bad" : date;
}

export function isoDay(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export function rangeWindow(range: string, now = new Date()): { days: number; from: Date } | null {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 0;
  if (!days) return null;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { days, from };
}

export function authFailure(error: unknown): { status: ErrorStatus; message: string } {
  const record = error as { status?: unknown; statusCode?: unknown; message?: unknown; body?: { message?: unknown } };
  const statusRaw = record?.statusCode ?? record?.status;
  const statusNum = typeof statusRaw === "number" ? statusRaw : Number(statusRaw);
  const status: ErrorStatus =
    statusNum === 401 || statusNum === 403 || statusNum === 404 || statusNum === 409 ? statusNum : 400;
  const bodyMessage = record?.body && typeof record.body.message === "string" ? record.body.message : undefined;
  const message =
    bodyMessage ?? (typeof record?.message === "string" && record.message ? record.message : "request failed");
  return { status, message };
}
