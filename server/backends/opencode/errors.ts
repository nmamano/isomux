import { translatorFor, type Translator } from "../../../shared/i18n/translate.ts";
import { redactLogEntry } from "../../log-redaction.ts";
import type {
  OpenCodeErrorContext,
  OpenCodeStreamSilence,
  SafeOpenCodeError,
} from "./transport.ts";

// Pinned OpenCode 1.18.35: session/retry.ts RETRY_MAX_RETRIES = 5.
const OPENCODE_MAX_RETRIES = 5;

export const PROVIDER_TEXT_LIMIT = 300;

// Free text from OpenCode can hold credentials. Scrub the shapes the shared
// log redactor does not know before it handles known keys and secret values.
function scrubCredentials(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:key|api[_-]?key|token|secret|password)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    );
}

function redactText(value: string): string {
  return redactLogEntry({ value: scrubCredentials(value) }).value;
}

// The provider's own message as one bounded line, or null when it sent none.
// Control and direction characters go: inside a quote, a direction override
// would reverse the rest of the line, our own words included. Redaction runs
// before the cut, so a cut cannot leave part of a secret that the patterns
// no longer match. The cut counts code points, so it never splits one.
export function providerText(message: string | undefined): string | null {
  const line = (message ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim();
  if (!line) return null;
  const text = Array.from(redactText(line));
  return text.length > PROVIDER_TEXT_LIMIT
    ? `${text
        .slice(0, PROVIDER_TEXT_LIMIT - 1)
        .join("")
        .trimEnd()}…`
    : text.join("");
}

// The chat renders a system line as inline markdown. Escape what could turn
// the provider's text into a link, emphasis or code there: markup characters,
// and the "://", "www." and "@" that start an automatic link.
function inertMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]()<>!@]|:(?=\/\/)|(?<=\bwww)\./gi, "\\$&");
}

// A provider that refuses a request explains why, and members must see that
// the refusal is the provider's, not Isomux's (task 1a963907). A 401 stays on
// the authentication path, and a 5xx is a provider fault, not a refusal.
export function openCodeProviderRefusal(
  error: Readonly<SafeOpenCodeError>,
  provider: string,
  words: Translator["t"] = translatorFor("en").t,
): string | null {
  if (error.name !== "APIError") return null;
  const message = providerText(error.message);
  if (message === null) return null;
  const status = error.statusCode;
  const refused =
    status === undefined
      ? /rate.?limit|too many requests|quota|usage limit/i.test(message)
      : status >= 400 && status <= 499 && status !== 401;
  return refused
    ? words("systemEntries.openCodeProviderRefused", { provider, message })
    : null;
}

// Copy for failures that carry no provider message to show.
export function openCodeErrorMessage(
  error: Readonly<SafeOpenCodeError>,
): string {
  const message = error.message ?? "";
  if (error.name === "ContextOverflowError")
    return "The conversation is too long for this model.";
  if (error.name === "ProviderAuthError")
    return "OpenCode authentication is not configured.";
  if (error.statusCode === 429)
    return "The provider rate limit was reached (HTTP 429).";
  if (
    error.statusCode === undefined &&
    /rate.?limit|too many requests/i.test(message)
  )
    return "The provider rate limit was reached.";
  if (error.statusCode === undefined && /overloaded|at capacity/i.test(message))
    return "The provider is busy.";
  if (
    Number.isInteger(error.statusCode) &&
    error.statusCode! >= 400 &&
    error.statusCode! <= 599
  )
    return `The provider returned HTTP ${error.statusCode}.`;
  if (/timeout|timed out/i.test(message) || error.name === "TimeoutError")
    return "The provider did not respond in time.";
  if (
    /connection reset|connection refused|fetch failed|failed to fetch|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|response stream|decompression failed/i.test(
      message + " " + (error.code ?? ""),
    )
  )
    return "The connection to the provider failed.";
  if (
    /^(Agent not found:|Model not found:|Provider not found:)/.test(message) ||
    /^(Config|Configuration)/.test(error.name ?? "")
  )
    return "OpenCode configuration is invalid.";
  if (error.name === "APIError")
    return "The provider could not complete this request.";
  if (error.name === "OutputLengthError")
    return "The model reached its output limit.";
  if (error.name === "AbortedError") return "OpenCode stopped this request.";
  if (error.name === "UnknownError")
    return "OpenCode could not complete this turn.";
  return "OpenCode reported a provider or transport error.";
}

// OpenCode's retry status carries the provider's message, or its own quota
// line for OpenCode's free tier and Go plan.
export function openCodeRetryMessage(
  message: string | undefined,
  attempt: number,
  provider: string,
  words: Translator["t"] = translatorFor("en").t,
): string {
  const text = providerText(message);
  if (text !== null)
    return words("systemEntries.openCodeProviderRetry", {
      provider,
      message: inertMarkdown(text),
      attempt,
      maxAttempts: OPENCODE_MAX_RETRIES,
    });
  const cause = openCodeErrorMessage({ name: "APIError" });
  return `${cause.replace(/\.$/, "")}; retrying ${attempt} of ${OPENCODE_MAX_RETRIES}.`;
}

export function logOpenCodeError(
  error: Readonly<SafeOpenCodeError>,
  context: Readonly<OpenCodeErrorContext> = {},
): void {
  // Never log headers, bodies, metadata or arbitrary object fields.
  console.error(
    "[opencode]",
    JSON.stringify(
      redactLogEntry({
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(error.name ? { name: scrubCredentials(error.name) } : {}),
        ...(error.message ? { message: scrubCredentials(error.message) } : {}),
        ...(error.code ? { code: scrubCredentials(error.code) } : {}),
        ...(error.statusCode !== undefined
          ? { statusCode: error.statusCode }
          : {}),
        ...(error.isRetryable !== undefined
          ? { isRetryable: error.isRetryable }
          : {}),
        ...(context.failure ? { failure: context.failure } : {}),
        ...(context.step ? { step: context.step } : {}),
        ...(context.openCodeLog ? { openCodeLog: context.openCodeLog } : {}),
      }),
    ),
  );
}

// One line per silent event stream. The transport builds every field from
// Isomux state and OpenCode names in a fixed shape, never from a frame body.
export function logOpenCodeStreamSilence(
  silence: Readonly<OpenCodeStreamSilence>,
): void {
  console.error(
    "[opencode]",
    JSON.stringify(
      redactLogEntry({ event: "event_stream_silent", ...silence }),
    ),
  );
}
