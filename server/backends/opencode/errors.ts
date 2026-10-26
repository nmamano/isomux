import { msg, type LogText } from "../../../shared/i18n/log-message.ts";
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

// @opencode/cli 2.1.4 retries a request ten times: a 429 gave
// session.retry.scheduled with attempts 2 to 11 over 83 s (2026-10-25).
const OPENCODE_MAX_RETRIES = 10;

// The 2.1.4 error types whose message is the provider's own refusal, at any
// status.
const REFUSAL_TYPES = new Set([
  "provider.rate-limit",
  "provider.quota",
  "provider.free-limit",
  "provider.content-filter",
  "provider.invalid-request",
]);

// A provider that refuses a request explains why, and members must see that
// the refusal is the provider's, not Isomux's (task 1a963907). The transport
// passes the 2.1.4 error type as the name. A 401 stays on the authentication
// path, and a 5xx is a provider fault, not a refusal.
export function openCodeProviderRefusal(
  error: Readonly<SafeOpenCodeError>,
  provider: string,
): LogText | null {
  const message = providerText(error.message);
  if (message === null) return null;
  const status = error.statusCode;
  // 2.1.4 sends a 403 as provider.auth: its classifier puts 401 and 403
  // together (2026-10-25).
  const refused = REFUSAL_TYPES.has(error.name ?? "")
    ? status !== 401
    : (error.name === "provider.error" || error.name === "provider.auth") &&
      status !== undefined &&
      status >= 400 &&
      status <= 499 &&
      status !== 401;
  if (!refused) return null;
  return openCodeProviderLine(provider, message);
}

// The provider will not serve this model now, though its catalog can still
// list it: @opencode/cli 2.1.4 sent "Upstream request failed: Model is
// unavailable." for a withdrawn free model (task 0387b8de). Another model of
// the provider can serve the turn. Only for a refusal (openCodeProviderRefusal).
export function openCodeModelUnavailableRefusal(
  error: Readonly<SafeOpenCodeError>,
): boolean {
  return /\bmodel is unavailable\b/i.test(error.message ?? "");
}

// The provider's words as the member reads them. `message` is already
// providerText output.
export function openCodeProviderLine(
  provider: string,
  message: string,
): LogText {
  const line = providerRefusal(provider, message);
  return FREE_TIER_REFUSAL.test(message)
    ? [line, "\n", msg("systemEntries.openCodeFreeTierHint")]
    : line;
}

// OpenCode's words for this refusal blame the client, but this office got it
// after heavy free-tier volume from one server while another machine with the
// same OpenCode version and config was served (2026-10-17). So a second line
// names the likely cause, without claiming it.
const FREE_TIER_REFUSAL = /free tier can only be used from within OpenCode/i;

// Copy for failures that carry no provider message to show, by the 2.1.4
// error type that the transport passes as the name.
export function openCodeErrorMessage(
  error: Readonly<SafeOpenCodeError>,
): string {
  const name = error.name ?? "";
  const status = error.statusCode;
  if (status === 429 || name === "provider.rate-limit")
    return status === 429
      ? "The provider rate limit was reached (HTTP 429)."
      : "The provider rate limit was reached.";
  if (name === "provider.timeout" || name === "TimeoutError")
    return "The provider did not respond in time.";
  if (name === "provider.transport")
    return "The connection to the provider failed.";
  if (name === "provider.invalid-output")
    return "The model reached its output limit.";
  if (name === "aborted") return "OpenCode stopped this request.";
  if (
    name === "provider.no-route" ||
    /^(Agent not found:|Model not found:|Provider not found:)/.test(
      error.message ?? "",
    )
  )
    return "OpenCode configuration is invalid.";
  if (
    name.startsWith("provider.") &&
    Number.isInteger(status) &&
    status! >= 400 &&
    status! <= 599
  )
    return `The provider returned HTTP ${status}.`;
  if (name.startsWith("provider."))
    return "The provider could not complete this request.";
  return "OpenCode could not complete this turn.";
}

// OpenCode's retry carries the provider's message, or its own quota line for
// OpenCode's free tier and Go plan. retry: 1 for the first retry.
export function openCodeRetryMessage(
  message: string | undefined,
  retry: number,
  provider: string,
): LogText {
  const text = providerText(message);
  if (text !== null)
    return msg("systemEntries.openCodeProviderRetry", {
      provider,
      message: inertMarkdown(text),
      attempt: retry,
      maxAttempts: OPENCODE_MAX_RETRIES,
    });
  const cause = openCodeErrorMessage({ name: "provider.error" });
  return `${cause.replace(/\.$/, "")}; retrying ${retry} of ${OPENCODE_MAX_RETRIES}.`;
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
