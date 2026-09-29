import nodemailer from "nodemailer";

import type { ConsoleEnv } from "./env.ts";

export interface Mailer {
  /** True when SMTP_URL and MAIL_FROM are both set. */
  readonly smtp: boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

export function createMailer(env: ConsoleEnv): Mailer {
  if (env.smtpUrl && !env.mailFrom) {
    console.warn("SMTP_URL is set but MAIL_FROM is missing; invitation mail will be logged instead");
  }
  const smtp = Boolean(env.smtpUrl && env.mailFrom);
  const transport = smtp && env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : null;
  const from = env.mailFrom ?? "";
  return {
    smtp,
    async send(to, subject, text) {
      if (!transport) {
        console.log(JSON.stringify({ msg: "mail", to, subject, text }));
        return;
      }
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
