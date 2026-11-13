// The welcome series sender: five plain-text mails through Resend's HTTP API
// (https://resend.com/docs/api-reference/emails/send-email), sent by the
// provisioner from the day an office first goes live.
//
// The web app has its own Resend client for the sign-in mail
// (web/lib/signin-mail.server.ts). This one is separate because the web app
// may not import the provisioner's modules and the provisioner may not import
// the web app's.

import { inspect } from "node:util";
import { credentialValues, redactLogText } from "./report.ts";
import { WELCOME_MAILS, WELCOME_MAIL_LATE_NOTE } from "./welcome-mail-copy.ts";

/**
 * On since Nil approved mail 1 (2026-11-10). Only the mails counted by
 * WELCOME_MAILS_APPROVED send. While off, the provisioner still records when
 * each office first goes live, and sends nothing.
 */
export const WELCOME_MAIL_SENDING = true;

export const WELCOME_MAIL_ADDRESS = "hello@isomux.com";
// The mails speak as Nil, in the first person (Nil, 2026-11-10).
export const WELCOME_MAIL_FROM = `Nil from Isomux <${WELCOME_MAIL_ADDRESS}>`;
export const WELCOME_MAIL_REPLY_TO = "llc@isomux.com";

/** The customer storefront and dashboard. */
export const STOREFRONT_ORIGIN = "https://cloud.isomux.com";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** When each step is due, counted from the moment the office first went live
 * (days 0, 1, 3, 6 and 10: Nil, 2026-11-10). */
export const WELCOME_MAIL_OFFSETS_MS: readonly number[] = [0, 1, 3, 6, 10].map(
  (days) => days * DAY_MS,
);

/** A first mail handled more than this after the office went live opens with
 * WELCOME_MAIL_LATE_NOTE: the office went live before the series sent (Nil,
 * 2026-11-10), or a long outage held it. */
export const WELCOME_MAIL_LATE_MS = 6 * 60 * 60 * 1_000;

const RESEND_URL = "https://api.resend.com/emails";

/** The provisioner env var that holds the Resend key. */
export const WELCOME_MAIL_KEY_ENV = "RESEND_API_KEY";

/** True when the series may send: the flag is on and the key is set. */
export function welcomeMailConfigured(
  env: Record<string, string | undefined> = process.env,
  sending: boolean = WELCOME_MAIL_SENDING,
): boolean {
  return sending && !!env[WELCOME_MAIL_KEY_ENV];
}

/** The page a person opens from the link in the mail body. */
export function unsubscribePageUrl(token: string): string {
  return `${STOREFRONT_ORIGIN}/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** The RFC 8058 one-click endpoint named in List-Unsubscribe. */
export function unsubscribeApiUrl(token: string): string {
  return `${STOREFRONT_ORIGIN}/api/unsubscribe?t=${encodeURIComponent(token)}`;
}

export interface RenderedWelcomeMail {
  subject: string;
  text: string;
}

/** The subject and body of one step as the copy says them, with the
 * placeholders filled, and no unsubscribe line. The page at
 * isomux.com/hosted-welcome passes a marker as `officeUrl`. Throws on a
 * placeholder left unfilled, so neither a customer nor the page sees one. */
export function welcomeMailBody(
  step: number,
  officeUrl: string,
): RenderedWelcomeMail {
  const copy = WELCOME_MAILS[step];
  if (!copy || step >= WELCOME_MAIL_OFFSETS_MS.length) {
    throw new Error(`the welcome series has no step ${step}`);
  }
  const text = copy.body
    .replaceAll("{officeUrl}", officeUrl)
    .replaceAll("{dashboardUrl}", STOREFRONT_ORIGIN);
  const unfilled = (copy.subject + text).match(/\{[A-Za-z_]\w*\}/);
  if (unfilled) {
    throw new Error(
      `welcome mail ${step + 1} has the unfilled placeholder ${unfilled[0]}`,
    );
  }
  return { subject: copy.subject, text };
}

/** The subject and plain-text body of one step, with the unsubscribe line at
 * the end. No postal address: the series is transactional or relationship
 * mail under CAN-SPAM only while it promotes nothing (welcome-mail-copy.ts). */
export function renderWelcomeMail(
  step: number,
  vars: { officeUrl: string; unsubscribeToken: string; late?: boolean },
): RenderedWelcomeMail {
  const { subject, text } = welcomeMailBody(step, vars.officeUrl);
  // The late note is for the first mail only.
  const body =
    vars.late && step === 0 ? `${WELCOME_MAIL_LATE_NOTE}\n\n${text}` : text;
  const footer = `Unsubscribe from these tips: ${unsubscribePageUrl(vars.unsubscribeToken)}`;
  return { subject, text: `${body}\n\n--\n${footer}\n` };
}

export type WelcomeMailSendResult =
  { ok: true } | { ok: false; reason: string };

export interface WelcomeMailSendDeps {
  apiKey: string;
  fetch?: typeof fetch;
}

/**
 * Send one step. A failure comes back as a value, never a rejection. The key
 * goes in the Authorization header and nowhere else.
 */
export async function sendWelcomeMail(
  mail: {
    to: string;
    step: number;
    officeUrl: string;
    unsubscribeToken: string;
    // The first mail goes out late: it opens with WELCOME_MAIL_LATE_NOTE.
    late?: boolean;
  },
  deps: WelcomeMailSendDeps,
): Promise<WelcomeMailSendResult> {
  const redact = (text: string) =>
    redactLogText(text, [deps.apiKey, ...credentialValues(process.env)]);
  try {
    const rendered = renderWelcomeMail(mail.step, {
      officeUrl: mail.officeUrl,
      unsubscribeToken: mail.unsubscribeToken,
      late: mail.late,
    });
    const send = deps.fetch ?? globalThis.fetch;
    const response = await send(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: WELCOME_MAIL_FROM,
        to: [mail.to],
        reply_to: WELCOME_MAIL_REPLY_TO,
        subject: rendered.subject,
        text: rendered.text,
        headers: {
          "List-Unsubscribe": `<${unsubscribeApiUrl(mail.unsubscribeToken)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    if (response.ok) return { ok: true };
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const reason = `Resend answered ${response.status}`;
    console.error(redact(`welcome mail: ${reason}: ${detail}`));
    return { ok: false, reason };
  } catch (err) {
    console.error(redact(`welcome mail: ${inspect(err, { depth: 2 })}`));
    return { ok: false, reason: "the mail request failed" };
  }
}
