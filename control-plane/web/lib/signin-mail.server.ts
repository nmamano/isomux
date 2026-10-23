// The sign-in mail, the email change link and the notice to the old address,
// sent through Resend's HTTP API
// (https://resend.com/docs/api-reference/emails/send-email).
//
// A failed send comes back as a value, never a rejection: the route answers it
// with a 502. The key goes in the request header and nowhere else, so neither
// the result nor the log can carry it.

import { inspect } from "node:util";
import { credentialValues, redactLogText } from "../../report";
import type { SupportedLanguageCode } from "./i18n/languages";
import { translatorFor } from "./i18n/translate";
import { SUPPORT_EMAIL } from "./support-email";
import { SIGNIN_LINK_TTL_MS } from "./signin-link.server";

export const SIGNIN_MAIL_FROM = "Isomux <signin@isomux.com>";

const RESEND_URL = "https://api.resend.com/emails";

export type SendResult = { ok: true } | { ok: false; reason: string };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendSignInMail(
  mail: { to: string; link: string; language: SupportedLanguageCode },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const { t } = translatorFor(mail.language);
  return sendLinkMail(
    {
      to: mail.to,
      subject: t("signIn.mailSubject"),
      intro: t("signIn.mailIntro"),
      link: mail.link,
      note: t("signIn.mailNote", { minutes: SIGNIN_LINK_TTL_MS / 60_000 }),
    },
    deps,
  );
}

/** The link that confirms an email change, mailed to the NEW address. */
export async function sendEmailChangeMail(
  mail: { to: string; link: string; language: SupportedLanguageCode },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const { t } = translatorFor(mail.language);
  return sendLinkMail(
    {
      to: mail.to,
      subject: t("account.mailSubject"),
      intro: t("account.mailIntro"),
      link: mail.link,
      note: t("signIn.mailNote", { minutes: SIGNIN_LINK_TTL_MS / 60_000 }),
    },
    deps,
  );
}

/** The notice to the OLD address after the change applied. */
export async function sendEmailChangedNotice(
  mail: { to: string; newEmail: string; language: SupportedLanguageCode },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const { t } = translatorFor(mail.language);
  const body = t("account.noticeBody", {
    email: mail.newEmail,
    support: SUPPORT_EMAIL,
  });
  return send(
    {
      to: mail.to,
      subject: t("account.noticeSubject"),
      text: `${body}\n`,
      html: `<p>${escapeHtml(body)}</p>`,
    },
    deps,
  );
}

function sendLinkMail(
  mail: {
    to: string;
    subject: string;
    intro: string;
    link: string;
    note: string;
  },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const link = escapeHtml(mail.link);
  return send(
    {
      to: mail.to,
      subject: mail.subject,
      text: `${mail.intro}\n\n${mail.link}\n\n${mail.note}\n`,
      html:
        `<p>${escapeHtml(mail.intro)}</p>` +
        `<p><a href="${link}">${link}</a></p>` +
        `<p>${escapeHtml(mail.note)}</p>`,
    },
    deps,
  );
}

async function send(
  mail: { to: string; subject: string; text: string; html: string },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const post = deps.fetch ?? globalThis.fetch;
  const redact = (text: string) =>
    redactLogText(text, [deps.apiKey, ...credentialValues(process.env)]);
  try {
    const response = await post(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: SIGNIN_MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    if (response.ok) return { ok: true };
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const reason = `Resend answered ${response.status}`;
    console.error(redact(`sign-in mail: ${reason}: ${detail}`));
    return { ok: false, reason };
  } catch (err) {
    console.error(redact(`sign-in mail: ${inspect(err, { depth: 2 })}`));
    return { ok: false, reason: "the mail request failed" };
  }
}
