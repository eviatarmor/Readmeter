import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as schema from "@readmeter/db/schema";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

import type { Db } from "@readmeter/db";

import type { ConsoleEnv } from "./env.ts";
import { noteInviteLink, stashResetLink } from "./links.ts";
import type { Mailer } from "./mail.ts";

const INVITE_SECONDS = 60 * 60 * 24 * 7;

export function createAuth(db: Db, env: ConsoleEnv, mailer: Mailer) {
  const secure = env.baseURL.startsWith("https:");
  const google =
    env.googleClientId && env.googleClientSecret
      ? { clientId: env.googleClientId, clientSecret: env.googleClientSecret }
      : undefined;
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema,
    }),
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.consoleOrigin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      sendResetPassword: async ({ user, url }) => {
        stashResetLink(user.email, url);
        if (!mailer.smtp) {
          console.log(JSON.stringify({ msg: "password reset link", email: user.email, link: url }));
        }
        await mailer.send(user.email, "Reset your Readmeter password", url);
      },
    },
    ...(google ? { socialProviders: { google } } : {}),
    plugins: [
      organization({
        invitationExpiresIn: INVITE_SECONDS,
        sendInvitationEmail: async (data) => {
          const link = `${env.consoleOrigin}/accept-invitation/${data.id}`;
          noteInviteLink(link);
          if (!mailer.smtp) {
            console.log(JSON.stringify({ msg: "invitation link", email: data.email, link }));
          }
          await mailer.send(
            data.email,
            `Invitation to ${data.organization.name}`,
            `Join ${data.organization.name}: ${link}`,
          );
        },
      }),
    ],
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: {
        sameSite: "lax",
        secure,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
