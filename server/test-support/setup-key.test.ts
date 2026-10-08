// The setup key that claims an unclaimed office (server/setup-key.ts).
//
// Seam: startTestServer() - the real boot path and the real /auth routes. The
// harness resets the key module on each boot, the way a process restart does.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { startTestServer, type TestServer } from "./harness.ts";
import { expectRejection } from "./expect-rejection.ts";
import { hasOwner } from "../users.ts";
import { SETUP_KEY_ENV, setupKeyFile } from "../setup-key.ts";
import { claimWithSetupKey } from "../auth-middleware.ts";
import { translatorForLanguage } from "../i18n.ts";

let server: TestServer | null = null;
afterEach(async () => {
  delete process.env[SETUP_KEY_ENV];
  await server?.stop();
  server = null;
});

const CONFIGURED = "configured-setup-key-with-32-characters";

function claim(srv: TestServer, body: string): Promise<Response> {
  return srv.http("/auth/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body,
    redirect: "manual",
  });
}

const withKey = (key: string) => `name=Owner&key=${encodeURIComponent(key)}`;

describe("an office's own setup key", () => {
  it("is made at the first unclaimed boot, kept 0600, and survives a restart", async () => {
    server = await startTestServer();
    const key = server.setupKey();
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(statSync(setupKeyFile()).mode & 0o777).toBe(0o600);
    server = await server.restart();
    expect(server.setupKey()).toBe(key);
  });

  it("claims the office, and the claim deletes the key file", async () => {
    server = await startTestServer();
    const key = server.setupKey();
    const res = await claim(server, withKey(key));
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("isomux_session=");
    expect(hasOwner()).toBe(true);
    expect(existsSync(setupKeyFile())).toBe(false);
  });

  it("refuses a missing or wrong key with a page that says where the key is", async () => {
    server = await startTestServer();
    for (const body of ["name=Owner", withKey("x".repeat(43))]) {
      const res = await claim(server, body);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(setupKeyFile());
    }
    expect(hasOwner()).toBe(false);
  });

  it("bounds wrong-key attempts per client, the right key included", async () => {
    server = await startTestServer();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await claim(server, withKey("wrong"))).status);
    expect(new Set(statuses.slice(0, -1))).toEqual(new Set([403]));
    expect(statuses.at(-1)).toBe(429);
    expect((await claim(server, withKey(server.setupKey()))).status).toBe(429);
    expect(hasOwner()).toBe(false);
  });

  it("is deleted by a claimed boot that finds one left over", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    expect(existsSync(setupKeyFile())).toBe(true);
    server = await server.restart();
    expect(existsSync(setupKeyFile())).toBe(false);
  });

  it("is printed in the setup link at each unclaimed boot", async () => {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      server = await startTestServer({ startServer: { quiet: false } });
      const link = `/setup#key=${server.setupKey()}`;
      expect(lines.some((line) => line.includes(link))).toBe(true);
      lines.length = 0;
      server = await server.restart();
      expect(lines.some((line) => line.includes(link))).toBe(true);
    } finally {
      console.log = original;
    }
  });
});

describe("a configured setup key", () => {
  it("wins over a key file, and the office writes none", async () => {
    process.env[SETUP_KEY_ENV] = CONFIGURED;
    server = await startTestServer();
    expect(existsSync(setupKeyFile())).toBe(false);
    // Agents the office starts later do not inherit it.
    expect(process.env[SETUP_KEY_ENV]).toBeUndefined();
    writeFileSync(setupKeyFile(), "f".repeat(43));
    expect((await claim(server, withKey("f".repeat(43)))).status).toBe(403);
    expect((await claim(server, withKey(CONFIGURED))).status).toBe(302);
  });

  it("must have at least 32 characters", async () => {
    process.env[SETUP_KEY_ENV] = "short";
    await expectRejection(startTestServer(), new RegExp(SETUP_KEY_ENV));
  });
});

describe("the setup link", () => {
  it("serves the setup form before the claim and the office after it", async () => {
    server = await startTestServer();
    const form = await server.http("/setup", { redirect: "manual" });
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('action="/auth/claim"');
    expect(html).toContain('name="key"');
    await claim(server, withKey(server.setupKey()));
    const after = await server.http("/setup", { redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/");
  });

  it("fills the key from the URL fragment and drops it from the address bar", async () => {
    server = await startTestServer();
    const html = await (await server.http("/setup")).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const input = { value: "" };
    const replaced: unknown[][] = [];
    runInNewContext(scripts[0][1], {
      location: { hash: "#key=a%2Bb-c_d", pathname: "/setup" },
      document: {
        querySelector: (selector: string) =>
          selector === 'input[name="key"]' ? input : null,
      },
      history: { replaceState: (...args: unknown[]) => replaced.push(args) },
    });
    expect(input.value).toBe("a+b-c_d");
    expect(replaced).toEqual([[null, "", "/setup"]]);
  });
});

describe("the claim form body", () => {
  // A form streamed with no Content-Length, 1 KiB per pull, up to 1 MiB.
  function stream(): { body: ReadableStream<Uint8Array>; sent: () => number; cancelled: () => boolean } {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= 1024 * 1024) return controller.close();
          sent += 1024;
          controller.enqueue(new Uint8Array(1024).fill(120));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { body, sent: () => sent, cancelled: () => cancelled };
  }

  const claimFrom = (client: string, body: ReadableStream<Uint8Array>) =>
    claimWithSetupKey(
      new Request("http://localhost/auth/claim", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        // @ts-expect-error - Bun accepts duplex for a streamed request body.
        duplex: "half",
      }),
      {
        client,
        i18n: translatorForLanguage("en"),
        officeName: null,
        keyHelp: "configured",
        keyMatches: () => true,
        claim: async () => ({ ok: true as const }),
      },
    );

  it("stops reading an oversized form at the cap and counts it as a failed attempt", async () => {
    const big = stream();
    const res = await claimFrom("oversized-client", big.body);
    expect(res instanceof Response && res.status).toBe(413);
    expect(big.cancelled()).toBe(true);
    expect(big.sent()).toBeLessThanOrEqual(8 * 1024);
    for (let i = 1; i < 20; i++) await claimFrom("oversized-client", stream().body);
    // The client is out of attempts, even with a key that matches.
    const next = await claimFrom("oversized-client", new Response("key=k").body!);
    expect(next instanceof Response && next.status).toBe(429);
  });
});
