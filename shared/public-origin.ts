// Shared validator/normalizer for ISOMUX_PUBLIC_ORIGIN-equivalent values.
// Used server-side both when reading `ISOMUX_PUBLIC_ORIGIN` from the
// environment and when loading the `publicOrigin` fallback from
// office-config.json. Pure and side-effect-free so any future tooling
// (e.g. a setup helper running outside the agent safety sandbox) can
// import it without dragging in server boot.
//
// Accepts `https://<host>[:port]` or `http://localhost[:port]` only. Rejects
// anything with a path, query, or fragment. Trailing slash is stripped.
// Returns the canonical string on success, or null on any rejection.

export function normalizePublicOrigin(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !isHttp) return null;

  const host = parsed.hostname.toLowerCase();
  if (!host) return null;

  // Plain HTTP is only valid for IPv4 loopback. Any non-localhost host on
  // http:// is rejected - public origin must be HTTPS. IPv6 loopback (`[::1]`)
  // isn't supported here; localhost dev is overwhelmingly `localhost` or
  // `127.0.0.1` and `URL` exposes `[::1]` bracketed, which complicates the
  // canonicalization without buying real coverage.
  if (isHttp && host !== "localhost" && host !== "127.0.0.1") {
    return null;
  }

  // No path/query/fragment in a public origin. We accept "/" (which URL
  // parsing normalizes to) but reject anything more specific.
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search) return null;
  if (parsed.hash) return null;
  if (parsed.username || parsed.password) return null;

  const portPart = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${host}${portPart}`;
}
