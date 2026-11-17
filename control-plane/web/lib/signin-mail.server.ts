// The sign-in mail, the email change link and the notice to the old address,
// sent through Resend's HTTP API
// (https://resend.com/docs/api-reference/emails/send-email).
//
// A failed send comes back as a value, never a rejection: the route answers it
// with a 502. The key goes in the request header and nowhere else, so neither
// the result nor the log can carry it.
//
// Each accepted send logs one line with Resend's message id and the
// recipient's domain, so support can find a send and look it up in Resend. The
// full address and the link stay out of the log.

import { inspect } from "node:util";
import { credentialValues, redactLogText } from "../../report";
import type { SupportedLanguageCode } from "./i18n/languages";
import type { SignInProduct } from "./signin-product";
import { translatorFor } from "./i18n/translate";
import { SUPPORT_EMAIL } from "./support-email";
import { SIGNIN_LINK_TTL_MS } from "./signin-link.server";

export const SIGNIN_MAIL_FROM = "Isomux <signin@isomux.com>";

const RESEND_URL = "https://api.resend.com/emails";

export type SendResult = { ok: true } | { ok: false; reason: string };

/** Which mail the log line names. */
type MailKind = "sign-in" | "email change" | "email changed notice";

// The id and the address come from outside, so the log keeps only the
// characters an id or a domain can have: no value can forge a log line.
const RESEND_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DOMAIN = /^[a-z0-9.-]{1,253}$/;

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "?";
  const domain = address.slice(at + 1).toLowerCase();
  return DOMAIN.test(domain) ? domain : "?";
}

async function resendIdOf(response: Response): Promise<string> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const id =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).id
        : undefined;
    return typeof id === "string" && RESEND_ID.test(id) ? id : "no id";
  } catch {
    return "no id";
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendSignInMail(
  mail: {
    to: string;
    link: string;
    language: SupportedLanguageCode;
    product?: SignInProduct;
  },
  deps: { apiKey: string; fetch?: typeof fetch },
): Promise<SendResult> {
  const { t } = translatorFor(mail.language);
  return sendLinkMail(
    {
      kind: "sign-in",
      to: mail.to,
      subject: t("signIn.mailSubject"),
      intro: t(
        mail.product === "enterprise"
          ? "signIn.mailIntroEnterprise"
          : "signIn.mailIntro",
      ),
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
      kind: "email change",
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
      kind: "email changed notice",
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
    kind: MailKind;
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
      kind: mail.kind,
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
  mail: {
    kind: MailKind;
    to: string;
    subject: string;
    text: string;
    html: string;
  },
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
    if (response.ok) {
      const id = await resendIdOf(response);
      console.log(
        redact(
          `sign-in mail: Resend accepted ${mail.kind} mail ${id} to @${domainOf(mail.to)}`,
        ),
      );
      return { ok: true };
    }
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    const reason = `Resend answered ${response.status}`;
    console.error(redact(`sign-in mail: ${reason}: ${detail}`));
    return { ok: false, reason };
  } catch (err) {
    console.error(redact(`sign-in mail: ${inspect(err, { depth: 2 })}`));
    return { ok: false, reason: "the mail request failed" };
  }
}
