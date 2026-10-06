// The certificate forwarder (forwarder/forwarder.ts): exactly the two office
// calls reach the new provisioner, with the office's bearer and body as sent,
// and nothing else does. Real servers on loopback on both sides.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CERTIFICATE_FORWARDED_HEADER,
  CERTIFICATE_RENEW_PATH,
  CERTIFICATE_STATUS_PATH,
  MAX_CSR_BYTES,
} from "../certificate-service.ts";
import {
  FORWARDED_HEADER,
  MAX_BODY_BYTES,
  RENEW_PATH,
  STATUS_PATH,
  UPSTREAM_TIMEOUT_MS,
  credentialNamesIn,
  parseTarget,
  startForwarder,
} from "./forwarder/forwarder.ts";

const FORWARDER = path.join(import.meta.dir, "forwarder", "forwarder.ts");
const BEARER = "Bearer " + "b".repeat(43);

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

type Upstream = (req: Request) => Response | Promise<Response>;

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A stand-in provisioner that records each call it receives. */
function provisioner(answer: Upstream = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      return answer(req);
    },
  });
  stops.push(() => server.stop(true));
  return { seen, origin: new URL(`http://127.0.0.1:${server.port}`) };
}

function forwarder(
  target: URL,
  timeoutMs?: Parameters<typeof startForwarder>[0]["timeoutMs"],
) {
  const server = startForwarder({
    target,
    port: 0,
    hostname: "127.0.0.1",
    timeoutMs,
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

describe("certificate forwarder", () => {
  test("serves the provisioner's own two paths and marks its calls the way the seam reads them", () => {
    expect(RENEW_PATH).toBe(CERTIFICATE_RENEW_PATH);
    expect(STATUS_PATH).toBe(CERTIFICATE_STATUS_PATH);
    expect(MAX_BODY_BYTES).toBe(MAX_CSR_BYTES + 4096);
    expect(FORWARDED_HEADER).toBe(CERTIFICATE_FORWARDED_HEADER);
  });

  test("passes renew and status through with the bearer and body intact", async () => {
    const up = provisioner((req) =>
      new URL(req.url).pathname === RENEW_PATH
        ? Response.json({ certificate: "PEM" })
        : new Response("ok\n"),
    );
    const base = forwarder(up.origin);
    const csr = JSON.stringify({
      csr: "-----BEGIN CERTIFICATE REQUEST-----\n",
    });
    const renew = await fetch(base + RENEW_PATH, {
      method: "POST",
      headers: {
        authorization: BEARER,
        "content-type": "application/json",
        cookie: "session=1",
        "x-forwarded-for": "203.0.113.9",
      },
      body: csr,
    });
    expect(renew.status).toBe(200);
    expect(await renew.json()).toEqual({ certificate: "PEM" });
    const status = await fetch(base + STATUS_PATH, {
      method: "POST",
      headers: { authorization: BEARER, "content-type": "application/json" },
      body: '{"status":"ok"}',
    });
    expect(status.status).toBe(200);
    expect(await status.text()).toBe("ok\n");

    expect(up.seen.map((s) => [s.method, s.path])).toEqual([
      ["POST", RENEW_PATH],
      ["POST", STATUS_PATH],
    ]);
    expect(up.seen[0].body).toBe(csr);
    expect(up.seen[1].body).toBe('{"status":"ok"}');
    for (const call of up.seen) {
      expect(call.headers.authorization).toBe(BEARER);
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.headers[FORWARDED_HEADER]).toBe("1");
      // Nothing else the office sent is carried.
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers["x-forwarded-for"]).toBeUndefined();
    }
  });

  test("passes the provisioner's refusals back unchanged", async () => {
    const up = provisioner(
      () => new Response("unauthorized\n", { status: 401 }),
    );
    const base = forwarder(up.origin);
    const res = await fetch(base + RENEW_PATH, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized\n");
    // A call with no bearer goes through without one; the provisioner decides.
    expect(up.seen[0].headers.authorization).toBeUndefined();
  });

  test("answers 404 to every other path, method and query, without calling the provisioner", async () => {
    const up = provisioner();
    const base = forwarder(up.origin);
    const refused: Array<[string, string]> = [
      ["GET", RENEW_PATH],
      ["PUT", STATUS_PATH],
      ["POST", RENEW_PATH + "/"],
      ["POST", RENEW_PATH + "?x=1"],
      ["POST", "/internal/certificates"],
      ["POST", "/internal/health"],
      ["GET", "/internal/health"],
      ["POST", "/internal/mint"],
      ["POST", "/stripe/webhook"],
      ["POST", "/"],
    ];
    for (const [method, target] of refused) {
      const res = await fetch(base + target, {
        method,
        headers: { authorization: BEARER },
        body: method === "GET" ? undefined : "{}",
      });
      expect([method, target, res.status]).toEqual([method, target, 404]);
    }
    expect(up.seen).toEqual([]);
  });

  test("refuses an oversized body, declared or streamed", async () => {
    const up = provisioner();
    const base = forwarder(up.origin);
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const declared = await fetch(base + RENEW_PATH, {
      method: "POST",
      body: big,
    });
    expect(declared.status).toBe(413);
    const streamed = await fetch(base + RENEW_PATH, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 10; i++)
            controller.enqueue(new TextEncoder().encode(big.slice(0, 8192)));
          controller.close();
        },
      }),
    });
    expect(streamed.status).toBe(413);
    // The largest body the seam accepts still goes through.
    const fits = await fetch(base + RENEW_PATH, {
      method: "POST",
      body: big.slice(1),
    });
    expect(fits.status).toBe(200);
    expect(up.seen.map((s) => s.body.length)).toEqual([MAX_BODY_BYTES]);
  });

  test("leaves a reused connection clean after a refused streamed body", async () => {
    // Bun's fetch keeps the connection alive, as a proxy in front would. An
    // unread chunked body would turn into a bad next request on it.
    const up = provisioner();
    const base = forwarder(up.origin);
    const chunked = (bytes: number) =>
      new ReadableStream({
        start(controller) {
          for (let sent = 0; sent < bytes; sent += 8192)
            controller.enqueue(new TextEncoder().encode("y".repeat(8192)));
          controller.close();
        },
      });
    for (const [target, bytes, status] of [
      ["/stripe/webhook", 32_768, 404],
      [RENEW_PATH, MAX_BODY_BYTES + 8192, 413],
    ] as const) {
      const refused = await fetch(base + target, {
        method: "POST",
        body: chunked(bytes),
      });
      expect(refused.status).toBe(status);
      const next = await fetch(base + STATUS_PATH, {
        method: "POST",
        body: '{"status":"ok"}',
      });
      expect(next.status).toBe(200);
    }
    expect(up.seen.map((s) => s.body)).toEqual([
      '{"status":"ok"}',
      '{"status":"ok"}',
    ]);
  });

  test("answers a retryable error when the provisioner is down", async () => {
    // A port nothing listens on: bind one, read its number, stop it.
    const gone = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    const origin = new URL(`http://127.0.0.1:${gone.port}`);
    await gone.stop(true);
    const base = forwarder(origin);
    const res = await fetch(base + RENEW_PATH, { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  test("answers a retryable error when the provisioner outlasts the bound", async () => {
    const up = provisioner(async () => {
      await Bun.sleep(2_000);
      return new Response("late\n");
    });
    const base = forwarder(up.origin, { [STATUS_PATH]: 200 });
    const res = await fetch(base + STATUS_PATH, { method: "POST", body: "{}" });
    expect(res.status).toBe(504);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  test("does not follow a redirect", async () => {
    const elsewhere = provisioner();
    const up = provisioner(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: elsewhere.origin.href + RENEW_PATH.slice(1) },
        }),
    );
    const base = forwarder(up.origin);
    const res = await fetch(base + RENEW_PATH, {
      method: "POST",
      headers: { authorization: BEARER },
      body: "{}",
      redirect: "manual",
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
    expect(elsewhere.seen).toEqual([]);
  });

  test("holds a renewal open past Bun's default idle timers, with real curl", async () => {
    // Bun.serve's default idleTimeout is 10 s. A renewal waits on DNS
    // propagation for longer, so the bound that ends it must be ours: the
    // office's curl, the forwarder and the provisioner all keep the call open.
    const up = provisioner(async () => {
      await Bun.sleep(12_000);
      return Response.json({ certificate: "PEM" });
    });
    const base = forwarder(up.origin);
    const curl = Bun.spawn(
      [
        "curl",
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "60",
        "-H",
        `Authorization: ${BEARER}`,
        "--data-binary",
        "{}",
        base + RENEW_PATH,
      ],
      { stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(curl.stdout).text(),
      new Response(curl.stderr).text(),
      curl.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ certificate: "PEM" });
  }, 30_000);

  // Bun's fetch has its own 300 s limit. The proof that the forwarder holds a
  // call past it takes over five minutes, so it is a script, not a test:
  // bun control-plane/deploy/forwarder/long-call-proof.ts

  test("answers a fixed retryable error, and logs nothing, when an answer stalls", async () => {
    // In a child process, so the test sees what Bun itself would print. The
    // provisioner starts its answer, then stalls past the bound.
    const script = `
      import { startForwarder, STATUS_PATH } from ${JSON.stringify(FORWARDER)};
      const up = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode("partial"));
          setTimeout(() => { try { c.close(); } catch {} }, 1000);
        } }));
      } });
      const forward = startForwarder({ target: new URL("http://127.0.0.1:" + up.port),
        port: 0, hostname: "127.0.0.1", timeoutMs: { [STATUS_PATH]: 100 } });
      const r = await fetch("http://127.0.0.1:" + forward.port + STATUS_PATH,
        { method: "POST", body: "{}" });
      const stalled = { status: r.status, retry: r.headers.get("retry-after"), body: await r.text() };
      console.log(JSON.stringify(stalled));
      await forward.stop(true);
      await up.stop(true);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const stalled = JSON.parse(stdout.trim()) as {
      status: number;
      retry: string | null;
      body: string;
    };
    expect(stalled.status).toBe(504);
    expect(stalled.retry).toMatch(/^\d+$/);
    expect(stalled.body).not.toContain("<");
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
  }, 15_000);

  test("bounds each call under the office helper's own limit", () => {
    // The helper's curl --max-time per call, read from the helper itself.
    const helper = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "deploy", "install.sh"),
      "utf8",
    );
    const renewLimit = /--max-time (\d+) \\\n(?:.*\\\n)*?.*"\$endpoint"/.exec(
      helper,
    );
    const statusLimit =
      /report_status\(\) \{\n\s*curl [^\n]*--max-time (\d+)/.exec(helper);
    expect(renewLimit).not.toBeNull();
    expect(statusLimit).not.toBeNull();
    const renewMs = Number(renewLimit![1]) * 1000;
    const statusMs = Number(statusLimit![1]) * 1000;
    // Under the helper's bound, so it gets an answer it retries, and not a
    // generic short proxy timeout that would cut DNS propagation off.
    expect(UPSTREAM_TIMEOUT_MS[RENEW_PATH]).toBeLessThan(renewMs);
    expect(UPSTREAM_TIMEOUT_MS[RENEW_PATH]).toBeGreaterThanOrEqual(
      renewMs - 60_000,
    );
    expect(UPSTREAM_TIMEOUT_MS[STATUS_PATH]).toBeLessThan(statusMs);
    expect(UPSTREAM_TIMEOUT_MS[STATUS_PATH]).toBeGreaterThanOrEqual(
      statusMs - 15_000,
    );
  });
});

describe("certificate forwarder configuration", () => {
  test("takes only an https origin as its target", () => {
    expect(parseTarget("https://provisioner.example.com").origin).toBe(
      "https://provisioner.example.com",
    );
    expect(parseTarget("https://provisioner.example.com:8443").port).toBe(
      "8443",
    );
    for (const bad of [
      undefined,
      "",
      "provisioner.example.com",
      "http://provisioner.example.com",
      "https://provisioner.example.com/",
      "https://provisioner.example.com/internal/certificates/renew",
      "https://provisioner.example.com?x=1",
      "https://provisioner.example.com#x",
      "https://user:pass@provisioner.example.com",
      "https://user@provisioner.example.com",
      " https://provisioner.example.com",
    ]) {
      expect(() => parseTarget(bad)).toThrow();
    }
  });

  test("names every provisioner credential in its environment", () => {
    expect(
      credentialNamesIn({
        PATH: "/usr/bin",
        HOME: "/home/bun",
        FLY_APP_NAME: "x",
        FLY_MACHINE_ID: "x",
        ISOMUX_FORWARD_TO: "https://p.example",
        PORT: "8080",
      }),
    ).toEqual([]);
    expect(
      credentialNamesIn({
        CONTROL_PLANE_DB: "x",
        CONTROL_PLANE_DB_IDENTITY: "x",
        CONTROL_PLANE_MINT_TOKEN: "x",
        CONTROL_PLANE_STRIPE_MODE: "x",
        STRIPE_LIVE_SECRET_KEY: "x",
        STRIPE_LIVE_WEBHOOK_SECRET: "x",
        STRIPE_TEST_SECRET_KEY: "x",
        STRIPE_WEBHOOK_SECRET: "x",
        CONTABO_CLIENT_SECRET: "x",
        CONTABO_API_PASSWORD: "x",
        ISOMUX_CF_TOKEN: "x",
        ISOMUX_CF_ZONE_ID: "x",
        ISOMUX_ACME_EMAIL: "x",
        PROBE_CANARY: "x",
      }),
    ).toHaveLength(14);
  });

  /** The forwarder as its image runs it, with `env` as its whole environment. */
  async function run(env: Record<string, string>, stopAfterMs?: number) {
    const proc = Bun.spawn([process.execPath, FORWARDER], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stopAfterMs !== undefined) setTimeout(() => proc.kill(), stopAfterMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  test("refuses to start while it holds a provisioner credential, naming it and not its value", async () => {
    const value = "sk_live_" + "v".repeat(24);
    const result = await run({
      ISOMUX_FORWARD_TO: "https://provisioner.example.com",
      STRIPE_LIVE_SECRET_KEY: value,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("STRIPE_LIVE_SECRET_KEY");
    expect(result.stderr + result.stdout).not.toContain(value);
  });

  test("refuses to start without an https target", async () => {
    const result = await run({
      ISOMUX_FORWARD_TO: "http://provisioner.example.com",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ISOMUX_FORWARD_TO");
  });

  test("logs nothing about the calls it serves", async () => {
    // A free port for the process, and a target nothing answers on.
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    const port = probe.port;
    const closed = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    const deadPort = closed.port;
    await probe.stop(true);
    await closed.stop(true);
    const proc = Bun.spawn([process.execPath, FORWARDER], {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(port),
        ISOMUX_FORWARD_TO: `https://127.0.0.1:${deadPort}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${port}/`)
          .then(() => true)
          .catch(() => false);
        if (!up) await Bun.sleep(50);
      }
      expect(up).toBe(true);
      const calls = [
        fetch(`http://127.0.0.1:${port}${RENEW_PATH}`, {
          method: "POST",
          headers: { authorization: BEARER },
          body: '{"csr":"REQUEST-BODY"}',
        }),
        fetch(`http://127.0.0.1:${port}/internal/health`),
      ];
      const [renew, other] = await Promise.all(calls);
      expect(renew.status).toBe(503);
      expect(other.status).toBe(404);
    } finally {
      proc.kill();
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // One startup line, and no trace of the calls.
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toBe("");
    for (const fragment of ["b".repeat(43), "REQUEST-BODY", "/internal/"])
      expect(stdout).not.toContain(fragment);
  });

  test("image carries the one file and runs it unprivileged", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dir, "forwarder", "Dockerfile"),
      "utf8",
    );
    const lines = dockerfile.split("\n").filter((l) => !l.startsWith("#"));
    expect(lines.filter((l) => /^(COPY|ADD)\b/.test(l))).toEqual([
      "COPY control-plane/deploy/forwarder/forwarder.ts ./forwarder.ts",
    ]);
    expect(lines).toContain("USER bun");
    expect(lines.some((l) => /^(VOLUME|RUN)\b/.test(l))).toBe(false);
    // Nothing from the rest of the repository is imported into it.
    const source = fs.readFileSync(FORWARDER, "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
