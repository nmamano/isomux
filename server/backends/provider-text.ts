import { msg, type LogMessage } from "../../shared/i18n/log-message.ts";
import { redactLogEntry } from "../log-redaction.ts";

// Provider text that reaches the chat, from any backend (tasks 1a963907 and
// 2bd836d5).

export const PROVIDER_TEXT_LIMIT = 300;

// Free text from a provider can hold credentials. Scrub the shapes the shared
// log redactor does not know before it handles known keys and secret values.
export function scrubCredentials(value: string): string {
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
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\s\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g,
      " ",
    )
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
export function inertMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]()<>!@]|:(?=\/\/)|(?<=\bwww)\./gi, "\\$&");
}

// The member line for a request the provider refused, naming the provider as
// the source. `message` is already providerText output.
export function providerRefusal(provider: string, message: string): LogMessage {
  return msg("systemEntries.providerRefused", { provider, message });
}
