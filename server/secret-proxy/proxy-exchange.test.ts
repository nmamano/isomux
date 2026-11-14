// The secret proxy with a token exchange (task 124eb47e), end to end with
// stub hosts on 127.0.0.1: the proxy trades the stored app secret for a
// token at the token address and sends the token, in the header form or in
// one named query parameter. The agent sends only the placeholder, and no
// answer, log code or use row gives it the secret or the token. Values and
// tokens are obvious fakes.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createSecureContext,
  createServer as createTlsServer,
  type TLSSocket,
} from "node:tls";

import type { ExchangeSpec } from "../../shared/secret-hosts.ts";
import {
  exchange,
  startEchoStub,
  TEST_CLIENT_TOKEN,
  tlsThrough,
  type SeenRequest,
} from "../test-support/secret-proxy-stubs.ts";
import { refreshMarginMs } from "./exchange.ts";
import {
  bodyFraming,
  ByteReader,
  readBody,
  readHead,
  serializeHead,
  type HeaderList,
} from "./http1.ts";
import { placeholderFor } from "./placeholders.ts";
import {
  createSecretProxy,
  type ProxySecret,
  type ProxySnapshot,
  type ProxyUse,
  type SecretProxy,
} from "./proxy.ts";
import { SCRUB_MARKER } from "./scrub.ts";
import { createCertificateAuthority, createLeafIssuer } from "./x509.ts";

const KEY = Buffer.alloc(32, 7);
const ALICE = { kind: "user", userId: "alice" } as const;
const OFFICE = { kind: "office" } as const;

// Feishu's shape: JSON body, token and lifetime under its own names, on the
// same host as the API. The header form.
const APP_SECRET = "fake-feishu-app-secret-0001";
const APP_ID = "cli_fake0001";
const FEISHU: ExchangeSpec = {
  url: "https://open.stub.test/auth/v3/token/internal?lang=en",
  body: { kind: "json", idField: "app_id", secretField: "app_secret" },
  id: APP_ID,
  params: {},
  tokenField: "tenant_access_token",
  expiryField: "expire",
};
// OAuth client credentials on a token host apart from the API host. The
// query form, WeCom style.
const CLIENT_SECRET = "fake-client-secret-0002";
const CLIENT_ID = "fake-client-id";
const OAUTH: ExchangeSpec = {
  url: "https://qtoken.stub.test/oauth/token",
  body: { kind: "oauth", clientAuth: "basic" },
  id: CLIENT_ID,
  params: { scope: "msg" },
  tokenField: "access_token",
  expiryField: "expires_in",
};
const PLAIN_VALUE = "fake-plain-header-value-0003";
const COLD_SECRET = "fake-cold-app-secret-0004";

const PH_F = placeholderFor(KEY, ALICE, "FEISHU_APP", 1, APP_SECRET);
const PH_Q = placeholderFor(KEY, OFFICE, "WECOM_APP", 1, CLIENT_SECRET);
const PH_P = placeholderFor(KEY, OFFICE, "PLAIN_KEY", 1, PLAIN_VALUE);
const PH_C = placeholderFor(KEY, ALICE, "COLD_APP", 1, COLD_SECRET);

const FEISHU_SECRET: ProxySecret = {
  scope: "user:alice",
  ownerId: "alice",
  name: "FEISHU_APP",
  value: APP_SECRET,
  hosts: ["open.stub.test"],
  form: { kind: "authorization" },
  exchange: FEISHU,
  placeholder: PH_F,
};
const SECRETS: ProxySecret[] = [
  FEISHU_SECRET,
  {
    scope: "office",
    ownerId: null,
    name: "WECOM_APP",
    value: CLIENT_SECRET,
    hosts: ["qapi.stub.test", "qtoken.stub.test"],
    form: { kind: "query", param: "access_token" },
    exchange: OAUTH,
    placeholder: PH_Q,
  },
  // A plain secret: it makes other.stub.test a terminated host that the
  // exchange secrets do not list.
  {
    scope: "office",
    ownerId: null,
    name: "PLAIN_KEY",
    value: PLAIN_VALUE,
    hosts: ["other.stub.test", "qapi.stub.test"],
    form: { kind: "header", header: "x-api-key" },
    placeholder: PH_P,
  },
  // A second query form on the same hosts, under another parameter: a
  // placeholder goes only into its own secret's parameter.
  {
    scope: "office",
    ownerId: null,
    name: "OTHER_QUERY_APP",
    value: "fake-other-query-secret-0005",
    hosts: ["qapi.stub.test", "qtoken.stub.test"],
    form: { kind: "query", param: "text" },
    exchange: OAUTH,
    placeholder: placeholderFor(
      KEY,
      OFFICE,
      "OTHER_QUERY_APP",
      1,
      "fake-other-query-secret-0005",
    ),
  },
  // Used once, by the from-cold test only.
  {
    ...FEISHU_SECRET,
    name: "COLD_APP",
    value: COLD_SECRET,
    placeholder: PH_C,
  },
];
const FEISHU_LIFETIME_MS = 7200 * 1000;

// --- the stub hosts ---

type TokenMode = "ok" | "refuse" | "redirect" | "no_token";

// One HTTPS server for every stub name (by SNI). Token endpoints issue
// numbered tokens; /echo answers with the request target and the
// Authorization it got; /unauth answers 401.
async function startStub(names: string[]) {
  const ca = createCertificateAuthority();
  const issuer = createLeafIssuer(ca, () => true);
  const contexts = new Map(
    names.map((name) => {
      const leaf = issuer.issue(name);
      return [
        name,
        createSecureContext({ cert: leaf.certPem, key: leaf.keyPem }),
      ];
    }),
  );
  const seen: SeenRequest[] = [];
  // `last`: the Authorization of the last request that was not to /last,
  // as a service that stores a credential and shows it later.
  const state = { mode: "ok" as TokenMode, issued: 0, last: "" };
  const first = issuer.issue(names[0]);
  const respond = (
    socket: TLSSocket,
    status: string,
    headers: HeaderList,
    body = "",
  ) =>
    socket.write(
      Buffer.concat([
        serializeHead(`HTTP/1.1 ${status}`, [
          ...headers,
          ["Content-Length", String(Buffer.byteLength(body, "latin1"))],
        ]),
        Buffer.from(body, "latin1"),
      ]),
    );
  const open = new Set<TLSSocket>();
  const server = createTlsServer(
    {
      SNICallback: (name, done) => done(null, contexts.get(name)),
      cert: first.certPem,
      key: first.keyPem,
    },
    (socket) =>
      void (async () => {
        open.add(socket);
        socket.on("close", () => open.delete(socket));
        socket.on("error", () => {});
        const reader = new ByteReader(socket);
        try {
          for (;;) {
            const head = await readHead(reader);
            if (!head) return void socket.end();
            const [method, target] = head.startLine.split(" ");
            let body = "";
            for await (const piece of readBody(
              reader,
              bodyFraming(head.headers, { strict: true }),
            ))
              body += piece.toString("latin1");
            const sni =
              (socket as unknown as { servername?: string }).servername || null;
            seen.push({ sni, method, target, headers: head.headers, body });
            const auth =
              head.headers.find(
                ([n]) => n.toLowerCase() === "authorization",
              )?.[1] ?? "";
            const path = target.split("?")[0];
            if (path !== "/last") state.last = auth;
            if (
              method === "POST" &&
              (path.endsWith("/token") || path.endsWith("/token/internal"))
            ) {
              if (state.mode === "redirect") {
                respond(socket, "307 Temporary Redirect", [
                  ["Location", "https://other.stub.test/oauth/token"],
                ]);
                continue;
              }
              if (state.mode === "refuse") {
                respond(
                  socket,
                  "401 Unauthorized",
                  [["Content-Type", "application/json"]],
                  JSON.stringify({ error: `CANARY-reply-text ${body}` }),
                );
                continue;
              }
              if (state.mode === "no_token") {
                // Feishu's error: 200 with a code and no token.
                respond(
                  socket,
                  "200 OK",
                  [["Content-Type", "application/json"]],
                  JSON.stringify({ code: 10003, msg: "CANARY-reply-text" }),
                );
                continue;
              }
              state.issued++;
              const n = String(state.issued).padStart(4, "0");
              const reply =
                sni === "qtoken.stub.test"
                  ? // Characters that a query must carry encoded.
                    { access_token: `q.FAKE+tok/en=${n}`, expires_in: 3600 }
                  : {
                      code: 0,
                      tenant_access_token: `t-FAKEtoken${n}`,
                      expire: 7200,
                    };
              respond(
                socket,
                "200 OK",
                [["Content-Type", "application/json"]],
                JSON.stringify(reply),
              );
            } else if (path === "/last") {
              respond(socket, "200 OK", [], `last=${state.last}`);
            } else if (path === "/unauth") {
              respond(socket, "401 Unauthorized", [], "no");
            } else {
              respond(
                socket,
                "200 OK",
                [["X-Echo-Target", target]],
                `target=${target}\nauthorization=${auth}`,
              );
            }
          }
        } catch {
          socket.destroy();
        }
      })(),
  );
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  return {
    port,
    ca,
    seen,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// --- the proxy ---

const officeCa = createCertificateAuthority();
const NAMES = [
  "open.stub.test",
  "qapi.stub.test",
  "qtoken.stub.test",
  "other.stub.test",
];
let stub: Awaited<ReturnType<typeof startStub>>;
let echo: Awaited<ReturnType<typeof startEchoStub>>;
let proxy: SecretProxy;
let port = 0;
const clock = { now: 1_000_000_000 };
const uses: ProxyUse[] = [];
const logs: string[] = [];

function snapshot(secrets = SECRETS): ProxySnapshot {
  return {
    secrets,
    caCertPem: officeCa.certPem,
    caKeyPem: officeCa.keyPem,
    rootsPem: createCertificateAuthority().certPem,
    upstreamProxy: null,
    clientToken: TEST_CLIENT_TOKEN,
  };
}

beforeAll(async () => {
  stub = await startStub(NAMES);
  echo = await startEchoStub();
  proxy = createSecretProxy(
    snapshot(),
    { use: (u) => uses.push(u), log: (code) => logs.push(code) },
    {
      standIns: Object.fromEntries(NAMES.map((n) => [`${n}:443`, stub.port])),
      upstreamRoots: stub.ca.certPem,
      now: () => clock.now,
    },
  );
  port = await proxy.listen(0);
});

afterAll(async () => {
  await proxy.close();
  await stub.close();
  await echo.close();
});

// Each test starts with a fresh cache: a new snapshot does not drop tokens
// (the key is the secret and its value), so the clock moves past every
// lifetime and backoff instead.
beforeEach(() => {
  clock.now += 48 * 3600 * 1000;
  stub.state.mode = "ok";
  // Token numbers count per test, so a test can name the token it gets.
  stub.state.issued = 0;
  stub.seen.length = 0;
  uses.length = 0;
  logs.length = 0;
  proxy.update(snapshot());
});

async function request(host: string, raw: string) {
  const socket = await tlsThrough(port, host, officeCa);
  const reader = new ByteReader(socket);
  try {
    return await exchange(socket, reader, raw);
  } finally {
    socket.destroy();
  }
}

const req = (
  method: string,
  target: string,
  host: string,
  headers: string[] = [],
) =>
  `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n`;

const tokenPosts = () =>
  stub.seen.filter(
    (s) => s.method === "POST" && /token/.test(s.target.split("?")[0]),
  );
const apiCalls = (sni: string) =>
  stub.seen.filter(
    (s) => s.sni === sni && !/token/.test(s.target.split("?")[0]),
  );
const authOf = (s: SeenRequest | undefined) =>
  s?.headers.find(([n]) => n.toLowerCase() === "authorization")?.[1];

// No answer text or log code carries a secret, a token, a placeholder or a
// query.
function expectNothingLeaks(texts: (string | undefined)[]) {
  const all = [...texts, ...logs].join("\n");
  for (const fake of [
    APP_SECRET,
    CLIENT_SECRET,
    "t-FAKEtoken",
    "q.FAKE",
    encodeURIComponent("q.FAKE+tok/en"),
    "CANARY",
  ])
    expect(all).not.toContain(fake);
}

describe("the header form", () => {
  test("the placeholder becomes the token; the token address gets the app id and secret once", async () => {
    const first = await request(
      "open.stub.test",
      req("GET", "/open-apis/im/v1/chats?page=1", "open.stub.test", [
        `Authorization: Bearer ${PH_F}`,
      ]),
    );
    expect(first?.status).toBe(200);
    const posts = tokenPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].sni).toBe("open.stub.test");
    expect(posts[0].target).toBe("/auth/v3/token/internal?lang=en");
    expect(JSON.parse(posts[0].body)).toEqual({
      app_id: APP_ID,
      app_secret: APP_SECRET,
    });
    const [call] = apiCalls("open.stub.test");
    expect(authOf(call)).toBe("Bearer t-FAKEtoken0001");
    // The stub echoed the token; the scrub removed it on the way back.
    expect(first?.body).toContain(SCRUB_MARKER);
    expectNothingLeaks([first?.body, JSON.stringify(first?.headers)]);

    // The next request reuses the token.
    await request(
      "open.stub.test",
      req("GET", "/open-apis/im/v1/chats", "open.stub.test", [
        `Authorization: Bearer ${PH_F}`,
      ]),
    );
    expect(tokenPosts()).toHaveLength(1);
    expect(authOf(apiCalls("open.stub.test")[1])).toBe(
      "Bearer t-FAKEtoken0001",
    );
  });

  test("a token that a later answer shows is scrubbed, also in a request that sent none", async () => {
    await request(
      "open.stub.test",
      req("GET", "/x", "open.stub.test", [`Authorization: Bearer ${PH_F}`]),
    );
    expect(authOf(apiCalls("open.stub.test")[0])).toBe(
      "Bearer t-FAKEtoken0001",
    );
    // No placeholder in this one: only the scrub's set of live tokens
    // covers what the service stored.
    const shown = await request(
      "open.stub.test",
      req("GET", "/last", "open.stub.test"),
    );
    expect(shown?.body).toContain(SCRUB_MARKER);
    expectNothingLeaks([shown?.body]);
  });

  test("one use row for the exchange and one for the swap, with paths and no query", async () => {
    await request(
      "open.stub.test",
      req("GET", "/open-apis/im/v1/chats?page=1", "open.stub.test", [
        `Authorization: Bearer ${PH_F}`,
      ]),
    );
    const row = {
      scope: "user:alice",
      ownerId: "alice",
      name: "FEISHU_APP",
      host: "open.stub.test",
    };
    expect(uses).toHaveLength(2);
    expect(uses).toContainEqual({
      ...row,
      method: "POST",
      path: "/auth/v3/token/internal",
    });
    expect(uses).toContainEqual({
      ...row,
      method: "GET",
      path: "/open-apis/im/v1/chats",
    });
  });

  test("from cold, concurrent requests share one exchange", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(
          "open.stub.test",
          req("GET", "/open-apis/x", "open.stub.test", [
            `Authorization: Bearer ${PH_C}`,
          ]),
        ),
      ),
    );
    expect(results.map((r) => r?.status)).toEqual([200, 200, 200, 200, 200]);
    expect(tokenPosts()).toHaveLength(1);
    expect(JSON.parse(tokenPosts()[0].body).app_secret).toBe(COLD_SECRET);
  });

  test("a token is fetched again at its refresh margin, not before", async () => {
    const call = () =>
      request(
        "open.stub.test",
        req("GET", "/open-apis/x", "open.stub.test", [
          `Authorization: Bearer ${PH_F}`,
        ]),
      );
    await call();
    const freshFor = FEISHU_LIFETIME_MS - refreshMarginMs(FEISHU_LIFETIME_MS);
    clock.now += freshFor - 1000;
    await call();
    expect(tokenPosts()).toHaveLength(1);
    clock.now += 2000;
    await call();
    expect(tokenPosts()).toHaveLength(2);
    const auths = apiCalls("open.stub.test").map(authOf);
    expect(auths.at(-1)).not.toBe(auths[0]);
  });

  test("a rotated value is exchanged again, with the new value", async () => {
    const call = () =>
      request(
        "open.stub.test",
        req("GET", "/open-apis/x", "open.stub.test", [
          `Authorization: Bearer ${PH_F}`,
        ]),
      );
    await call();
    const rotated = "fake-feishu-app-secret-rotated-01";
    proxy.update(
      snapshot(
        SECRETS.map((s) =>
          s.name === "FEISHU_APP" ? { ...s, value: rotated } : s,
        ),
      ),
    );
    await call();
    expect(tokenPosts().map((p) => JSON.parse(p.body).app_secret)).toEqual([
      APP_SECRET,
      rotated,
    ]);
  });

  test("a failed exchange is a 502 that names the secret and repeats nothing of the reply, and it backs off", async () => {
    for (const mode of ["refuse", "no_token"] as const) {
      // Past the lifetime of the token the first round got.
      clock.now += 48 * 3600 * 1000;
      stub.state.mode = mode;
      stub.seen.length = 0;
      const call = () =>
        request(
          "open.stub.test",
          req("GET", "/open-apis/x", "open.stub.test", [
            `Authorization: Bearer ${PH_F}`,
          ]),
        );
      const failed = await call();
      expect([mode, failed?.status]).toEqual([mode, 502]);
      expect(failed?.body).toContain("FEISHU_APP");
      expectNothingLeaks([failed?.body]);
      // Nothing reached the API.
      expect(apiCalls("open.stub.test")).toEqual([]);
      // Within the backoff: the same answer, no new exchange.
      stub.state.mode = "ok";
      clock.now += 10_000;
      expect((await call())?.status).toBe(502);
      expect(tokenPosts()).toHaveLength(1);
      // After it: a new exchange.
      clock.now += 25_000;
      expect((await call())?.status).toBe(200);
      expect(tokenPosts()).toHaveLength(2);
    }
  });

  test("a redirect from the token address is a failure, never followed", async () => {
    stub.state.mode = "redirect";
    const failed = await request(
      "open.stub.test",
      req("GET", "/open-apis/x", "open.stub.test", [
        `Authorization: Bearer ${PH_F}`,
      ]),
    );
    expect(failed?.status).toBe(502);
    // A 307 would carry the secret again: the redirect target heard nothing.
    expect(stub.seen.filter((s) => s.sni === "other.stub.test")).toEqual([]);
    expect(tokenPosts()).toHaveLength(1);
  });

  test("no exchange where nothing is injected: TRACE, OPTIONS, a forbidden host, no placeholder, inside Basic", async () => {
    for (const method of ["TRACE", "OPTIONS"])
      await request(
        "open.stub.test",
        req(method, "/x", "open.stub.test", [`Authorization: Bearer ${PH_F}`]),
      );
    const forbidden = await request(
      "other.stub.test",
      req("GET", "/x", "other.stub.test", [`Authorization: Bearer ${PH_F}`]),
    );
    expect(forbidden?.status).toBe(403);
    await request("open.stub.test", req("GET", "/x", "open.stub.test"));
    // The token goes only as a whole Authorization token, never inside Basic.
    const basic = Buffer.from(`user:${PH_F}`).toString("base64");
    await request(
      "open.stub.test",
      req("GET", "/basic", "open.stub.test", [`Authorization: Basic ${basic}`]),
    );
    expect(authOf(stub.seen.find((s) => s.target === "/basic"))).toBe(
      `Basic ${basic}`,
    );
    expect(tokenPosts()).toEqual([]);
    // TRACE and OPTIONS reached the host with the placeholder only.
    for (const method of ["TRACE", "OPTIONS"])
      expect(authOf(stub.seen.find((s) => s.method === method))).toBe(
        `Bearer ${PH_F}`,
      );
  });

  test("an upstream 401 drops a token a minute old, not a fresher one", async () => {
    const call = (path: string) =>
      request(
        "open.stub.test",
        req("GET", path, "open.stub.test", [`Authorization: Bearer ${PH_F}`]),
      );
    await call("/x");
    clock.now += 30_000;
    expect((await call("/unauth"))?.status).toBe(401);
    await call("/x");
    expect(tokenPosts()).toHaveLength(1);
    clock.now += 31_000;
    await call("/unauth");
    await call("/x");
    expect(tokenPosts()).toHaveLength(2);
  });
});

describe("the query form", () => {
  const TOKEN_1 = "q.FAKE+tok/en=0001";
  const q = (target: string, method = "GET", headers: string[] = []) =>
    request("qapi.stub.test", req(method, target, "qapi.stub.test", headers));
  const seenTarget = () => apiCalls("qapi.stub.test").at(-1)?.target;

  test("the named parameter's placeholder becomes the encoded token; every other byte stays", async () => {
    const response = await q(
      `/cgi-bin/send?debug=1&access_token=${PH_Q}&b=%20x`,
    );
    expect(response?.status).toBe(200);
    expect(seenTarget()).toBe(
      `/cgi-bin/send?debug=1&access_token=${encodeURIComponent(TOKEN_1)}&b=%20x`,
    );
    // The exchange: OAuth client credentials with Basic, at the token host.
    const [post] = tokenPosts();
    expect(post.sni).toBe("qtoken.stub.test");
    expect(authOf(post)).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      grant_type: "client_credentials",
      scope: "msg",
    });
    // The echo of the target and its header came back scrubbed.
    expect(response?.body).toContain(SCRUB_MARKER);
    expectNothingLeaks([response?.body, JSON.stringify(response?.headers)]);
    // The use row has the path only.
    expect(uses).toContainEqual({
      scope: "office",
      ownerId: null,
      name: "WECOM_APP",
      host: "qapi.stub.test",
      method: "GET",
      path: "/cgi-bin/send",
    });
  });

  test("a placeholder anywhere else in the target is not swapped and starts no exchange", async () => {
    for (const target of [
      `/cgi-bin/${PH_Q}?x=1`,
      `/send?q=${PH_Q}`,
      // Another query form's parameter.
      `/send?text=${PH_Q}`,
      `/send?${PH_Q}=1`,
      `/send?access_token=x${PH_Q}`,
      `/send?access_token=${PH_Q}x`,
      `/send?Access_Token=${PH_Q}`,
    ]) {
      const response = await q(target);
      expect([target, response?.status]).toEqual([target, 200]);
      expect(seenTarget()).toBe(target);
    }
    expect(tokenPosts()).toEqual([]);
  });

  test("a second parameter of the name next to a placeholder is refused, also under another spelling", async () => {
    for (const target of [
      `/send?access_token=${PH_Q}&access_token=other`,
      `/send?access_token=other&access_token=${PH_Q}`,
      `/send?access%5Ftoken=other&access_token=${PH_Q}`,
      `/send?access_token&access_token=${PH_Q}`,
    ]) {
      const response = await q(target);
      expect([target, response?.status]).toEqual([target, 400]);
      expectNothingLeaks([response?.body]);
      expect(response?.body).not.toContain(PH_Q);
    }
    expect(apiCalls("qapi.stub.test")).toEqual([]);
    expect(tokenPosts()).toEqual([]);
    // Without a placeholder, a repeated parameter is none of the proxy's
    // business.
    expect((await q("/send?access_token=a&access_token=b"))?.status).toBe(200);
    expect(seenTarget()).toBe("/send?access_token=a&access_token=b");
  });

  test("a placeholder or name that matches only after percent-decoding is refused", async () => {
    const hex = (ch: string) =>
      `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    const encodedPlaceholder = hex(PH_Q[0]) + PH_Q.slice(1);
    for (const target of [
      `/send?access_token=${encodedPlaceholder}`,
      `/send?access%5Ftoken=${PH_Q}`,
      `/send?access%5ftoken=${encodedPlaceholder}`,
    ]) {
      const response = await q(target);
      expect([target, response?.status]).toEqual([target, 400]);
      // The answer names the secret, so the agent knows what to fix.
      expect(response?.body).toContain("WECOM_APP");
    }
    expect(apiCalls("qapi.stub.test")).toEqual([]);
    expect(tokenPosts()).toEqual([]);
  });

  test("the host, method and form rules of the header swap hold for the query", async () => {
    // A terminated host the secret does not list.
    const forbidden = await request(
      "other.stub.test",
      req("GET", `/send?access_token=${PH_Q}`, "other.stub.test"),
    );
    expect(forbidden?.status).toBe(403);
    expect(forbidden?.body).toContain("WECOM_APP");
    // TRACE and OPTIONS: left as sent.
    for (const method of ["TRACE", "OPTIONS"]) {
      await q(`/send?access_token=${PH_Q}`, method);
      expect(seenTarget()).toBe(`/send?access_token=${PH_Q}`);
    }
    // A query-form secret is never swapped in a header ...
    await q("/hdr", "GET", [`Authorization: Bearer ${PH_Q}`]);
    expect(authOf(apiCalls("qapi.stub.test").at(-1))).toBe(`Bearer ${PH_Q}`);
    // ... and a header-form secret never in the query, on a host it lists.
    await q(`/send?x-api-key=${PH_P}&access_token=${PH_P}`);
    expect(seenTarget()).toBe(`/send?x-api-key=${PH_P}&access_token=${PH_P}`);
    expect(tokenPosts()).toEqual([]);
    expect(
      uses.filter((u) => u.name === "WECOM_APP" || u.name === "PLAIN_KEY"),
    ).toEqual([]);
  });

  test("no log code or refusal carries the target, the token or the placeholder", async () => {
    await q(`/send?access_token=${PH_Q}`);
    const refusals = [
      await q(`/send?access_token=${PH_Q}&access_token=x`),
      await q(`/send?access%5Ftoken=${PH_Q}`),
      await request(
        "other.stub.test",
        req("GET", `/send?access_token=${PH_Q}`, "other.stub.test"),
      ),
    ];
    const text = [...refusals.map((r) => r?.body), ...logs].join("\n");
    expect(text).not.toContain(PH_Q);
    expect(text).not.toContain("/send");
    expectNothingLeaks([text]);
    expect(logs.every((code) => /^[a-z0-9_]+$/.test(code))).toBe(true);
  });
});
