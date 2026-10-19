// POST /api/signin/email: mail a sign-in link to an address.
//
// Every dependency is passed in, so the route's rules are testable without a
// mailer: app/api/signin/email/route.ts wires the real ones. The answer is the
// same for an address with an account and one without, because every address
// gets a link and the first sign-in makes the account.

import { translatorFor } from "./i18n/translate";
import type { SupportedLanguageCode } from "./i18n/languages";
import {
  createLimiter,
  languageOf,
  limitRequest,
  tooManyRequests,
  type Limiter,
} from "./rate-limit.server";
import { checkTrustedOrigin } from "./services.server";
import { normalizeEmail, type SignInTokens } from "./signin-link.server";
import type { SendResult } from "./signin-mail.server";

export interface SignInLinkDeps {
  /** AUTH_RESEND_KEY; absent means the route answers 503. */
  apiKey: string | undefined;
  /** Null without AUTH_SECRET, which also makes the route answer 503. */
  tokens: SignInTokens | null;
  ipLimiter: Limiter;
  addressLimiter: Limiter;
  sendMail: (
    mail: { to: string; link: string; language: SupportedLanguageCode },
    deps: { apiKey: string },
  ) => Promise<SendResult>;
  now?: () => number;
}

const TEN_MINUTES = 10 * 60 * 1000;

/** Link requests per client address. */
export const linkIpLimiter = createLimiter({
  limit: 10,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

/** Links per recipient, from every client together: one inbox cannot be
 * flooded from many networks. */
export const linkAddressLimiter = createLimiter({
  limit: 3,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

export async function handleSignInLinkRequest(
  request: Request,
  deps: SignInLinkDeps,
): Promise<Response> {
  // Before anything is read: this route sends mail for whoever posts to it, so
  // a post from another site is a mail-bomb by proxy.
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });
  const language = languageOf(request.headers);
  const { t } = translatorFor(language);
  const text = (body: string, status: number) =>
    new Response(body, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const { apiKey, tokens } = deps;
  if (!apiKey || !tokens) return text(t("signIn.emailUnavailable"), 503);
  const now = deps.now?.() ?? Date.now();
  const limited = limitRequest(deps.ipLimiter, request, now);
  if (limited) return limited;

  const body: unknown = await request.json().catch(() => null);
  const email = normalizeEmail(
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).email
      : null,
  );
  if (!email) return text(t("signIn.emailInvalid"), 400);
  const perAddress = deps.addressLimiter.take(email, now);
  if (!perAddress.allowed) {
    return tooManyRequests(request, perAddress.retryAfterSeconds);
  }

  const token = tokens.create(email, now);
  // The token rides in the fragment: a query would reach the proxy log, the
  // server log and a Referer, and a fragment reaches none of them.
  const link = `${trusted.origin}/signin/email#${new URLSearchParams({ token })}`;
  const sent = await deps
    .sendMail({ to: email, link, language }, { apiKey })
    .catch((): SendResult => ({ ok: false, reason: "the sender threw" }));
  if (!sent.ok) return text(t("signIn.emailFailed"), 502);
  return new Response(null, { status: 200 });
}
