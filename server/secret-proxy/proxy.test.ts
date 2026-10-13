// The secret proxy's boundary cases (internal-docs/secrets-design.md,
// appendix D) and Omnigent's failure cases (secrets-prior-art.md), with stub
// hosts on 127.0.0.1. Values and placeholders are obvious fakes.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { connect as netConnect, type Socket } from "node:net";

import {
  connectThrough,
  exchange,
  startCompanyProxy,
  startEchoStub,
  startHttpsStub,
  tlsThrough,
} from "../test-support/secret-proxy-stubs.ts";
import { ByteReader } from "./http1.ts";
import { placeholderFor } from "./placeholders.ts";
import {
  createSecretProxy,
  type ProxySecret,
  type ProxySnapshot,
  type ProxyUse,
  type SecretProxy,
} from "./proxy.ts";
import { SCRUB_MARKER } from "./scrub.ts";
import { createCertificateAuthority } from "./x509.ts";

const KEY = Buffer.alloc(32, 3);
const ALICE = { kind: "user", userId: "alice" } as const;
const OFFICE = { kind: "office" } as const;

const VALUE_A = "ghp_FAKEaaaaFAKEaaaaFAKEaaaaFAKEaaaa0001";
const VALUE_B = "fake-header-value-bbbb-0002";
const VALUE_N = "fake-never-listed-value-0003";
const PH_A = placeholderFor(KEY, ALICE, "GH_TOKEN", 1, VALUE_A);
const PH_B = placeholderFor(KEY, OFFICE, "OTHER_KEY", 1, VALUE_B);
const PH_N = placeholderFor(KEY, OFFICE, "NEVER_KEY", 1, VALUE_N);

const SECRETS: ProxySecret[] = [
  {
    scope: "user:alice",
    ownerId: "alice",
    name: "GH_TOKEN",
    value: VALUE_A,
    hosts: ["api.stub.test"],
    form: { kind: "authorization" },
    placeholder: PH_A,
  },
  {
    scope: "office",
    ownerId: null,
    name: "OTHER_KEY",
    value: VALUE_B,
    hosts: ["other.stub.test"],
    form: { kind: "header", header: "x-api-key" },
    placeholder: PH_B,
  },
  // A hand-edited store that lists a never-listed host: the routes refuse
  // it, and the proxy must still tunnel.
  {
    scope: "office",
    ownerId: null,
    name: "NEVER_KEY",
    value: VALUE_N,
    hosts: ["api.anthropic.com"],
    form: { kind: "authorization" },
    placeholder: PH_N,
  },
];
const ALL_VALUES = [VALUE_A, VALUE_B, VALUE_N];
// The most body bytes that may leave the upstream while the client reads
// nothing: loopback socket buffers on each hop held 10-14 MiB (measured
// 2026-10-13); without back pressure all 128 MiB leave.
const BACK_PRESSURE_BOUND = 32 * 1024 * 1024;

const officeCa = createCertificateAuthority();
let https: Awaited<ReturnType<typeof startHttpsStub>>;
let echo: Awaited<ReturnType<typeof startEchoStub>>;
let proxy: SecretProxy;
let port = 0;
const uses: ProxyUse[] = [];
const logs: string[] = [];

function snapshot(extra: Partial<ProxySnapshot> = {}): ProxySnapshot {
  return {
    secrets: SECRETS,
    caCertPem: officeCa.certPem,
    caKeyPem: officeCa.keyPem,
    // The production roots, which do not trust the stubs: tests pass the
    // stub CA through the upstreamRoots option.
    rootsPem: createCertificateAuthority().certPem,
    upstreamProxy: null,
    ...extra,
  };
}

beforeAll(async () => {
  https = await startHttpsStub(["api.stub.test", "other.stub.test"]);
  echo = await startEchoStub();
  proxy = createSecretProxy(
    snapshot(),
    { use: (u) => uses.push(u), log: (code) => logs.push(code) },
    {
      standIns: {
        "api.stub.test:443": https.port,
        "other.stub.test:443": https.port,
        "tunnel.stub.test:443": echo.port,
        "api.anthropic.com:443": echo.port,
      },
      upstreamRoots: https.ca.certPem,
    },
  );
  port = await proxy.listen(0);
});

afterAll(async () => {
  await proxy.close();
  await https.close();
  await echo.close();
});

beforeEach(() => {
  https.seen.length = 0;
  echo.received.length = 0;
  uses.length = 0;
});

// One request on a fresh TLS connection to `host` through the proxy.
async function request(
  host: string,
  raw: string,
  servername: string | null = host,
) {
  const socket = await tlsThrough(port, host, officeCa, servername);
  const reader = new ByteReader(socket);
  try {
    return await exchange(socket, reader, raw);
  } finally {
    socket.destroy();
  }
}

const get = (path: string, headers: string[] = [], host = "api.stub.test") =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n`;

function header(name: string, seen = https.seen[0]) {
  return seen?.headers.find(([n]) => n.toLowerCase() === name)?.[1];
}

function expectNoValue(text: string | undefined) {
  for (const value of ALL_VALUES) expect(text ?? "").not.toContain(value);
}

describe("injection on a listed host", () => {
  test("a Bearer placeholder becomes the value at the listed host", async () => {
    const response = await request(
      "api.stub.test",
      get("/headers?q=1", [`Authorization: Bearer ${PH_A}`]),
    );
    expect(https.seen).toHaveLength(1);
    expect(header("authorization")).toBe(`Bearer ${VALUE_A}`);
    expect(response?.status).toBe(200);
    // The stub echoed the value; the scrub removed it on the way back.
    expectNoValue(response?.body);
    expect(response?.body).toContain(SCRUB_MARKER);
  });

  test("one use row per swap, with the path and no query", async () => {
    await request(
      "api.stub.test",
      get("/repos/x?token=secret", [`Authorization: Bearer ${PH_A}`]),
    );
    expect(uses).toEqual([
      {
        scope: "user:alice",
        ownerId: "alice",
        name: "GH_TOKEN",
        host: "api.stub.test",
        method: "GET",
        path: "/repos/x",
      },
    ]);
  });

  test("Basic: the placeholder as the password or the user is swapped after decoding", async () => {
    const asPassword = Buffer.from(`x-access-token:${PH_A}`).toString("base64");
    await request(
      "api.stub.test",
      get("/", [`Authorization: Basic ${asPassword}`]),
    );
    expect(header("authorization")).toBe(
      `Basic ${Buffer.from(`x-access-token:${VALUE_A}`).toString("base64")}`,
    );
    https.seen.length = 0;
    const asUser = Buffer.from(`${PH_A}:x`).toString("base64");
    await request(
      "api.stub.test",
      get("/", [`authorization: basic ${asUser}`]),
    );
    expect(header("authorization")).toBe(
      `basic ${Buffer.from(`${VALUE_A}:x`).toString("base64")}`,
    );
  });

  test("a header-form secret is swapped in its named header only", async () => {
    await request(
      "other.stub.test",
      get(
        "/",
        [
          `X-Api-Key: ${PH_B}`,
          `X-Other: ${PH_B}`,
          `Authorization: Bearer ${PH_B}`,
        ],
        "other.stub.test",
      ),
    );
    expect(header("x-api-key")).toBe(VALUE_B);
    expect(header("x-other")).toBe(PH_B);
    expect(header("authorization")).toBe(`Bearer ${PH_B}`);
  });

  test("an MCP request (JSON-RPC POST, streamable HTTP) gets the value in its header and keeps its body", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const response = await request(
      "api.stub.test",
      `POST /mcp HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMcp-Protocol-Version: 2025-06-18\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    expect(response?.status).toBe(200);
    expect(header("authorization")).toBe(`Bearer ${VALUE_A}`);
    expect(header("mcp-protocol-version")).toBe("2025-06-18");
    expect(https.seen[0].body).toBe(body);
    expect(uses.map((u) => u.path)).toEqual(["/mcp"]);
  });

  test("a placeholder in the body, the query or another header is not swapped", async () => {
    const body = `token=${PH_A}`;
    await request(
      "api.stub.test",
      `POST /x?t=${PH_A} HTTP/1.1\r\nHost: api.stub.test\r\nX-Token: ${PH_A}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    const seen = https.seen[0];
    expect(seen.body).toBe(body);
    expect(seen.target).toBe(`/x?t=${PH_A}`);
    expect(header("x-token")).toBe(PH_A);
    expect(uses).toHaveLength(0);
  });
});

describe("Omnigent's failure cases", () => {
  test("a placeholder sent to a terminated host that its secret does not list gets 403, and nothing is forwarded", async () => {
    const response = await request(
      "other.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`], "other.stub.test"),
    );
    expect(response?.status).toBe(403);
    expect(response?.body).toContain("GH_TOKEN");
    expect(response?.body).toContain("other.stub.test");
    expect(https.seen).toHaveLength(0);
    expect(uses).toHaveLength(0);
  });

  test("TRACE and OPTIONS to a listed host carry no value", async () => {
    for (const method of ["TRACE", "OPTIONS"]) {
      https.seen.length = 0;
      await request(
        "api.stub.test",
        `${method} / HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\n\r\n`,
      );
      expect(https.seen).toHaveLength(1);
      expect(header("authorization")).toBe(`Bearer ${PH_A}`);
    }
    expect(uses).toHaveLength(0);
  });

  test("a client's own Authorization that is no placeholder goes through untouched", async () => {
    const raw =
      "POST /api/v3/things?a=1 HTTP/1.1\r\n" +
      "Host: api.stub.test\r\n" +
      "User-Agent: codex/0.160\r\n" +
      "Authorization: Bearer fake-client-own-token\r\n" +
      "X-Mixed-Case: Keep This\r\n" +
      "Accept: */*\r\n" +
      "Content-Length: 5\r\n\r\nhello";
    const response = await request("api.stub.test", raw);
    expect(response?.status).toBe(200);
    const seen = https.seen[0];
    expect(seen.method).toBe("POST");
    expect(seen.target).toBe("/api/v3/things?a=1");
    expect(seen.body).toBe("hello");
    expect(seen.headers).toEqual([
      ["Host", "api.stub.test"],
      ["User-Agent", "codex/0.160"],
      ["Authorization", "Bearer fake-client-own-token"],
      ["X-Mixed-Case", "Keep This"],
      ["Accept", "*/*"],
      ["Content-Length", "5"],
    ]);
  });
});

describe("tunnels", () => {
  test("a host that no secret lists is a tunnel and gets only the placeholder", async () => {
    const tunnel = await connectThrough(port, "tunnel.stub.test:443");
    if ("refused" in tunnel) throw new Error("refused");
    tunnel.socket.write(`Authorization: Bearer ${PH_A}\r\n`);
    const back = await tunnel.reader.read(4096);
    tunnel.socket.destroy();
    expect(back?.toString()).toContain(PH_A);
    expect(echo.received.join("")).toContain(PH_A);
    expectNoValue(echo.received.join(""));
  });

  test("a never-listed host is always a tunnel, even when a stored secret lists it", async () => {
    const tunnel = await connectThrough(port, "api.anthropic.com:443");
    if ("refused" in tunnel) throw new Error("refused");
    // Plain text, not TLS: a terminating proxy would not pass it through.
    tunnel.socket.write(`Authorization: Bearer ${PH_N}\r\n`);
    const back = await tunnel.reader.read(4096);
    tunnel.socket.destroy();
    expect(back?.toString()).toContain(PH_N);
    expect(echo.received.join("")).toContain(PH_N);
    expectNoValue(echo.received.join(""));
  });

  test("a listed host on another port is a tunnel", async () => {
    const tunnel = await connectThrough(port, "api.stub.test:8443");
    // No stand-in for 8443 and no DNS for the name: the tunnel cannot open.
    expect("refused" in tunnel && tunnel.refused.status).toBe(502);
  });

  test("a request that is not CONNECT gets 405", async () => {
    const socket = await new Promise<Socket>((resolve) => {
      const s = netConnect(port, "127.0.0.1", () => resolve(s));
    });
    const reader = new ByteReader(socket);
    socket.write(
      "GET http://api.stub.test/ HTTP/1.1\r\nHost: api.stub.test\r\n\r\n",
    );
    const head = (await reader.read(4096))?.toString() ?? "";
    socket.destroy();
    expect(head.startsWith("HTTP/1.1 405")).toBe(true);
  });
});

describe("421: CONNECT, SNI and Host must agree on every request", () => {
  test("a Host that names another host", async () => {
    const response = await request(
      "api.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`], "other.stub.test"),
    );
    expect(response?.status).toBe(421);
    expect(https.seen).toHaveLength(0);
  });

  test("the second request on a kept-alive connection with another Host", async () => {
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    const reader = new ByteReader(socket);
    const first = await exchange(
      socket,
      reader,
      get("/one", [`Authorization: Bearer ${PH_A}`]),
    );
    const second = await exchange(
      socket,
      reader,
      get("/two", [`Authorization: Bearer ${PH_A}`], "other.stub.test"),
    );
    socket.destroy();
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(421);
    expect(https.seen.map((s) => s.target)).toEqual(["/one"]);
  });

  test("an absolute-form target that names another host", async () => {
    const response = await request(
      "api.stub.test",
      `GET https://other.stub.test/ HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\n\r\n`,
    );
    expect(response?.status).toBe(421);
    expect(https.seen).toHaveLength(0);
  });

  test("an absolute-form target that names the CONNECT host is sent as a path", async () => {
    await request(
      "api.stub.test",
      `GET https://api.stub.test/abs?x=1 HTTP/1.1\r\nHost: api.stub.test\r\n\r\n`,
    );
    expect(https.seen[0].target).toBe("/abs?x=1");
  });

  test("Host compare: case and :443 are the same host, a trailing dot is not", async () => {
    const same = await request(
      "api.stub.test",
      get("/", [], "API.Stub.Test:443"),
    );
    expect(same?.status).toBe(200);
    expect(header("host")).toBe("api.stub.test");
    const dot = await request("api.stub.test", get("/", [], "api.stub.test."));
    expect(dot?.status).toBe(421);
  });

  test("an SNI that names another listed host", async () => {
    const response = await request(
      "api.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`]),
      "other.stub.test",
    );
    expect(response?.status).toBe(421);
    expect(https.seen).toHaveLength(0);
  });

  test("no SNI", async () => {
    const response = await request(
      "api.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`]),
      null,
    );
    expect(response?.status).toBe(421);
    expect(https.seen).toHaveLength(0);
  });

  test("an SNI that names an unlisted host: no certificate, no request", async () => {
    const outcome = await tlsThrough(
      port,
      "api.stub.test",
      officeCa,
      "tunnel.stub.test",
    ).then(
      (socket) => {
        socket.destroy();
        return "connected";
      },
      () => "refused",
    );
    expect(outcome).toBe("refused");
    expect(https.seen).toHaveLength(0);
  });
});

describe("400 and 501: framing and protocols the proxy refuses", () => {
  test("Content-Length with Transfer-Encoding", async () => {
    const response = await request(
      "api.stub.test",
      `POST / HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    );
    expect(response?.status).toBe(400);
    expect(https.seen).toHaveLength(0);
  });

  test("two Host fields", async () => {
    const response = await request(
      "api.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`, "Host: other.stub.test"]),
    );
    expect(response?.status).toBe(400);
    expect(https.seen).toHaveLength(0);
  });

  test("two Authorization fields", async () => {
    const response = await request(
      "api.stub.test",
      get("/", [`Authorization: Bearer ${PH_A}`, "Authorization: Bearer x"]),
    );
    expect(response?.status).toBe(400);
    expect(https.seen).toHaveLength(0);
  });

  test("an Upgrade request and a CONNECT inside the tunnel", async () => {
    const upgrade = await request(
      "api.stub.test",
      get("/ws", [
        `Authorization: Bearer ${PH_A}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
      ]),
    );
    expect(upgrade?.status).toBe(501);
    const inner = await request(
      "api.stub.test",
      "CONNECT api.stub.test:443 HTTP/1.1\r\nHost: api.stub.test\r\n\r\n",
    );
    expect(inner?.status).toBe(501);
    expect(https.seen).toHaveLength(0);
  });

  test("Expect: 100-continue does not hang", async () => {
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    const reader = new ByteReader(socket);
    socket.write(
      `POST /up HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\n`,
    );
    setTimeout(() => socket.write("data"), 50);
    const response = await exchange(socket, reader, "");
    socket.destroy();
    expect(response?.status).toBe(200);
    expect(https.seen[0].body).toBe("data");
  });
});

describe("responses", () => {
  test("a redirect is returned, not followed", async () => {
    const response = await request(
      "api.stub.test",
      get("/redirect", [`Authorization: Bearer ${PH_A}`]),
    );
    expect(response?.status).toBe(302);
    expect(response?.headers).toContainEqual([
      "Location",
      "https://other.stub.test/landing",
    ]);
    expect(https.seen).toHaveLength(1);
  });

  test("the raw, URL-encoded and base64 forms are scrubbed from headers and body; hex is the known limit", async () => {
    const response = await request(
      "api.stub.test",
      get(`/reflect?v=${encodeURIComponent(VALUE_A)}`, [
        `Authorization: Bearer ${PH_A}`,
      ]),
    );
    const text = `${JSON.stringify(response?.headers)}\n${response?.body}`;
    expectNoValue(text);
    expect(text).not.toContain(encodeURIComponent(VALUE_A));
    expect(text).not.toContain(
      Buffer.from(`user:${VALUE_A}`).toString("base64"),
    );
    expect(text).not.toContain(Buffer.from(VALUE_A).toString("base64"));
    // Known limit (section 2.5): a reflection in an encoding the scrub does
    // not know reaches the client.
    expect(text).toContain(Buffer.from(VALUE_A).toString("hex"));
  });

  test("a value split across two chunks is scrubbed", async () => {
    const response = await request(
      "api.stub.test",
      get(`/split?v=${encodeURIComponent(VALUE_A)}`, [
        `Authorization: Bearer ${PH_A}`,
      ]),
    );
    expect(response?.body).toBe(`a=${SCRUB_MARKER};`);
  });

  test("a gzip body is decoded and scrubbed, and a swapped request asks for identity", async () => {
    const response = await request(
      "api.stub.test",
      get(`/gzip?v=${encodeURIComponent(VALUE_A)}`, [
        `Authorization: Bearer ${PH_A}`,
        "Accept-Encoding: gzip, br",
      ]),
    );
    expect(header("accept-encoding")).toBe("identity");
    expect(response?.body).toBe(`gz=${SCRUB_MARKER}`);
    expect(response?.headers.map(([n]) => n.toLowerCase())).not.toContain(
      "content-encoding",
    );
  });

  test("an unswapped request asks only for codings the scrub decodes", async () => {
    await request(
      "api.stub.test",
      get("/", ["Accept-Encoding: zstd, gzip;q=0.5, br"]),
    );
    expect(header("accept-encoding")).toBe("gzip;q=0.5, br");
    https.seen.length = 0;
    await request("api.stub.test", get("/", ["Accept-Encoding: zstd"]));
    expect(header("accept-encoding")).toBe("identity");
  });

  test("a content coding the scrub cannot decode gets 502", async () => {
    const response = await request("api.stub.test", get("/zstd"));
    expect(response?.status).toBe(502);
  });

  test("HEAD keeps its Content-Length and has no body", async () => {
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    const reader = new ByteReader(socket);
    const head = await exchange(
      socket,
      reader,
      "HEAD / HTTP/1.1\r\nHost: api.stub.test\r\n\r\n",
    );
    const next = await exchange(socket, reader, get("/after"));
    socket.destroy();
    expect(head?.status).toBe(200);
    expect(head?.headers).toContainEqual(["Content-Length", "2"]);
    expect(next?.status).toBe(200);
  });
});

describe("upstream trust", () => {
  test("an upstream that the proxy's roots do not trust gets 502 and no value", async () => {
    const strict = createSecretProxy(
      snapshot(),
      { use: () => {} },
      { standIns: { "api.stub.test:443": https.port } },
    );
    const strictPort = await strict.listen(0);
    try {
      const socket = await tlsThrough(strictPort, "api.stub.test", officeCa);
      const response = await exchange(
        socket,
        new ByteReader(socket),
        get("/", [`Authorization: Bearer ${PH_A}`]),
      );
      socket.destroy();
      expect(response?.status).toBe(502);
      expect(https.seen).toHaveLength(0);
    } finally {
      await strict.close();
    }
  });
});

describe("back pressure", () => {
  test("a client that reads nothing holds the upstream back", async () => {
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    // The client never reads: its socket stays paused.
    socket.pause();
    socket.write(
      `GET /big?mb=128 HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\n\r\n`,
    );
    await Bun.sleep(1500);
    const sent = https.counters.bigSent;
    socket.destroy();
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(BACK_PRESSURE_BOUND);
  });

  test("an upstream that reads nothing holds an upload back", async () => {
    const socket = await tlsThrough(port, "api.stub.test", officeCa);
    const total = 128 * 1024 * 1024;
    socket.write(
      `PUT /sink HTTP/1.1\r\nHost: api.stub.test\r\nAuthorization: Bearer ${PH_A}\r\nContent-Length: ${total}\r\n\r\n`,
    );
    // Write as fast as the proxy takes it, for 1.5 s.
    const piece = Buffer.alloc(64 * 1024, 0x62);
    let taken = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && taken < total) {
      const fits = socket.write(piece);
      taken += piece.length;
      if (!fits)
        await Promise.race([
          new Promise((resolve) => socket.once("drain", resolve)),
          Bun.sleep(Math.max(0, deadline - Date.now())),
        ]);
    }
    socket.destroy();
    expect(https.seen.map((s) => s.target)).toEqual(["/sink"]);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(BACK_PRESSURE_BOUND);
  });
});

describe("the upstream name check", () => {
  test("an upstream with a trusted certificate for another name gets 502 and no request", async () => {
    const wrong = await startHttpsStub(["wrong.stub.test"]);
    const strict = createSecretProxy(
      snapshot(),
      { use: () => {} },
      {
        standIns: { "api.stub.test:443": wrong.port },
        upstreamRoots: wrong.ca.certPem,
      },
    );
    const strictPort = await strict.listen(0);
    try {
      const socket = await tlsThrough(strictPort, "api.stub.test", officeCa);
      const response = await exchange(
        socket,
        new ByteReader(socket),
        get("/", [`Authorization: Bearer ${PH_A}`]),
      );
      socket.destroy();
      expect(response?.status).toBe(502);
      expect(wrong.seen).toHaveLength(0);
    } finally {
      await strict.close();
      await wrong.close();
    }
  });
});

describe("short values are not scrubbed", () => {
  test("a value under the floor leaves a response byte-identical; an 8-character value is scrubbed raw and in Basic", async () => {
    const short = "abc";
    const eight = "fake1234";
    const own = createSecretProxy(
      snapshot({
        secrets: [
          {
            ...SECRETS[0],
            name: "SHORT",
            value: short,
            placeholder: "short-placeholder-0000000000",
          },
          {
            ...SECRETS[0],
            name: "EIGHT",
            value: eight,
            placeholder: "eight-placeholder-0000000000",
          },
        ],
      }),
      { use: () => {} },
      {
        standIns: { "api.stub.test:443": https.port },
        upstreamRoots: https.ca.certPem,
      },
    );
    const ownPort = await own.listen(0);
    const fetchVia = async (path: string) => {
      const socket = await tlsThrough(ownPort, "api.stub.test", officeCa);
      const response = await exchange(
        socket,
        new ByteReader(socket),
        get(path),
      );
      socket.destroy();
      return response;
    };
    try {
      const shortResponse = await fetchVia(`/reflect?v=${short}`);
      expect(shortResponse?.body).toBe(
        [
          `raw=${short}`,
          `url=${short}`,
          `basic=${Buffer.from(`user:${short}`).toString("base64")}`,
          `b64=${Buffer.from(short).toString("base64")}`,
          `hex=${Buffer.from(short).toString("hex")}`,
        ].join("\n"),
      );
      const eightResponse = await fetchVia(`/reflect?v=${eight}`);
      expect(eightResponse?.body).not.toContain(eight);
      expect(eightResponse?.body).not.toContain(
        Buffer.from(`user:${eight}`).toString("base64"),
      );
    } finally {
      await own.close();
    }
  });
});

describe("a company proxy is chained", () => {
  test("a terminated host's TLS goes through it and still verifies; NO_PROXY hosts skip it", async () => {
    const company = await startCompanyProxy({
      "api.stub.test:443": https.port,
      "tunnel.stub.test:443": echo.port,
    });
    const chained = createSecretProxy(
      snapshot({
        upstreamProxy: {
          url: `http://127.0.0.1:${company.port}`,
          noProxy: "localhost,.internal.test",
        },
      }),
      { use: () => {} },
      { upstreamRoots: https.ca.certPem },
    );
    const chainedPort = await chained.listen(0);
    try {
      const socket = await tlsThrough(chainedPort, "api.stub.test", officeCa);
      const response = await exchange(
        socket,
        new ByteReader(socket),
        get("/headers", [`Authorization: Bearer ${PH_A}`]),
      );
      socket.destroy();
      expect(response?.status).toBe(200);
      expect(header("authorization")).toBe(`Bearer ${VALUE_A}`);
      expect(https.seen[0].sni).toBe("api.stub.test");

      const tunnel = await connectThrough(chainedPort, "tunnel.stub.test:443");
      if ("refused" in tunnel) throw new Error("refused");
      tunnel.socket.write("ping");
      expect((await tunnel.reader.read(16))?.toString()).toBe("ping");
      tunnel.socket.destroy();

      // NO_PROXY: no CONNECT to the company proxy; the direct connection
      // fails, as the name does not resolve.
      const direct = await connectThrough(chainedPort, "db.internal.test:443");
      expect("refused" in direct && direct.refused.status).toBe(502);
      expect(company.connects).toEqual([
        "api.stub.test:443",
        "tunnel.stub.test:443",
      ]);
    } finally {
      await chained.close();
      await company.close();
    }
  });
});

describe("updates", () => {
  test("a new snapshot applies on the next request", async () => {
    proxy.update(
      snapshot({
        secrets: SECRETS.map((s) =>
          s.name === "GH_TOKEN"
            ? { ...s, value: "ghp_FAKErotated0000000000000000000000000" }
            : s,
        ),
      }),
    );
    try {
      await request(
        "api.stub.test",
        get("/", [`Authorization: Bearer ${PH_A}`]),
      );
      expect(header("authorization")).toBe(
        "Bearer ghp_FAKErotated0000000000000000000000000",
      );
    } finally {
      proxy.update(snapshot());
    }
  });
});

test("the proxy's log codes never carry a value or a placeholder", () => {
  expect(logs.length).toBeGreaterThan(0);
  const all = logs.join("\n");
  expectNoValue(all);
  for (const placeholder of [PH_A, PH_B, PH_N])
    expect(all).not.toContain(placeholder);
});
