// The Test button's checks (integrations A3), against a fake fetch: which
// request goes where, what each answer becomes, and that no result, log line
// or call to another host carries the fake value.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECRET_PRESETS } from "../shared/secret-hosts.ts";
import type { ConnectionTestResult } from "../shared/contract-shapes.ts";
import {
  IDENTITY_CHECKS,
  cleanName,
  createConnectionTester,
  type ConnectionTestFetch,
} from "./connection-tests.ts";
import { createMcpServerSources, mcpServerRows } from "./mcp-servers.ts";
import type { SecretScope } from "./secret-store.ts";

const VALUE = "fake-a3-secret-value-0001";
const OTHER_VALUE = "fake-a3-secret-value-0002";
const PATH_TOKEN = "fake-a3-path-token-0003";
const MCP_URL = `https://mcp.example.com/${PATH_TOKEN}/mcp?key=${PATH_TOKEN}`;
const OFFICE: SecretScope = { kind: "office" };
const ALICE: SecretScope = { kind: "user", userId: "alice" };
const BOB: SecretScope = { kind: "user", userId: "bob" };

let root: string;
let logs: string[];
let spies: { mockRestore(): void }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "isomux-a3-"));
  logs = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(answer: (sent: Sent) => Response | Promise<Response>): {
  fetch: ConnectionTestFetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      const entry: Sent = {
        url,
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === "string" ? init.body : null,
        redirect: init.redirect,
      };
      sent.push(entry);
      return answer(entry);
    },
  };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function setup(
  fetch: ConnectionTestFetch,
  options: { timeoutMs?: number } = {},
) {
  const sources = createMcpServerSources(root);
  const tester = createConnectionTester({ sources, fetch, ...options });
  return { sources, tester };
}

function addSecret(
  sources: ReturnType<typeof createMcpServerSources>,
  scope: SecretScope,
  name: string,
  hosts: string[],
  value = VALUE,
) {
  const change = sources.secrets.create(scope, {
    name,
    value,
    hosts,
    form: { kind: "authorization" },
  });
  expect(change.ok).toBe(true);
}

// No result, log line or request to a host the secret does not list carries
// the fake value, the URL path or the query.
function expectClean(result: unknown) {
  const text = JSON.stringify(result) + logs.join("\n");
  for (const fake of [VALUE, OTHER_VALUE, PATH_TOKEN])
    expect(text).not.toContain(fake);
}

describe("the identity checks", () => {
  it("call a host on their preset's own list", () => {
    for (const [id, check] of Object.entries(IDENTITY_CHECKS)) {
      const preset = SECRET_PRESETS.find((entry) => entry.id === id);
      expect(preset?.hosts).toContain(check.host);
      expect(new URL(check.url).hostname).toBe(check.host);
      expect(preset?.form).toEqual({ kind: "authorization" });
    }
  });
});

describe("secret tests", () => {
  it("GitHub: GET /user with the header agents get, and the login", async () => {
    const { fetch, sent } = fakeFetch(() => json({ login: "octocat" }));
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com", "github.com"]);
    const result = await tester.secret(ALICE, "GH_TOKEN");
    expect(result).toEqual({
      ok: true,
      kind: "secret",
      host: "api.github.com",
      account: "octocat",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://api.github.com/user",
      method: "GET",
      redirect: "manual",
    });
    expect(sent[0].headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(sent[0].headers["user-agent"]).toBe("isomux");
    expectClean(result);
  });

  it("Stripe: the account's email, else its id", async () => {
    let body: unknown = { id: "acct_1", email: "billing@example.com" };
    const { fetch, sent } = fakeFetch(() => json(body));
    const { sources, tester } = setup(fetch);
    addSecret(sources, OFFICE, "STRIPE_API_KEY", ["api.stripe.com"]);
    expect(await tester.secret(OFFICE, "STRIPE_API_KEY")).toMatchObject({
      ok: true,
      account: "billing@example.com",
    });
    body = { id: "acct_1", email: null };
    expect(await tester.secret(OFFICE, "STRIPE_API_KEY")).toMatchObject({
      ok: true,
      account: "acct_1",
    });
    expect(sent[0].url).toBe("https://api.stripe.com/v1/account");
  });

  it("Fly: the viewer query, and a GraphQL error is an answer it cannot read", async () => {
    let body: unknown = { data: { viewer: { email: "ops@example.com" } } };
    const { fetch, sent } = fakeFetch(() => json(body));
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "FLY_API_TOKEN", ["api.fly.io"]);
    expect(await tester.secret(ALICE, "FLY_API_TOKEN")).toMatchObject({
      ok: true,
      account: "ops@example.com",
    });
    expect(sent[0]).toMatchObject({
      url: "https://api.fly.io/graphql",
      method: "POST",
    });
    expect(JSON.parse(sent[0].body ?? "")).toEqual({
      query: "{ viewer { email } }",
    });
    body = { data: null, errors: [{ message: "not allowed" }] };
    expect(await tester.secret(ALICE, "FLY_API_TOKEN")).toEqual({
      ok: false,
      host: "api.fly.io",
      reason: "unexpected",
    });
  });

  it("turns each failure into its reason, never the service's text", async () => {
    const cases: [() => Response | Promise<Response>, ConnectionTestResult][] =
      [
        [
          // The service repeats the request header in its error body.
          () => json({ message: `Bad credentials: Bearer ${VALUE}` }, 401),
          { ok: false, host: "api.github.com", reason: "refused" },
        ],
        [
          () =>
            json({ message: "Resource not accessible by integration" }, 403),
          { ok: false, host: "api.github.com", reason: "forbidden" },
        ],
        [
          () => json({ message: VALUE }, 502),
          { ok: false, host: "api.github.com", reason: "status", status: 502 },
        ],
        [
          () =>
            new Response(null, {
              status: 302,
              headers: { location: `https://elsewhere.example/${VALUE}` },
            }),
          { ok: false, host: "api.github.com", reason: "redirect" },
        ],
        [
          () => {
            throw new TypeError(
              `fetch failed for https://api.github.com/user?token=${VALUE}`,
            );
          },
          { ok: false, host: "api.github.com", reason: "unreachable" },
        ],
        [
          () => new Response(`<html>${VALUE}</html>`, { status: 200 }),
          { ok: false, host: "api.github.com", reason: "unexpected" },
        ],
        [
          () => json({ notLogin: VALUE }),
          { ok: false, host: "api.github.com", reason: "unexpected" },
        ],
      ];
    for (const [answer, expected] of cases) {
      const { fetch } = fakeFetch(answer);
      const { sources, tester } = setup(fetch);
      addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"]);
      const result = await tester.secret(ALICE, "GH_TOKEN");
      expect(result).toEqual(expected);
      expectClean(result);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not show an account name that repeats what was sent", async () => {
    const { fetch } = fakeFetch(() => json({ login: `Bearer ${VALUE}` }));
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"]);
    const result = await tester.secret(ALICE, "GH_TOKEN");
    expect(result).toEqual({
      ok: true,
      kind: "secret",
      host: "api.github.com",
      account: null,
    });
    expectClean(result);
  });

  it("stops at the timeout", async () => {
    const { fetch } = fakeFetch(
      (sent) =>
        new Promise<Response>(() => {
          void sent;
        }),
    );
    const { sources, tester } = setup(fetch, { timeoutMs: 50 });
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"]);
    const started = Date.now();
    expect(await tester.secret(ALICE, "GH_TOKEN")).toEqual({
      ok: false,
      host: "api.github.com",
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("sends the secret only to a host it lists, and has no test for others", async () => {
    const { fetch, sent } = fakeFetch(() => json({ login: "octocat" }));
    const { sources, tester } = setup(fetch);
    // github.com is a GitHub host, but the check calls api.github.com.
    addSecret(sources, ALICE, "GH_WEB", ["github.com"]);
    addSecret(sources, ALICE, "CUSTOM", ["api.example.com"]);
    sources.secrets.create(ALICE, {
      name: "GH_HEADER",
      value: VALUE,
      hosts: ["api.github.com"],
      form: { kind: "header", header: "x-token" },
    });
    for (const name of ["GH_WEB", "CUSTOM", "GH_HEADER"])
      expect(await tester.secret(ALICE, name)).toEqual({
        ok: false,
        host: null,
        reason: "not_testable",
      });
    expect(sent).toEqual([]);
    expect(tester.secret(ALICE, "NO_SUCH")).toBeNull();
  });

  it("runs one test at a time per secret and joins a second request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, sent } = fakeFetch(async () => {
      await gate;
      return json({ login: "octocat" });
    });
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"]);
    const first = tester.secret(ALICE, "GH_TOKEN");
    const second = tester.secret(ALICE, "GH_TOKEN");
    release();
    expect(await first).toEqual(await second);
    expect(sent).toHaveLength(1);
    // Over: the next request runs a new test.
    await tester.secret(ALICE, "GH_TOKEN");
    expect(sent).toHaveLength(2);
  });

  it("never gives one member another member's result for the same name", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, sent } = fakeFetch(async (request) => {
      await gate;
      return json({
        login:
          request.headers.authorization === `Bearer ${VALUE}` ? "alice" : "bob",
      });
    });
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"], VALUE);
    addSecret(sources, BOB, "GH_TOKEN", ["api.github.com"], OTHER_VALUE);
    addSecret(sources, OFFICE, "GH_TOKEN", ["api.github.com"], OTHER_VALUE);
    const forAlice = tester.secret(ALICE, "GH_TOKEN");
    const forBob = tester.secret(BOB, "GH_TOKEN");
    const forOffice = tester.secret(OFFICE, "GH_TOKEN");
    release();
    expect(await forAlice).toMatchObject({ account: "alice" });
    expect(await forBob).toMatchObject({ account: "bob" });
    expect(await forOffice).toMatchObject({ account: "bob" });
    expect(sent.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${VALUE}`,
      `Bearer ${OTHER_VALUE}`,
      `Bearer ${OTHER_VALUE}`,
    ]);
  });

  it("reads no more than 1 MiB of an answer", async () => {
    const { fetch } = fakeFetch(() =>
      json({ login: "octocat", padding: "x".repeat(1024 * 1024 + 10) }),
    );
    const { sources, tester } = setup(fetch);
    addSecret(sources, ALICE, "GH_TOKEN", ["api.github.com"]);
    expect(await tester.secret(ALICE, "GH_TOKEN")).toEqual({
      ok: false,
      host: "api.github.com",
      reason: "unexpected",
    });
  });
});

// A Streamable HTTP MCP server: JSON or SSE answers, a session id, and two
// pages of tools.
function mcpServer(
  options: {
    sse?: boolean;
    name?: string;
    status?: number;
    challenge?: string;
    error?: boolean;
    tools?: boolean;
  } = {},
) {
  const encoder = new TextEncoder();
  return (sent: Sent): Response => {
    if (sent.method === "DELETE") return new Response(null, { status: 200 });
    if (options.status)
      return json({ error: VALUE }, options.status, {
        ...(options.challenge ? { "www-authenticate": options.challenge } : {}),
      });
    const message = JSON.parse(sent.body ?? "{}") as {
      id?: number;
      method: string;
      params?: { cursor?: string };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: options.tools === false ? {} : { tools: {} },
        serverInfo: { name: options.name ?? "stub-server", version: "1" },
      };
    else if (message.method === "tools/list")
      result = message.params?.cursor
        ? { tools: [{ name: "c" }] }
        : { tools: [{ name: "a" }, { name: "b" }], nextCursor: "page-2" };
    const answer = options.error
      ? {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: VALUE },
        }
      : { jsonrpc: "2.0", id: message.id, result };
    const headers = { "mcp-session-id": "session-1" };
    if (!options.sse) return json(answer, 200, headers);
    // The stream stays open after the answer, with a notification before it.
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify(answer)}\n\n`,
            ),
          );
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream", ...headers },
      },
    );
  };
}

function addMcpServer(
  sources: ReturnType<typeof createMcpServerSources>,
  scope: SecretScope,
  secret: string | null,
) {
  if (secret) addSecret(sources, scope, secret, ["mcp.example.com"]);
  const change = sources.servers.create(scope, {
    name: "linear",
    url: MCP_URL,
    secret,
  });
  expect(change.ok).toBe(true);
}

describe("MCP server tests", () => {
  for (const sse of [false, true])
    it(`initializes, lists every page of tools and ends the session (${sse ? "SSE" : "JSON"})`, async () => {
      const { fetch, sent } = fakeFetch(mcpServer({ sse }));
      // Short, so a read that waits for the open SSE stream to end shows
      // up as a timeout.
      const { sources, tester } = setup(fetch, { timeoutMs: 200 });
      addMcpServer(sources, ALICE, "LINEAR_TOKEN");
      const result = await tester.mcpServer(ALICE, "linear");
      expect(result).toEqual({
        ok: true,
        kind: "mcp",
        host: "mcp.example.com",
        server: "stub-server",
        tools: 3,
      });
      await Bun.sleep(0);
      const methods = sent.map((request) =>
        request.method === "POST"
          ? (JSON.parse(request.body ?? "{}") as { method: string }).method
          : request.method,
      );
      expect(methods).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/list",
        "DELETE",
      ]);
      for (const request of sent) {
        expect(request.url).toBe(MCP_URL);
        expect(request.redirect).toBe("manual");
        expect(request.headers.authorization).toBe(`Bearer ${VALUE}`);
      }
      expect(sent[0].headers.accept).toContain("text/event-stream");
      for (const request of sent.slice(1)) {
        expect(request.headers["mcp-session-id"]).toBe("session-1");
        expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
      }
      expectClean(result);
    });

  it("tests a server with no credential, and skips tools/list without the capability", async () => {
    const { fetch, sent } = fakeFetch(mcpServer({ tools: false }));
    const { sources, tester } = setup(fetch);
    addMcpServer(sources, OFFICE, null);
    expect(await tester.mcpServer(OFFICE, "linear")).toMatchObject({
      ok: true,
      tools: 0,
    });
    expect(sent[0].headers.authorization).toBeUndefined();
    expect(
      sent.some((request) => (request.body ?? "").includes("tools/list")),
    ).toBe(false);
  });

  it("turns each failure into its reason", async () => {
    const cases: [Parameters<typeof mcpServer>[0], ConnectionTestResult][] = [
      [
        { status: 401, challenge: 'Bearer realm="mcp"' },
        { ok: false, host: "mcp.example.com", reason: "refused" },
      ],
      [
        {
          status: 401,
          challenge:
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        },
        { ok: false, host: "mcp.example.com", reason: "needs_oauth" },
      ],
      [
        { status: 403 },
        { ok: false, host: "mcp.example.com", reason: "forbidden" },
      ],
      [
        { status: 404 },
        { ok: false, host: "mcp.example.com", reason: "status", status: 404 },
      ],
      [
        { error: true },
        { ok: false, host: "mcp.example.com", reason: "unexpected" },
      ],
    ];
    for (const [options, expected] of cases) {
      const { fetch } = fakeFetch(mcpServer(options));
      const { sources, tester } = setup(fetch);
      addMcpServer(sources, ALICE, "LINEAR_TOKEN");
      const result = await tester.mcpServer(ALICE, "linear");
      expect(result).toEqual(expected);
      expectClean(result);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says a server with no credential asks for one, instead of refusing it", async () => {
    const { fetch } = fakeFetch(mcpServer({ status: 401 }));
    const { sources, tester } = setup(fetch);
    addMcpServer(sources, ALICE, null);
    expect(await tester.mcpServer(ALICE, "linear")).toEqual({
      ok: false,
      host: "mcp.example.com",
      reason: "no_credential",
    });
  });

  it("does not show a server name that repeats the credential or the URL path", async () => {
    for (const name of [`echo ${VALUE}`, `srv-${PATH_TOKEN}`]) {
      const { fetch } = fakeFetch(mcpServer({ name }));
      const { sources, tester } = setup(fetch);
      addMcpServer(sources, ALICE, "LINEAR_TOKEN");
      const result = await tester.mcpServer(ALICE, "linear");
      expect(result).toMatchObject({ ok: true, server: null, tools: 3 });
      expectClean(result);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("has no test exactly where the list shows the secret's problem", async () => {
    const { fetch, sent } = fakeFetch(mcpServer());
    const { sources, tester } = setup(fetch);
    addMcpServer(sources, ALICE, "LINEAR_TOKEN");
    const problem = () =>
      mcpServerRows(sources, "alice", false).find(
        (row) => row.scope === "personal",
      )?.problem;

    expect(problem()).toBeNull();
    expect((await tester.mcpServer(ALICE, "linear"))?.ok).toBe(true);
    const calls = sent.length;

    // The secret no longer lists the server's host.
    sources.secrets.update(ALICE, "LINEAR_TOKEN", {
      hosts: ["other.example.com"],
    });
    expect(problem()).toBe("secret_host");
    expect(await tester.mcpServer(ALICE, "linear")).toEqual({
      ok: false,
      host: "mcp.example.com",
      reason: "not_testable",
    });

    // The secret is gone.
    sources.secrets.remove(ALICE, "LINEAR_TOKEN");
    expect(problem()).toBe("secret_missing");
    expect(await tester.mcpServer(ALICE, "linear")).toEqual({
      ok: false,
      host: "mcp.example.com",
      reason: "not_testable",
    });
    expect(sent).toHaveLength(calls);
    expect(tester.mcpServer(ALICE, "nope")).toBeNull();
  });
});

describe("cleanName", () => {
  it("keeps plain short text and refuses what could carry the request", () => {
    const sent = { value: VALUE, url: MCP_URL };
    expect(cleanName("  Linear  ", sent)).toBe("Linear");
    expect(cleanName(42, sent)).toBeNull();
    expect(cleanName("", sent)).toBeNull();
    expect(cleanName("x".repeat(101), sent)).toBeNull();
    expect(cleanName("bad\nname", sent)).toBeNull();
    expect(cleanName(`a ${VALUE} b`, sent)).toBeNull();
    expect(cleanName(`a ${PATH_TOKEN} b`, sent)).toBeNull();
    // Short path parts ("mcp") are common words, not secrets.
    expect(cleanName("mcp server", sent)).toBe("mcp server");
  });
});
