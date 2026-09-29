import type { ApiErrorBody, Page } from "@readmeter/console-api/contract";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ApiInit = Omit<RequestInit, "redirect"> & { redirect?: boolean };

function safeNext(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { redirect = true, headers, body, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    body,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
  if (response.status === 401 && redirect && typeof window !== "undefined") {
    const next = safeNext(`${window.location.pathname}${window.location.search}`);
    if (!window.location.pathname.startsWith("/sign-in")) {
      window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
    }
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      payload?.error.code ?? "request_failed",
      payload?.error.message ?? response.statusText,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function collectPages<T>(path: string, maxPages = 5): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(path, "http://console.local");
    if (!url.searchParams.has("limit")) url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await api<Page<T>>(`${url.pathname}${url.search}`);
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return items;
}
