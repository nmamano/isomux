// A handler that throws answers without Bun's development error page, which
// shows the cwd, frame paths and source lines to an unauthenticated caller
// (task 8f6b0ce4). Bun turns the page on unless NODE_ENV is production, and no
// shipped unit, image or compose file sets it, so each listener opts out.
// The container entry's setup listener is in deploy/container/office-entry.test.ts.
//
// Each listener runs in a child process: bun test fails the test that owns a
// Bun.serve whose handler throws, whatever the server answers.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { startTestServer } from "./harness.ts";
import { expectNoErrorPage, sendBadHost } from "./bad-host.ts";

const ROOT = join(import.meta.dir, "..", "..");
let child: Subprocess | null = null;
let home = "";

afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
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

// Start a listener with `code` in a child, which prints a line once it listens.
async function startChild(code: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "ignore",
  });
  child = proc;
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(first.done).toBe(false);
}

test("the office runs out of development mode", async () => {
  // Checked on the server itself as well as through a request, because a
  // malformed Host stops throwing once task 66c3a09f lands.
  const office = await startTestServer();
  try {
    expect(office.server.development).toBe(false);
  } finally {
    await office.stop();
  }
});

test("the office answers a throwing request without the error page", async () => {
  home = mkdtempSync(join(tmpdir(), "isomux-production-errors-"));
  const port = await freePort();
  child = Bun.spawn([process.execPath, join(ROOT, "server/isomux-office.ts")], {
    env: {
      ...process.env,
      HOME: home,
      ISOMUX_HOME: home,
      ISOMUX_BACKUP_DIR: home,
      XDG_CONFIG_HOME: home,
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await Bun.sleep(50);
  }
  expect(up).toBe(true);
  expectNoErrorPage(await sendBadHost(port));
}, 15_000);

test("the provisioner seam answers a throwing request without the error page", async () => {
  const port = await freePort();
  // The URL parse comes before any store or hold access.
  await startChild(`
    const { startMintSeam } = await import("./control-plane/mint-seam.ts");
    startMintSeam({ store: {}, hold: {}, token: "t".repeat(40), port: ${port} });
    console.log("listening");
  `);
  expectNoErrorPage(await sendBadHost(port));
});

test("the Stripe webhook server answers a throwing request without the error page", async () => {
  const port = await freePort();
  await startChild(`
    const { serveWebhooks } = await import("./control-plane/stripe/server.ts");
    serveWebhooks({ processor: {}, port: ${port} });
    console.log("listening");
  `);
  expectNoErrorPage(await sendBadHost(port));
});
