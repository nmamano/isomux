import { redactLogEntry } from "../../log-redaction.ts";
import type { OpenCodeErrorContext, SafeOpenCodeError } from "./transport.ts";

// Provider text is diagnostic data, not member-facing copy.
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

export function openCodeRetryMessage(
  message: string | undefined,
  attempt: number,
): string {
  const status = message?.match(
    /\b(?:HTTP(?: status)?|status(?: code)?|error(?: code)?)\s*:?\s*([45]\d\d)\b/i,
  );
  const cause = openCodeErrorMessage({
    name: "APIError",
    message,
    ...(status ? { statusCode: Number(status[1]) } : {}),
  });
  // Pinned OpenCode 1.18.35: session/retry.ts RETRY_MAX_RETRIES = 5.
  return `${cause.replace(/\.$/, "")}; retrying ${attempt} of 5.`;
}

export function logOpenCodeError(
  error: Readonly<SafeOpenCodeError>,
  context: Readonly<OpenCodeErrorContext> = {},
): void {
  // Never log headers, bodies, metadata or arbitrary object fields. Scrub the
  // free-text fields before the shared log redactor handles known keys.
  const scrub = (value: string) =>
    value
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(
        /([?&](?:key|api[_-]?key|token|secret|password)=)[^&#\s]*/gi,
        "$1[REDACTED]",
      );
  console.error(
    "[opencode]",
    JSON.stringify(
      redactLogEntry({
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(error.name ? { name: scrub(error.name) } : {}),
        ...(error.message ? { message: scrub(error.message) } : {}),
        ...(error.code ? { code: scrub(error.code) } : {}),
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
