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
import { WELCOME_MAILS } from "./welcome-mail-copy.ts";

/**
 * OFF until Nil approves the copy in welcome-mail-copy.ts (task 9d2d7d16).
 * While off, the provisioner still records when each office first goes live,
 * and sends nothing.
 */
export const WELCOME_MAIL_SENDING = false;

export const WELCOME_MAIL_FROM = "Isomux <hello@isomux.com>";
export const WELCOME_MAIL_REPLY_TO = "llc@isomux.com";

/**
 * The postal address every mail must carry (CAN-SPAM, 15 U.S.C.
 * 7704(a)(5)(A)(iii)). Empty until Nil fills it; the sender refuses to send
 * while it is empty.
 */
export const WELCOME_MAIL_POSTAL_ADDRESS = "";

/** The customer storefront and dashboard. */
export const STOREFRONT_ORIGIN = "https://cloud.isomux.com";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** When each step is due, counted from the moment the office first went live. */
export const WELCOME_MAIL_OFFSETS_MS: readonly number[] = [0, 1, 3, 7, 14].map(
  (days) => days * DAY_MS,
);

/** A step more than this late is skipped, not sent late. */
export const WELCOME_MAIL_STALE_MS = 48 * 60 * 60 * 1_000;

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

/** The subject and plain-text body of one step, with the unsubscribe line and
 * the postal address at the end. */
export function renderWelcomeMail(
  step: number,
  vars: { officeUrl: string; unsubscribeToken: string; postalAddress: string },
): RenderedWelcomeMail {
  const copy = WELCOME_MAILS[step];
  if (!copy || step >= WELCOME_MAIL_OFFSETS_MS.length) {
    throw new Error(`the welcome series has no step ${step}`);
  }
  const body = copy.body
    .replaceAll("{officeUrl}", vars.officeUrl)
    .replaceAll("{dashboardUrl}", STOREFRONT_ORIGIN);
  const footer =
    `Unsubscribe from these tips: ${unsubscribePageUrl(vars.unsubscribeToken)}\n` +
    vars.postalAddress;
  return { subject: copy.subject, text: `${body}\n\n--\n${footer}\n` };
}

export type WelcomeMailSendResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface WelcomeMailSendDeps {
  apiKey: string;
  fetch?: typeof fetch;
  /** Defaults to WELCOME_MAIL_POSTAL_ADDRESS. */
  postalAddress?: string;
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
  },
  deps: WelcomeMailSendDeps,
): Promise<WelcomeMailSendResult> {
  const postalAddress = deps.postalAddress ?? WELCOME_MAIL_POSTAL_ADDRESS;
  if (!postalAddress.trim()) {
    return { ok: false, reason: "the welcome mail has no postal address" };
  }
  const redact = (text: string) =>
    redactLogText(text, [deps.apiKey, ...credentialValues(process.env)]);
  try {
    const rendered = renderWelcomeMail(mail.step, {
      officeUrl: mail.officeUrl,
      unsubscribeToken: mail.unsubscribeToken,
      postalAddress,
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
