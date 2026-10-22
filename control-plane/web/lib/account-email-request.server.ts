// The account page's routes: change the account's email (request, then
// confirm from the link mailed to the new address), and remove the Google
// sign-in.
//
// Every dependency is passed in, like signin-link-request.server.ts, so the
// rules are testable without a session, a store, Stripe or a mailer: the route
// files under app/api/account wire the real ones.

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
import {
  normalizeEmail,
  type EmailChangeClaims,
  type LinkTokens,
} from "./signin-link.server";
import type { SendResult } from "./signin-mail.server";
import type { EmailChangeOutcome, EmailChangeRefusal } from "../../signup";
import type { CustomerEmailResult } from "../../stripe/customer-email";

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** One string field of a JSON object body, or null. */
async function field(request: Request, name: string): Promise<unknown> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[name]
    : null;
}

const TEN_MINUTES = 10 * 60 * 1000;

/** Change requests per client address. */
export const changeIpLimiter = createLimiter({
  limit: 10,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

/** Change links per account. */
export const changeAccountLimiter = createLimiter({
  limit: 3,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

/** Change links per new address, from every account together. */
export const changeAddressLimiter = createLimiter({
  limit: 3,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

/** Confirm attempts per client address. */
export const confirmIpLimiter = createLimiter({
  limit: 10,
  windowMs: TEN_MINUTES,
  maxKeys: 10_000,
});

export interface EmailChangeRequestDeps {
  /** AUTH_RESEND_KEY; absent means the route answers 503. */
  apiKey: string | undefined;
  /** Null without AUTH_SECRET, which also makes the route answer 503. */
  tokens: LinkTokens<EmailChangeClaims> | null;
  /** The signed-in account, or null. */
  accountId: () => Promise<string | null>;
  ipLimiter: Limiter;
  accountLimiter: Limiter;
  addressLimiter: Limiter;
  refusal: (
    accountId: string,
    newEmail: string,
  ) => Promise<EmailChangeRefusal | null>;
  sendMail: (
    mail: { to: string; link: string; language: SupportedLanguageCode },
    deps: { apiKey: string },
  ) => Promise<SendResult>;
  now?: () => number;
}

/** POST /api/account/email {email}: mail a change link to the new address. */
export async function handleEmailChangeRequest(
  request: Request,
  deps: EmailChangeRequestDeps,
): Promise<Response> {
  // Before anything is read: this route sends mail, so a post from another
  // site is a mail-bomb by proxy.
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });
  const language = languageOf(request.headers);
  const { t } = translatorFor(language);
  const { apiKey, tokens } = deps;
  if (!apiKey || !tokens) {
    return text(t("account.changeEmailUnavailable"), 503);
  }
  const accountId = await deps.accountId();
  if (!accountId) return new Response(null, { status: 401 });
  const now = deps.now?.() ?? Date.now();
  const limited = limitRequest(deps.ipLimiter, request, now);
  if (limited) return limited;

  const email = normalizeEmail(await field(request, "email"));
  if (!email) return text(t("signIn.emailInvalid"), 400);
  // Per account, so one session cannot mail many inboxes; per target address,
  // so many accounts cannot flood one inbox.
  for (const [limiter, key] of [
    [deps.accountLimiter, accountId],
    [deps.addressLimiter, email],
  ] as const) {
    const decision = limiter.take(key, now);
    if (!decision.allowed) {
      return tooManyRequests(request, decision.retryAfterSeconds);
    }
  }

  const refusal = await deps.refusal(accountId, email);
  if (refusal === "unchanged") {
    return text(t("account.changeEmailUnchanged"), 400);
  }
  if (refusal === "taken") return text(t("account.changeEmailTaken"), 409);
  if (refusal === "no-account") return new Response(null, { status: 401 });

  const token = tokens.create({ a: accountId, e: email }, now);
  // In the fragment, like the sign-in link: a query would reach the proxy log,
  // the server log and a Referer.
  const link = `${trusted.origin}/account/email#${new URLSearchParams({ token })}`;
  const sent = await deps
    .sendMail({ to: email, link, language }, { apiKey })
    .catch((): SendResult => ({ ok: false, reason: "the sender threw" }));
  if (!sent.ok) return text(t("signIn.emailFailed"), 502);
  return new Response(null, { status: 200 });
}

export interface EmailChangeConfirmDeps {
  /** AUTH_RESEND_KEY, for the notice to the old address. */
  apiKey: string | undefined;
  tokens: LinkTokens<EmailChangeClaims> | null;
  ipLimiter: Limiter;
  refusal: (
    accountId: string,
    newEmail: string,
  ) => Promise<EmailChangeRefusal | null>;
  stripeCustomers: (accountId: string) => Promise<string[]>;
  /** Throws when Stripe is not configured; the route answers that as a
   * failure, with the token unspent. */
  updateStripeEmail: (
    customerId: string,
    email: string,
    idempotencyKey: string,
  ) => Promise<CustomerEmailResult>;
  change: (args: {
    accountId: string;
    newEmail: string;
  }) => Promise<EmailChangeOutcome>;
  sendNotice: (
    mail: { to: string; newEmail: string; language: SupportedLanguageCode },
    deps: { apiKey: string },
  ) => Promise<SendResult>;
  now?: () => number;
}

/** POST /api/account/email/confirm {token}: apply the change the link names.
 * No session needed: the token binds the account and the new address. */
export async function handleEmailChangeConfirm(
  request: Request,
  deps: EmailChangeConfirmDeps,
): Promise<Response> {
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });
  const language = languageOf(request.headers);
  const { t } = translatorFor(language);
  const now = deps.now?.() ?? Date.now();
  const limited = limitRequest(deps.ipLimiter, request, now);
  if (limited) return limited;
  const { tokens } = deps;
  if (!tokens) return text(t("account.changeEmailUnavailable"), 503);

  // A refused link is a bare 400 or 404: the page words it, with a way to ask
  // for a new one.
  const raw = await field(request, "token");
  const token = typeof raw === "string" ? raw : "";
  // The token alone names the account and the address; nothing else in the
  // body is read.
  const checked = tokens.check(token, now);
  if (!checked.ok) return new Response(null, { status: 400 });
  const { a: accountId, e: email } = checked.claims;
  const done = () => Response.json({ email });

  const refusal = await deps.refusal(accountId, email);
  if (refusal === "taken") return text(t("account.changeEmailTaken"), 409);
  if (refusal === "no-account") return new Response(null, { status: 404 });
  if (refusal === "unchanged") {
    // Opened again after the change applied: what the customer asked for is
    // what is there.
    tokens.redeem(token, now);
    return done();
  }

  // Stripe first, so that a "changed" answer never leaves receipts at the old
  // address. The key is per link and per customer: a retry of this link
  // replays its writes, and a later link (a move back, say) makes new ones.
  // Until every write landed the link stays unspent, so the customer can open
  // it again.
  const customers = await deps.stripeCustomers(accountId);
  for (const customer of customers) {
    const result = await deps
      .updateStripeEmail(
        customer,
        email,
        `email-change-${checked.nonce}-${customer}`,
      )
      .catch((): CustomerEmailResult => "failed");
    if (result === "missing") {
      console.warn(
        `email change for account ${accountId}: Stripe customer ${customer} is gone; skipped`,
      );
      continue;
    }
    if (result !== "updated") {
      console.error(
        `email change for account ${accountId}: Stripe customer ${customer} was not updated`,
      );
      return text(t("account.confirmFailed"), 502);
    }
  }

  const redeemed = tokens.redeem(token, now);
  if (!redeemed.ok) return new Response(null, { status: 400 });
  const outcome = await deps.change({ accountId, newEmail: email });
  if (!outcome.ok) {
    if (outcome.code === "no-account") {
      return new Response(null, { status: 404 });
    }
    // Another account took the address between the check and the change.
    // Stripe already holds an address this customer proved they read.
    console.error(
      `email change for account ${accountId}: the address was taken after ` +
        `Stripe customers ${customers.join(", ") || "(none)"} were updated`,
    );
    return text(t("account.changeEmailTaken"), 409);
  }
  if (outcome.changed && deps.apiKey) {
    const sent = await deps
      .sendNotice(
        { to: outcome.oldEmail, newEmail: email, language },
        { apiKey: deps.apiKey },
      )
      .catch((): SendResult => ({ ok: false, reason: "the sender threw" }));
    if (!sent.ok) {
      console.error(
        `email change for account ${accountId}: the notice to the old address was not sent`,
      );
    }
  }
  return done();
}

export interface GoogleRemovalDeps {
  accountId: () => Promise<string | null>;
  remove: (accountId: string) => Promise<boolean>;
}

/** POST /api/account/google/remove: unbind the account's Google sign-in. */
export async function handleGoogleRemoval(
  request: Request,
  deps: GoogleRemovalDeps,
): Promise<Response> {
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });
  const accountId = await deps.accountId();
  if (!accountId) return new Response(null, { status: 401 });
  const removed = await deps.remove(accountId);
  return new Response(null, { status: removed ? 200 : 404 });
}
