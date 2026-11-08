// The enterprise contact form (site/enterprise.html#contact). GET hands the
// page its Turnstile site key. POST checks the request in layers and mails it
// to llc@isomux.com through Resend: a per-IP rate limit, a size cap, a
// honeypot and a minimum fill time (dropped silently, so a bot learns
// nothing), the fields, then Cloudflare Turnstile. Nothing is stored: the mail
// is the only copy.
import {
  clientIp,
  createRateLimiter,
  retryAfterSeconds,
  setRateLimitFields,
} from "./_rate-limit.ts";

export const CONTACT_LIMITS = {
  maxBodyBytes: 20_000,
  /** A form sent sooner than this after the page loaded is a bot's. */
  minFillMs: 3_000,
  maxEmailChars: 254,
  maxCompanyChars: 200,
  maxMessageChars: 5_000,
  /** Each call to Cloudflare or Resend. */
  upstreamTimeoutMs: 10_000,
};

export const TEAM_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"];

/** Personal mail providers: allowed, and marked in the subject for triage. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "qq.com",
  "163.com",
  "126.com",
]);

/** The Turnstile action the page renders its widget with. */
const ACTION = "enterprise-contact";
const HOSTNAMES = new Set(["isomux.com", "www.isomux.com"]);
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND = "https://api.resend.com/emails";
const FROM = "Isomux website <hello@isomux.com>";
const TO = "llc@isomux.com";
const SUBJECT_PREFIX = "[Enterprise form] ";

const limiter = createRateLimiter([
  { name: "10min", quota: 3, windowMs: 10 * 60 * 1000 },
  { name: "day", quota: 10, windowMs: 24 * 60 * 60 * 1000 },
]);

// No whitespace, control character, or character that could make the address
// a list or a display name in reply_to.
const ADDRESS_PART = String.raw`[^\s\x00-\x1f\x7f,;<>"()[\]\\:@]+`;
const EMAIL = new RegExp(
  `^${ADDRESS_PART}@(?:[^\\s\\x00-\\x1f\\x7f,;<>"()[\\]\\\\:@.]+\\.)+[^\\s\\x00-\\x1f\\x7f,;<>"()[\\]\\\\:@.]+$`,
);

function jsonError(
  status: number,
  code: string,
  message: string,
  field?: string,
): Response {
  return Response.json(
    { error: { code, message, ...(field ? { field } : {}) } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function ok(): Response {
  return Response.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const invalid = (field: string, message: string) =>
  jsonError(400, "invalid_request", message, field);

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") return config();
  if (req.method !== "POST")
    return jsonError(
      405,
      "method_not_allowed",
      "This endpoint accepts GET and POST requests only.",
    );
  const ip = clientIp(req);
  const { allowed, quotas } = limiter.check(ip);
  let response: Response;
  if (allowed) {
    response = await send(req, ip);
  } else {
    const wait = retryAfterSeconds(quotas);
    response = jsonError(
      429,
      "rate_limit_exceeded",
      "Too many messages. Try again later.",
    );
    response.headers.set("Retry-After", String(wait));
  }
  setRateLimitFields(response.headers, quotas);
  return response;
}

/**
 * The page's Turnstile site key, once the form can send, and the server's time
 * at load, which the page posts back: the fill time is measured on one clock.
 */
function config(): Response {
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  if (
    !siteKey ||
    !process.env.TURNSTILE_SECRET_KEY ||
    !process.env.RESEND_API_KEY
  )
    return notConfigured();
  return Response.json(
    { turnstileSiteKey: siteKey, startedAt: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function notConfigured(): Response {
  return jsonError(
    503,
    "not_configured",
    "The contact form is not set up on this server.",
  );
}

function tooLarge(): Response {
  return jsonError(
    413,
    "request_too_large",
    `The request body is larger than ${CONTACT_LIMITS.maxBodyBytes} bytes.`,
  );
}

async function send(req: Request, ip: string): Promise<Response> {
  if (Number(req.headers.get("content-length")) > CONTACT_LIMITS.maxBodyBytes)
    return tooLarge();
  let body: unknown;
  try {
    const raw = await req.arrayBuffer();
    if (raw.byteLength > CONTACT_LIMITS.maxBodyBytes) return tooLarge();
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return jsonError(400, "invalid_json", "The JSON body must be an object.");
  const fields = body as Record<string, unknown>;

  // Bots: answer as if sent, and send nothing. startedAt is the server's time
  // from the page's GET.
  const { website, startedAt } = fields;
  if (
    (typeof website === "string" && website !== "") ||
    (website !== undefined && typeof website !== "string") ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    Date.now() - startedAt < CONTACT_LIMITS.minFillMs
  )
    return ok();

  const { email, company, size, message, turnstileToken } = fields;
  if (
    typeof email !== "string" ||
    email.length > CONTACT_LIMITS.maxEmailChars ||
    !EMAIL.test(email)
  )
    return invalid("email", "Enter one valid email address.");
  const companyName = typeof company === "string" ? company.trim() : "";
  if (!companyName || companyName.length > CONTACT_LIMITS.maxCompanyChars)
    return invalid(
      "company",
      `Enter the company name, up to ${CONTACT_LIMITS.maxCompanyChars} characters.`,
    );
  if (typeof size !== "string" || !TEAM_SIZES.includes(size))
    return invalid("size", `Choose a team size: ${TEAM_SIZES.join(", ")}.`);
  const text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > CONTACT_LIMITS.maxMessageChars)
    return invalid(
      "message",
      `Enter a message, up to ${CONTACT_LIMITS.maxMessageChars} characters.`,
    );

  const secret = process.env.TURNSTILE_SECRET_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!secret || !resendKey) return notConfigured();

  if (typeof turnstileToken !== "string" || !turnstileToken)
    return verificationFailed();
  let verdict: { success?: unknown; hostname?: unknown; action?: unknown };
  try {
    const res = await globalThis.fetch(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({
        secret,
        response: turnstileToken,
        remoteip: ip,
      }),
      signal: AbortSignal.timeout(CONTACT_LIMITS.upstreamTimeoutMs),
    });
    verdict = (await res.json()) as typeof verdict;
  } catch (error) {
    console.error(`contact: siteverify failed: ${errorName(error)}`);
    return jsonError(
      502,
      "verification_unavailable",
      "The bot check could not be reached.",
    );
  }
  if (
    verdict.success !== true ||
    typeof verdict.hostname !== "string" ||
    !HOSTNAMES.has(verdict.hostname) ||
    verdict.action !== ACTION
  )
    return verificationFailed();

  const domain = email.slice(email.indexOf("@") + 1).toLowerCase();
  const subject =
    SUBJECT_PREFIX +
    (FREE_MAIL_DOMAINS.has(domain) ? "[free mail] " : "") +
    `${oneLine(companyName)} (${size} people)`;
  try {
    const res = await globalThis.fetch(RESEND, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject,
        text: `From the contact form on isomux.com/enterprise.\n\nEmail: ${email}\nCompany: ${companyName}\nTeam size: ${size}\n\n${text}\n`,
      }),
      signal: AbortSignal.timeout(CONTACT_LIMITS.upstreamTimeoutMs),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  } catch (error) {
    // Only the status or the error's name: never the key, the body or a field.
    console.error(`contact: send failed: ${errorName(error)}`);
    return jsonError(502, "send_failed", "The message could not be sent.");
  }
  return ok();
}

function verificationFailed(): Response {
  return jsonError(
    403,
    "verification_failed",
    "The bot check did not pass. Reload the page and try again.",
  );
}

function errorName(error: unknown): string {
  if (error instanceof Error)
    return error.message.startsWith("Resend answered ")
      ? error.message
      : error.name;
  return "unknown error";
}

/** Control characters become spaces, so a subject stays one header line. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are the point
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}
