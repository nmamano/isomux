// The url-probe runner entry's input and reply (server/agent-runner/entries/
// url-probe.ts): the pre-flight of a member's preview capture. Pure, so the
// runner bundle can take it.

export const URL_PROBE_ERROR_MAX = 500;
export const URL_PROBE_TIMEOUT_MAX_MS = 2_000;
const URL_MAX = 2048;

export type UrlProbeReply =
  { reachable: true } | { reachable: false; error: string };

// The entry's input, checked in the runner: an http(s) URL and a timeout.
export function checkUrlProbeInput(input: unknown): {
  url: string;
  timeoutMs: number;
} {
  const v = (input ?? {}) as { url?: unknown; timeoutMs?: unknown };
  if (typeof v.url !== "string" || v.url.length > URL_MAX)
    throw new Error("url-probe needs a url");
  const protocol = new URL(v.url).protocol;
  if (protocol !== "http:" && protocol !== "https:")
    throw new Error("url-probe needs an http or https url");
  if (
    typeof v.timeoutMs !== "number" ||
    !Number.isInteger(v.timeoutMs) ||
    v.timeoutMs < 1 ||
    v.timeoutMs > URL_PROBE_TIMEOUT_MAX_MS
  )
    throw new Error("url-probe needs a timeout");
  return { url: v.url, timeoutMs: v.timeoutMs };
}

// The runner's reply is member data: exactly one of the two shapes, the
// error a string within the bound. Null for anything else.
export function parseUrlProbeReply(reply: unknown): UrlProbeReply | null {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply))
    return null;
  const v = reply as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys === "reachable" && v.reachable === true) return { reachable: true };
  if (
    keys === "error,reachable" &&
    v.reachable === false &&
    typeof v.error === "string" &&
    v.error.length <= URL_PROBE_ERROR_MAX
  )
    return { reachable: false, error: v.error };
  return null;
}
