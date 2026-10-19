import {
  translatorFor,
  type Translator,
} from "../../../shared/i18n/translate.ts";
import { redactLogEntry } from "../../log-redaction.ts";
import {
  inertMarkdown,
  providerRefusal,
  providerText,
  scrubCredentials,
} from "../provider-text.ts";
import type {
  OpenCodeErrorContext,
  OpenCodeStreamSilence,
  SafeOpenCodeError,
} from "./transport.ts";

// Pinned OpenCode 1.18.35: session/retry.ts RETRY_MAX_RETRIES = 5.
const OPENCODE_MAX_RETRIES = 5;

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
  if (!refused) return null;
  const line = providerRefusal(provider, message, words);
  return FREE_TIER_REFUSAL.test(message)
    ? `${line}\n${words("systemEntries.openCodeFreeTierHint")}`
    : line;
}

// OpenCode's words for this refusal blame the client, but this office got it
// after heavy free-tier volume from one server while another machine with the
// same OpenCode version and config was served (2026-10-17). So a second line
// names the likely cause, without claiming it.
const FREE_TIER_REFUSAL = /free tier can only be used from within OpenCode/i;

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
