// Remote MCP servers that Isomux registers for every engine (integrations
// loop, slice A2). The field rules that the UI and the routes share.

// Every server Isomux gives an engine carries this prefix, so it never takes
// the name of a server the member configured in the engine itself.
const MCP_SERVER_PREFIX = "isomux-";

// Engines name a tool mcp__<server>__<tool>, and OpenAI-side tool names stop
// at 64 characters. With the prefix, 24 leaves the tool name 26 of them.
const MCP_SERVER_MAX_NAME_LENGTH = 24;
const MCP_SERVER_MAX_URL_LENGTH = 2048;

const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface McpServerFieldError {
  field: "name" | "url" | "secret" | "note";
  reason: "invalid" | "too_long" | "credential_over_http" | "credential_port";
}

// The secrets an OAuth server's sign-in writes in its scope (integrations
// A2b): the refresh token and a client secret.
export function oauthSecretNames(name: string): {
  refreshToken: string;
  clientSecret: string;
} {
  const base = `MCP_${name.toUpperCase().replace(/-/g, "_")}_OAUTH`;
  return { refreshToken: base, clientSecret: `${base}_CLIENT` };
}

// Every name oauthSecretNames can give: when the registrations cannot be
// read, the secrets runtime treats each secret of this shape as owned.
export const OAUTH_SECRET_NAME = /^MCP_[A-Z0-9_]+_OAUTH(_CLIENT)?$/;

export function mcpEngineName(name: string): string {
  return `${MCP_SERVER_PREFIX}${name}`;
}

export function checkMcpServerName(name: unknown): McpServerFieldError | null {
  if (typeof name !== "string" || !NAME.test(name))
    return { field: "name", reason: "invalid" };
  if (name.length > MCP_SERVER_MAX_NAME_LENGTH)
    return { field: "name", reason: "too_long" };
  return null;
}

// https to any host; plain http only to this machine, and then with no
// credential. No user, password or fragment. With a credential, no port but
// 443: the secrets proxy (B2) puts the value in on port 443 only, so another
// port would work until B2 and then stop without an error.
export function checkMcpServerUrl(
  url: unknown,
  withCredential: boolean,
):
  | { ok: true; url: string; host: string }
  | { ok: false; error: McpServerFieldError } {
  const invalid = {
    ok: false as const,
    error: { field: "url" as const, reason: "invalid" as const },
  };
  if (typeof url !== "string" || url.length === 0) return invalid;
  if (url.length > MCP_SERVER_MAX_URL_LENGTH)
    return { ok: false, error: { field: "url", reason: "too_long" } };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid;
  }
  if (parsed.username || parsed.password || parsed.hash) return invalid;
  if (url.trim() !== url) return invalid;
  if (parsed.protocol === "http:") {
    if (!LOOPBACK_HOSTS.includes(parsed.hostname)) return invalid;
    if (withCredential)
      return {
        ok: false,
        error: { field: "url", reason: "credential_over_http" },
      };
  } else if (parsed.protocol !== "https:") return invalid;
  // URL drops a default ":443", so any port left is another one.
  if (parsed.protocol === "https:" && withCredential && parsed.port !== "")
    return { ok: false, error: { field: "url", reason: "credential_port" } };
  return { ok: true, url: parsed.href, host: parsed.hostname };
}

// The host a URL names, for lists and audit rows: the path of some hosted
// MCP servers carries the token, so only the editor shows the whole URL.
export function mcpServerHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
