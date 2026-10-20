// Secrets (internal-docs/secrets-design.md): the presets, the never-list, and
// the field rules that the UI, the routes and the secret proxy share. One
// module, so that the proxy (B2) refuses exactly what the routes refuse.

export type SecretForm =
  // The Authorization header in any scheme: Bearer, token, or the user or
  // password of Basic after decoding.
  | { kind: "authorization" }
  // The whole value of one named header, stored lower-case.
  | { kind: "header"; header: string };

export interface SecretPreset {
  id: string;
  label: string;
  name: string;
  hosts: string[];
  form: SecretForm;
}

// B3 proves each preset end to end. No presets for model APIs: they are on the
// never-list.
export const SECRET_PRESETS: readonly SecretPreset[] = [
  {
    id: "github",
    label: "GitHub",
    name: "GH_TOKEN",
    hosts: ["api.github.com", "github.com", "uploads.github.com"],
    form: { kind: "authorization" },
  },
  {
    id: "stripe",
    label: "Stripe",
    name: "STRIPE_API_KEY",
    hosts: ["api.stripe.com", "files.stripe.com"],
    form: { kind: "authorization" },
  },
  {
    id: "fly",
    label: "Fly",
    name: "FLY_API_TOKEN",
    hosts: ["api.fly.io", "api.machines.dev"],
    form: { kind: "authorization" },
  },
];

// Hosts that never get a secret: the hosts that carry engine model traffic,
// the model provider APIs and the package registries. The proxy keeps them as
// plain tunnels and never ends TLS for them, and the routes refuse them.
//
// A domain that a model or registry vendor owns is listed with all its
// subdomains.
const NEVER_DOMAINS: readonly string[] = [
  "anthropic.com",
  "claude.ai",
  "claude.com",
  "openai.com",
  "chatgpt.com",
  "openai.azure.com",
  "openrouter.ai",
  "mistral.ai",
  "groq.com",
  "deepseek.com",
  "x.ai",
  "opencode.ai",
  "npmjs.org",
  "npmjs.com",
  "yarnpkg.com",
  "pypi.org",
  "pythonhosted.org",
  "crates.io",
  "golang.org",
  "jsr.io",
  "rubygems.org",
  "maven.org",
];
// On shared platforms, only the model and registry endpoints.
const NEVER_HOSTS: readonly string[] = [
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "repo.maven.apache.org",
];
const NEVER_PATTERNS: readonly RegExp[] = [
  // Vertex AI regional endpoints.
  /^[a-z0-9-]+-aiplatform\.googleapis\.com$/,
  // Bedrock, regional and FIPS.
  /^bedrock(-runtime|-agent-runtime)?(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/,
];

// Lower-case, without a leading "*.", a trailing dot or a port. Only for the
// never-list comparison: the syntax check refuses every one of these forms.
function normalizeForNeverList(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("*.")) h = h.slice(2);
  const bracket = h.startsWith("[");
  if (!bracket) {
    const colon = h.lastIndexOf(":");
    if (colon !== -1) h = h.slice(0, colon);
  }
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

// The only never-list check. A wildcard counts as the domain it covers.
export function isNeverListed(host: string): boolean {
  const h = normalizeForNeverList(host);
  if (!h) return false;
  if (NEVER_HOSTS.includes(h)) return true;
  if (NEVER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  return NEVER_PATTERNS.some((pattern) => pattern.test(h));
}

export const SECRET_MAX_HOSTS = 20;
// The apps that may read a secret's value (task c7007f8b).
export const SECRET_MAX_APPS = 20;
export const SECRET_MAX_VALUE_LENGTH = 16 * 1024;
// The proxy's scrub and the log masking skip shorter values
// (server/secret-proxy/scrub.ts), so a host that reflected one would return
// it to the agent. A value stored before this rule keeps working.
export const SECRET_MIN_VALUE_LENGTH = 8;
const SECRET_MAX_NAME_LENGTH = 128;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// An exact lower-case DNS name with at least two labels and a top-level label
// that is not all digits: no scheme, port, path, wildcard, trailing dot, IP
// literal or localhost.
export function isValidSecretHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

// The names the office sets itself in agent environments, now or in B2.
const RESERVED_NAMES: readonly string[] = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "NODE_USE_ENV_PROXY",
  "GIT_CONFIG",
];
const RESERVED_PREFIXES: readonly string[] = ["ISOMUX_", "GIT_CONFIG_"];

// The names an app's own environment needs. A secret with apps cannot use
// them: the app's secrets file would override the value the office sets.
export const APP_RESERVED_SECRET_NAMES: readonly string[] = [
  "PORT",
  "PATH",
  "HOME",
  "LANG",
  "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
];

export function isAppReservedSecretName(name: string): boolean {
  return APP_RESERVED_SECRET_NAMES.includes(name);
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedSecretName(name: string): boolean {
  return (
    RESERVED_NAMES.includes(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

// Headers that carry the request's framing or routing, or that the
// authorization form covers.
const REFUSED_HEADERS: readonly string[] = [
  "authorization",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "te",
  "upgrade",
  "trailer",
  "keep-alive",
];
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

// A field problem. The route sends `field` and `reason` and never the input,
// so a value pasted into the wrong field does not come back. `host` is set
// only for a never-listed host, which is a name from the fixed list above.
export interface SecretFieldError {
  field: "name" | "value" | "hosts" | "form" | "note" | "apps";
  reason:
    | "invalid"
    | "reserved"
    | "too_short"
    | "too_long"
    | "never_listed"
    | "clash";
  host?: string;
}

export function checkSecretName(name: unknown): SecretFieldError | null {
  if (typeof name !== "string" || !SAFE_NAME.test(name))
    return { field: "name", reason: "invalid" };
  if (name.length > SECRET_MAX_NAME_LENGTH)
    return { field: "name", reason: "too_long" };
  if (isReservedSecretName(name)) return { field: "name", reason: "reserved" };
  return null;
}

// Printable ASCII only, because the value goes into an HTTP header; no space
// at either end, because HTTP trims it.
export function checkSecretValue(value: unknown): SecretFieldError | null {
  if (typeof value !== "string" || value.length === 0)
    return { field: "value", reason: "invalid" };
  if (value.length < SECRET_MIN_VALUE_LENGTH)
    return { field: "value", reason: "too_short" };
  if (value.length > SECRET_MAX_VALUE_LENGTH)
    return { field: "value", reason: "too_long" };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e)
      return { field: "value", reason: "invalid" };
  }
  if (value.startsWith(" ") || value.endsWith(" "))
    return { field: "value", reason: "invalid" };
  return null;
}

// Validates the whole host set: syntax first, then the never-list.
// `allowEmpty`: the secret has apps, so it needs no host.
export function checkSecretHosts(
  hosts: unknown,
  options: { allowEmpty?: boolean } = {},
): { ok: true; hosts: string[] } | { ok: false; error: SecretFieldError } {
  if (!Array.isArray(hosts) || (hosts.length === 0 && !options.allowEmpty))
    return { ok: false, error: { field: "hosts", reason: "invalid" } };
  if (hosts.length > SECRET_MAX_HOSTS)
    return { ok: false, error: { field: "hosts", reason: "too_long" } };
  for (const host of hosts) {
    if (typeof host !== "string" || !isValidSecretHost(host))
      return { ok: false, error: { field: "hosts", reason: "invalid" } };
    if (isNeverListed(host))
      return {
        ok: false,
        error: { field: "hosts", reason: "never_listed", host },
      };
  }
  return { ok: true, hosts: [...new Set(hosts as string[])].sort() };
}

export function checkSecretForm(
  form: unknown,
): { ok: true; form: SecretForm } | { ok: false; error: SecretFieldError } {
  const invalid = {
    ok: false as const,
    error: { field: "form" as const, reason: "invalid" as const },
  };
  if (!form || typeof form !== "object" || Array.isArray(form)) return invalid;
  const { kind, header } = form as { kind?: unknown; header?: unknown };
  if (kind === "authorization") return { ok: true, form: { kind } };
  if (kind !== "header" || typeof header !== "string") return invalid;
  const name = header.toLowerCase();
  if (
    name.length === 0 ||
    name.length > 64 ||
    !HEADER_TOKEN.test(name) ||
    REFUSED_HEADERS.includes(name) ||
    name.startsWith("proxy-")
  )
    return invalid;
  return { ok: true, form: { kind: "header", header: name } };
}
