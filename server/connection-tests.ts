// The Test button of the integrations list (integrations loop, slice A3). The
// server itself checks a secret against its service's identity endpoint, or
// connects to a remote MCP server the way an engine does, and says whether it
// works and which account or server answered.
//
// A result names hosts only. Nothing the service sends reaches the caller but
// the account or server name, and that only after the check in `cleanName`:
// a service can repeat a request header in its answer. No error object leaves
// this module, because a fetch error's message can carry the URL; every
// failure is a fixed reason code. The calls go straight from the server, never
// through the agents' secrets proxy.

import {
  SECRET_TEST_KINDS,
  type ConnectionTestResult,
  type SecretTestKind,
} from "../shared/contract-shapes.ts";
import { mcpServerHost } from "../shared/mcp-servers.ts";
import type { SecretForm } from "../shared/secret-hosts.ts";
import {
  credentialHeader,
  mcpServerSecret,
  type McpServerSources,
} from "./mcp-servers.ts";
import type { SecretScope } from "./secret-store.ts";

export type ConnectionTestFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface ConnectionTesterDeps {
  sources: McpServerSources;
  fetch: ConnectionTestFetch;
  // The whole budget of one test, every request of it included.
  timeoutMs?: number;
}

export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
// The most bytes the test reads of one answer.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 100;
const MAX_TOOL_PAGES = 20;
const MCP_PROTOCOL_VERSION = "2025-06-18";

interface IdentityCheck {
  host: string;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  account: (body: unknown) => unknown;
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// One read-only call per preset. Each host is in its preset's host list
// (connection-tests.test.ts checks it against SECRET_PRESETS).
export const IDENTITY_CHECKS: Record<SecretTestKind, IdentityCheck> = {
  github: {
    host: "api.github.com",
    url: "https://api.github.com/user",
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "isomux",
    },
    account: (body) => field(body, "login"),
  },
  stripe: {
    host: "api.stripe.com",
    url: "https://api.stripe.com/v1/account",
    method: "GET",
    headers: {},
    account: (body) => field(body, "email") || field(body, "id"),
  },
  fly: {
    host: "api.fly.io",
    url: "https://api.fly.io/graphql",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { email } }" }),
    account: (body) => field(body, "data", "viewer", "email"),
  },
};

// The identity check a secret gets: an Authorization secret that lists the
// check's host. A secret on other hosts has none.
export function secretTestKind(secret: {
  form: SecretForm;
  hosts: string[];
}): SecretTestKind | null {
  if (secret.form.kind !== "authorization") return null;
  return (
    SECRET_TEST_KINDS.find((kind) =>
      secret.hosts.includes(IDENTITY_CHECKS[kind].host),
    ) ?? null
  );
}

// A name the service wrote, or null when it is not plain text or could carry
// what the request sent: the credential, or a part of the URL path or query.
function cleanName(
  text: unknown,
  sent: { value: string | null; url: string },
): string | null {
  if (typeof text !== "string") return null;
  const name = text.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (sent.value && name.includes(sent.value)) return null;
  let parts: string[] = [];
  try {
    const url = new URL(sent.url);
    parts = [
      ...url.pathname.split("/"),
      ...[...url.searchParams].flatMap(([key, value]) => [key, value]),
    ].map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  } catch {
    return null;
  }
  if (parts.some((part) => part.length > 3 && name.includes(part))) return null;
  return name;
}

// The message is the reason code: never a URL or a service's text.
class Failure extends Error {
  constructor(
    readonly reason: Exclude<ConnectionTestResult, { ok: true }>["reason"],
    readonly status?: number,
  ) {
    super(reason);
  }
}

interface Call {
  signal: AbortSignal;
  host: string;
}

// The one way out: refuses any host but the test's own, never follows a
// redirect, and turns every network error into a code.
async function send(
  deps: ConnectionTesterDeps,
  call: Call,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Failure("not_testable");
  }
  if (target.hostname !== call.host) throw new Failure("not_testable");
  let response: Response;
  try {
    response = await deps.fetch(url, {
      ...init,
      redirect: "manual",
      signal: call.signal,
    });
  } catch {
    throw call.signal.aborted
      ? new Failure("timeout")
      : new Failure("unreachable");
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    throw new Failure("redirect");
  }
  return response;
}

function failForStatus(response: Response): never {
  void response.body?.cancel().catch(() => {});
  if (response.status === 401) throw new Failure("refused");
  if (response.status === 403) throw new Failure("forbidden");
  throw new Failure("status", response.status);
}

// Reads the body up to the cap; `until` may stop early on the bytes so far
// (an SSE stream that stays open after the answer).
async function readBody(
  response: Response,
  until?: (text: string) => unknown,
): Promise<{ text: string; found?: unknown }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "" };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Failure("unexpected");
      text += decoder.decode(value, { stream: true });
      if (until) {
        const found = until(text);
        if (found !== undefined) return { text, found };
      }
    }
    text += decoder.decode();
    return { text };
  } catch (err) {
    // A stream that breaks off is a lost connection; the test's own timeout
    // answers first when it is the abort.
    throw err instanceof Failure ? err : new Failure("unreachable");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure("unexpected");
  }
}

async function testSecret(
  deps: ConnectionTesterDeps,
  call: Call,
  check: IdentityCheck,
  secret: { value: string; form: SecretForm },
): Promise<ConnectionTestResult> {
  const response = await send(deps, call, check.url, {
    method: check.method,
    headers: {
      ...check.headers,
      ...credentialHeader(secret.form, secret.value),
    },
    body: check.body,
  });
  if (!response.ok) failForStatus(response);
  const named = check.account(parseJson((await readBody(response)).text));
  // An identity endpoint that answers 200 without naming anyone did not
  // check the credential the way this test expects.
  if (typeof named !== "string" || named.length === 0)
    throw new Failure("unexpected");
  return {
    ok: true,
    kind: "secret",
    host: check.host,
    account: cleanName(named, { value: secret.value, url: check.url }),
  };
}

// One JSON-RPC answer from a Streamable HTTP response: plain JSON, or the SSE
// event that carries the request's id.
async function rpcAnswer(response: Response, id: number): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const { found } = await readBody(response, (text) => sseAnswer(text, id));
    if (found === undefined) throw new Failure("unexpected");
    return found;
  }
  const body = parseJson((await readBody(response)).text);
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const answer = messages.find((message) => field(message, "id") === id);
  if (answer === undefined) throw new Failure("unexpected");
  return answer;
}

function sseAnswer(text: string, id: number): unknown {
  // Only complete events: each ends with a blank line.
  const events = text.replace(/\r\n/g, "\n").split("\n\n").slice(0, -1);
  for (const event of events) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (field(message, "id") === id) return message;
  }
  return undefined;
}

function rpcResult(answer: unknown): Record<string, unknown> {
  const result = field(answer, "result");
  if (
    field(answer, "error") !== undefined ||
    !result ||
    typeof result !== "object"
  )
    throw new Failure("unexpected");
  return result as Record<string, unknown>;
}

async function testMcpServer(
  deps: ConnectionTesterDeps,
  call: Call,
  url: string,
  secret: { value: string; form: SecretForm } | null,
): Promise<ConnectionTestResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(secret ? credentialHeader(secret.form, secret.value) : {}),
  };
  let nextId = 1;
  const post = (method: string, params?: unknown, notify = false) => {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!notify) message.id = nextId++;
    if (params !== undefined) message.params = params;
    return send(deps, call, url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
  };

  const initialize = await post("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "isomux", version: "1" },
  });
  if (!initialize.ok) {
    // An OAuth server names its authorization metadata in the challenge
    // (MCP authorization spec); a static credential does not get that far.
    if (
      initialize.status === 401 &&
      /resource_metadata=/i.test(
        initialize.headers.get("www-authenticate") ?? "",
      )
    ) {
      void initialize.body?.cancel().catch(() => {});
      throw new Failure("needs_oauth");
    }
    if (initialize.status === 401 && !secret) {
      void initialize.body?.cancel().catch(() => {});
      throw new Failure("no_credential");
    }
    failForStatus(initialize);
  }
  const session = initialize.headers.get("mcp-session-id");
  const init = rpcResult(await rpcAnswer(initialize, 1));
  const name = cleanName(field(init, "serverInfo", "name"), {
    value: secret?.value ?? null,
    url,
  });
  if (session) headers["Mcp-Session-Id"] = session;
  const version = field(init, "protocolVersion");
  if (typeof version === "string") headers["MCP-Protocol-Version"] = version;

  try {
    const initialized = await post(
      "notifications/initialized",
      undefined,
      true,
    );
    void initialized.body?.cancel().catch(() => {});
    if (!initialized.ok) failForStatus(initialized);

    let tools = 0;
    if (field(init, "capabilities", "tools") !== undefined) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const id = nextId;
        const listed = await post(
          "tools/list",
          cursor === undefined ? {} : { cursor },
        );
        if (!listed.ok) failForStatus(listed);
        const result = rpcResult(await rpcAnswer(listed, id));
        const list = result.tools;
        if (!Array.isArray(list)) throw new Failure("unexpected");
        tools += list.length;
        const next = result.nextCursor;
        if (typeof next !== "string" || next.length === 0) break;
        cursor = next;
      }
    }
    return {
      ok: true,
      kind: "mcp",
      host: mcpServerHost(url),
      server: name,
      tools,
    };
  } finally {
    // End the session, without waiting and without a result.
    if (session)
      void deps
        .fetch(url, {
          method: "DELETE",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        })
        .then((response) => response.body?.cancel())
        .catch(() => {});
  }
}

function scopeKey(scope: SecretScope): string {
  return scope.kind === "office" ? "office" : `user:${scope.userId}`;
}

export function createConnectionTester(deps: ConnectionTesterDeps) {
  // One test at a time per connection: a second request while one runs gets
  // the same answer. Keyed by the whole scope, so two members' secrets of the
  // same name never share one.
  const running = new Map<string, Promise<ConnectionTestResult>>();

  function once(
    key: string,
    host: string | null,
    run: (call: Call) => Promise<ConnectionTestResult>,
  ): Promise<ConnectionTestResult> {
    const current = running.get(key);
    if (current) return current;
    const timeoutMs = deps.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ConnectionTestResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, host, reason: "timeout" });
      }, timeoutMs);
    });
    const tested = (async (): Promise<ConnectionTestResult> => {
      try {
        return await run({ signal: controller.signal, host: host ?? "" });
      } catch (err) {
        if (err instanceof Failure)
          return err.status === undefined
            ? { ok: false, host, reason: err.reason }
            : { ok: false, host, reason: err.reason, status: err.status };
        console.warn("[connections] a connection test failed");
        return { ok: false, host, reason: "unexpected" };
      }
    })();
    const result = Promise.race([tested, timedOut]).finally(() => {
      clearTimeout(timer);
      controller.abort();
      running.delete(key);
    });
    running.set(key, result);
    return result;
  }

  return {
    // Null when the scope has no secret of that name.
    secret: (
      scope: SecretScope,
      name: string,
    ): Promise<ConnectionTestResult> | null => {
      const secret = deps.sources.secrets.readSecretValues(scope, name);
      if (!secret) return null;
      const kind = secretTestKind(secret);
      if (!kind)
        return Promise.resolve({
          ok: false,
          host: null,
          reason: "not_testable",
        });
      const check = IDENTITY_CHECKS[kind];
      return once(
        JSON.stringify([scopeKey(scope), "secret", name]),
        check.host,
        (call) => testSecret(deps, call, check, secret),
      );
    },

    // Null when the scope has no MCP server of that name.
    mcpServer: (
      scope: SecretScope,
      name: string,
    ): Promise<ConnectionTestResult> | null => {
      const server = deps.sources.servers
        .list(scope)
        .find((entry) => entry.name === name);
      if (!server) return null;
      const host = mcpServerHost(server.url);
      const resolved = mcpServerSecret(deps.sources, scope, server);
      if (!resolved.ok)
        return Promise.resolve({ ok: false, host, reason: "not_testable" });
      return once(
        JSON.stringify([scopeKey(scope), "mcp", name]),
        host,
        (call) => testMcpServer(deps, call, server.url, resolved.secret),
      );
    },
  };
}

export type ConnectionTester = ReturnType<typeof createConnectionTester>;
