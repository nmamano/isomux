import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  THROWING_HANDLER_PRELOAD,
  expectMalformedHostsRefused,
  expectNoErrorPage,
  sendThrowing,
} from "../../server/test-support/bad-host.ts";

// Every container deployment sits behind a load balancer
// (internal-docs/proxy-trust-design.md). The entry script is run as the image
// runs it, and stopped before an owner exists, so the office never boots.
const ENTRY = new URL("./office.ts", import.meta.url).pathname;
const ORIGIN = "https://office.example.com";
let entry: Subprocess | null = null;
let home = "";

afterEach(() => {
  entry?.kill("SIGKILL");
  entry = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The load balancer's address: a peer that is not loopback.
function boxAddress(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal) return a.address;
  throw new Error("this test needs a non-loopback IPv4 interface");
}

// Run the entry as the image runs it, and wait for its setup listener. The
// preload only adds a request that throws (sendThrowing).
async function startEntry(): Promise<number> {
  home = mkdtempSync(join(tmpdir(), "isomux-office-entry-"));
  const port = await freePort();
  entry = Bun.spawn(
    [process.execPath, "--preload", THROWING_HANDLER_PRELOAD, ENTRY],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ISOMUX_HOME: join(home, ".isomux"),
        ISOMUX_PUBLIC_URL: ORIGIN,
        // Per run: the unclaimed office listens on every interface.
        ISOMUX_SETUP_KEY: crypto.randomUUID() + crypto.randomUUID(),
        PORT: String(port),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await Bun.sleep(50);
  }
  expect(up).toBe(true);
  return port;
}

test("the container entry trusts its load balancer for the office and the setup form", async () => {
  const port = await startEntry();

  // The office reads this at boot.
  const config = JSON.parse(
    readFileSync(join(home, ".isomux", "office-config.json"), "utf8"),
  );
  expect(config).toMatchObject({
    trustedProxy: "load-balancer",
    networkBind: "all",
  });

  // The setup form keys its attempt limit on the client the load balancer
  // names, not on the load balancer.
  const post = (client: string) =>
    fetch(`http://${boxAddress()}:${port}/setup`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": client,
      },
      body: new URLSearchParams({ key: "wrong", name: "Owner" }),
    }).then((r) => r.status);
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) statuses.push(await post("198.51.100.7"));
  expect(new Set(statuses.slice(0, -1))).toEqual(new Set([403]));
  expect(statuses.at(-1)).toBe(429);
  expect(await post("203.0.113.10")).toBe(403);
}, 15_000);

// The setup listener listens on every interface, so a malformed Host gets a
// 400 (task 66c3a09f), and a throwing request does not get Bun's development
// error page (task 8f6b0ce4). One test, because each start runs the entry.
test("the setup listener refuses a malformed Host and answers a throw without the error page", async () => {
  const port = await startEntry();
  await expectMalformedHostsRefused(port, { path: "/health", status: 200 });
  expectNoErrorPage(await sendThrowing(port));
}, 15_000);
