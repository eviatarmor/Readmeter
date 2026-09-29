/** Dev-only secret. Production must set BETTER_AUTH_SECRET. */
export const DEV_AUTH_SECRET = "readmeter-dev-secret-change-me-please";

export interface ConsoleEnv {
  port: number;
  secret: string;
  /** True when BETTER_AUTH_SECRET was not set and the dev default is in use. */
  devSecret: boolean;
  baseURL: string;
  consoleOrigin: string;
  googleClientId?: string;
  googleClientSecret?: string;
  smtpUrl?: string;
  mailFrom?: string;
  ingestPublicUrl: string;
  staticDir?: string;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): ConsoleEnv {
  const production = source.NODE_ENV === "production";
  const secret = source.BETTER_AUTH_SECRET?.trim() ?? "";
  if (!secret && production) {
    throw new Error("BETTER_AUTH_SECRET is required when NODE_ENV is production");
  }
  const devSecret = secret.length === 0;
  if (devSecret) {
    console.warn(
      "BETTER_AUTH_SECRET is unset; using a fixed dev secret. Do not use this outside local development.",
    );
  }
  const baseURL = source.BETTER_AUTH_URL?.trim() || "http://127.0.0.1:8091";
  const port = Number(source.PORT ?? 8091);
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  const googleClientId = source.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = source.GOOGLE_CLIENT_SECRET?.trim() || undefined;
  return {
    port,
    secret: devSecret ? DEV_AUTH_SECRET : secret,
    devSecret,
    baseURL,
    consoleOrigin: source.CONSOLE_ORIGIN?.trim() || "http://localhost:5174",
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientSecret ? { googleClientSecret } : {}),
    ...(source.SMTP_URL?.trim() ? { smtpUrl: source.SMTP_URL.trim() } : {}),
    ...(source.MAIL_FROM?.trim() ? { mailFrom: source.MAIL_FROM.trim() } : {}),
    ingestPublicUrl: source.INGEST_PUBLIC_URL?.trim() || "http://127.0.0.1:8090",
    ...(source.CONSOLE_STATIC_DIR?.trim() ? { staticDir: source.CONSOLE_STATIC_DIR.trim() } : {}),
  };
}
