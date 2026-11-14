// Secrets (internal-docs/secrets-design.md): the presets, the never-list, and
// the field rules that the UI, the routes and the secret proxy share. One
// module, so that the proxy (B2) refuses exactly what the routes refuse.

export type SecretForm =
  // The Authorization header in any scheme: Bearer, token, or the user or
  // password of Basic after decoding.
  | { kind: "authorization" }
  // The whole value of one named header, stored lower-case.
  | { kind: "header"; header: string }
  // The whole value of one named query parameter of the request target, as
  // typed (query names are case-sensitive). Only for a secret with a token
  // exchange: the token goes in the web address, never a raw value.
  | { kind: "query"; param: string };

// How the proxy asks a service for a token (task 124eb47e). "oauth" is the
// RFC 6749 4.4 client credentials grant, form-encoded: the id and secret in
// HTTP Basic ("basic") or in the body ("body"). "json" sends
// {[idField]: id, [secretField]: secret}.
export type ExchangeBody =
  | { kind: "oauth"; clientAuth: "basic" | "body" }
  | { kind: "json"; idField: string; secretField: string };

// A secret's token exchange. The secret's value is the client or app secret;
// `id` is the client or app id, which is not secret and is listed in plain.
// The token goes where the secret's form says.
export interface ExchangeSpec {
  // https, port 443, no user info, no fragment; its host is one of the
  // secret's hosts.
  url: string;
  body: ExchangeBody;
  id: string;
  // Extra non-secret fields of the request body: scope, audience, resource.
  params: Record<string, string>;
  // Dotted paths into the JSON reply.
  tokenField: string;
  // Seconds.
  expiryField: string;
}

// The fields of a token exchange preset; the member types the id.
export interface SecretExchangePreset {
  id: string;
  label: string;
  name: string;
  hosts: string[];
  form: SecretForm;
  exchange: Omit<ExchangeSpec, "id">;
}

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

const SECRET_MAX_HOSTS = 20;
// The apps that may read a secret's value (task c7007f8b).
export const SECRET_MAX_APPS = 20;
const SECRET_MAX_VALUE_LENGTH = 16 * 1024;
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
const APP_RESERVED_SECRET_NAMES: readonly string[] = [
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

function isReservedSecretName(name: string): boolean {
  return (
    RESERVED_NAMES.includes(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

// The names a model engine reads as its sign-in key, for the vendors whose
// hosts are on the never-list. An agent that gets a secret's placeholder under
// one of them signs in with it, and the proxy never swaps it, so a secret with
// a host cannot use them; they go in Variables.
export const MODEL_KEY_SECRET_NAMES: readonly string[] = [
  // Claude.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Codex.
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  // OpenCode: its own key and the models.dev provider keys of never-listed
  // vendors.
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_API_KEY",
];

export function isModelKeySecretName(name: string): boolean {
  return MODEL_KEY_SECRET_NAMES.includes(name);
}

// A secret under a model key name may have no host: only a secret with a host
// reaches agents. An app-only secret gives the app the real value.
export function checkModelKeyHosts(
  name: string,
  hosts: readonly string[],
): SecretFieldError | null {
  return hosts.length > 0 && isModelKeySecretName(name)
    ? { field: "name", reason: "model_key" }
    : null;
}

// The message an agent reads for a refused field. The routes send `field` and
// `reason` with it, never the input.
export function secretFieldErrorMessage(error: SecretFieldError): string {
  if (error.reason === "never_listed")
    return `${error.host} never receives a secret: model and package registry hosts are on the never-list`;
  if (error.reason === "too_short")
    return `the value must have at least ${SECRET_MIN_VALUE_LENGTH} characters`;
  if (error.reason === "model_key")
    return "this name is a model sign-in key: agents cannot sign in with a secret, so set it as a variable";
  return `the ${error.field} field is not valid`;
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
  field: "name" | "value" | "hosts" | "form" | "note" | "apps" | "exchange";
  reason:
    | "invalid"
    // The token address's host is not one of the secret's hosts.
    | "host"
    | "reserved"
    | "too_short"
    | "too_long"
    | "never_listed"
    | "clash"
    | "model_key";
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

// A query parameter name: the URL unreserved characters, so it needs no
// encoding.
const QUERY_PARAM = /^[A-Za-z0-9._~-]{1,64}$/;

// `exchange`: the secret has a token exchange, so the query form is allowed.
export function checkSecretForm(
  form: unknown,
  options: { exchange?: boolean } = {},
): { ok: true; form: SecretForm } | { ok: false; error: SecretFieldError } {
  const invalid = {
    ok: false as const,
    error: { field: "form" as const, reason: "invalid" as const },
  };
  if (!form || typeof form !== "object" || Array.isArray(form)) return invalid;
  const { kind, header, param } = form as {
    kind?: unknown;
    header?: unknown;
    param?: unknown;
  };
  if (kind === "authorization") return { ok: true, form: { kind } };
  if (kind === "query") {
    if (!options.exchange) return invalid;
    if (typeof param !== "string" || !QUERY_PARAM.test(param)) return invalid;
    return { ok: true, form: { kind, param } };
  }
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

// The error code of an agent's change to a saved secret's token exchange, or
// to or from the query form (task 124eb47e).
export const SECRET_EXCHANGE_CHANGE_REFUSED = "secret_exchange_change_refused";

// Presets for the token exchange. "OAuth client credentials" leaves the
// address and hosts to the member.
const larkLike = (
  id: string,
  label: string,
  name: string,
  host: string,
): SecretExchangePreset => ({
  id,
  label,
  name,
  hosts: [host],
  form: { kind: "authorization" },
  exchange: {
    url: `https://${host}/open-apis/auth/v3/tenant_access_token/internal`,
    body: { kind: "json", idField: "app_id", secretField: "app_secret" },
    params: {},
    tokenField: "tenant_access_token",
    expiryField: "expire",
  },
});
export const SECRET_EXCHANGE_PRESETS: readonly SecretExchangePreset[] = [
  {
    id: "oauth-client-credentials",
    label: "OAuth client credentials",
    name: "",
    hosts: [],
    form: { kind: "authorization" },
    exchange: {
      url: "",
      body: { kind: "oauth", clientAuth: "basic" },
      params: {},
      tokenField: "access_token",
      expiryField: "expires_in",
    },
  },
  larkLike("feishu", "Feishu", "FEISHU_APP_SECRET", "open.feishu.cn"),
  larkLike("lark", "Lark", "LARK_APP_SECRET", "open.larksuite.com"),
];

const EXCHANGE_MAX_PARAMS = 10;
const EXCHANGE_MAX_FIELD_LENGTH = 256;
const EXCHANGE_MAX_URL_LENGTH = 2048;
// The fields of an OAuth body that the proxy writes itself.
const OAUTH_RESERVED = ["grant_type", "client_id", "client_secret"];
// Steps of a reply path that walk into the prototype.
const PROTOTYPE_STEPS = ["__proto__", "constructor", "prototype"];

// The host of a token address (the URL is a checked ExchangeSpec url).
export function exchangeHost(exchange: ExchangeSpec): string {
  return new URL(exchange.url).hostname;
}

// A dotted path of own-property steps: no empty step and no prototype step.
function isReplyPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= EXCHANGE_MAX_FIELD_LENGTH &&
    path
      .split(".")
      .every((step) => step.length > 0 && !PROTOTYPE_STEPS.includes(step))
  );
}

const isField = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= EXCHANGE_MAX_FIELD_LENGTH;

// The token address's host, or null when the address is not plain https on
// 443 with a valid secret host, no user info and no fragment.
function tokenAddressHost(url: unknown): string | null {
  if (typeof url !== "string" || url.length > EXCHANGE_MAX_URL_LENGTH)
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.port !== "" && parsed.port !== "443") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hash || url.includes("#")) return null;
  if (!isValidSecretHost(parsed.hostname)) return null;
  if (isNeverListed(parsed.hostname)) return null;
  return parsed.hostname;
}

function checkExchangeBody(body: unknown): ExchangeBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.kind === "oauth") {
    if (b.clientAuth !== "basic" && b.clientAuth !== "body") return null;
    return { kind: "oauth", clientAuth: b.clientAuth };
  }
  if (b.kind === "json") {
    if (!isField(b.idField) || !isField(b.secretField)) return null;
    if (b.idField === b.secretField) return null;
    return { kind: "json", idField: b.idField, secretField: b.secretField };
  }
  return null;
}

// Checks a token exchange against the secret's hosts and fills the defaults
// (tokenField access_token, expiryField expires_in, params {}).
export function checkSecretExchange(
  exchange: unknown,
  hosts: readonly string[],
):
  | { ok: true; exchange: ExchangeSpec }
  | { ok: false; error: SecretFieldError } {
  const invalid = {
    ok: false as const,
    error: { field: "exchange" as const, reason: "invalid" as const },
  };
  if (!exchange || typeof exchange !== "object" || Array.isArray(exchange))
    return invalid;
  const e = exchange as Record<string, unknown>;
  const host = tokenAddressHost(e.url);
  if (!host) return invalid;
  const body = checkExchangeBody(e.body);
  if (!body) return invalid;
  if (!isField(e.id)) return invalid;
  const rawParams = e.params ?? {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams))
    return invalid;
  const entries = Object.entries(rawParams as Record<string, unknown>);
  if (entries.length > EXCHANGE_MAX_PARAMS) return invalid;
  const reserved =
    body.kind === "oauth" ? OAUTH_RESERVED : [body.idField, body.secretField];
  const params: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!isField(key) || PROTOTYPE_STEPS.includes(key)) return invalid;
    if (reserved.includes(key)) return invalid;
    if (typeof value !== "string" || value.length > EXCHANGE_MAX_FIELD_LENGTH)
      return invalid;
    params[key] = value;
  }
  const tokenField = e.tokenField ?? "access_token";
  const expiryField = e.expiryField ?? "expires_in";
  if (!isReplyPath(tokenField) || !isReplyPath(expiryField)) return invalid;
  if (!hosts.includes(host))
    return { ok: false, error: { field: "exchange", reason: "host" } };
  return {
    ok: true,
    exchange: {
      url: e.url as string,
      body,
      id: e.id,
      params,
      tokenField,
      expiryField,
    },
  };
}
