// The sign-in mail, sent through Resend's HTTP API
// (https://resend.com/docs/api-reference/emails/send-email).
//
// A failed send comes back as a value, never a rejection: the route answers it
// with a 502. The key goes in the request header and nowhere else, so neither
// the result nor the log can carry it.

import { inspect } from "node:util";
import { credentialValues, redactLogText } from "../../report";
import type { SupportedLanguageCode } from "./i18n/languages";
import { translatorFor } from "./i18n/translate";
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
  const minutes = SIGNIN_LINK_TTL_MS / 60_000;
  const intro = t("signIn.mailIntro");
  const note = t("signIn.mailNote", { minutes });
  const link = escapeHtml(mail.link);
  const send = deps.fetch ?? globalThis.fetch;
  const redact = (text: string) =>
    redactLogText(text, [deps.apiKey, ...credentialValues(process.env)]);
  try {
    const response = await send(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: SIGNIN_MAIL_FROM,
        to: [mail.to],
        subject: t("signIn.mailSubject"),
        text: `${intro}\n\n${mail.link}\n\n${note}\n`,
        html:
          `<p>${escapeHtml(intro)}</p>` +
          `<p><a href="${link}">${link}</a></p>` +
          `<p>${escapeHtml(note)}</p>`,
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
