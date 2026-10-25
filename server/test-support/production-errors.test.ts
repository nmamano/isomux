// Two contracts for every shipped Bun listener that faces a network.
//
// A request whose URL does not parse (a malformed Host, or HTTP/1.0 with no
// Host) gets a 400 and does not throw (task 66c3a09f). These run in process:
// bun test fails the test that owns a Bun.serve whose handler throws, whatever
// the server answers, so a throw is a red run here as well as a 500.
//
// A handler that throws answers without Bun's development error page, which
// shows the cwd, frame paths and source lines to an unauthenticated caller
// (task 8f6b0ce4). Bun turns the page on unless NODE_ENV is production, and no
// shipped unit, image or compose file sets it, so each listener opts out.
// These run each listener in a child with THROWING_HANDLER_PRELOAD.
//
// The container entry's setup listener is in deploy/container/office-entry.test.ts.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { startTestServer } from "./harness.ts";
import {
  THROWING_HANDLER_PRELOAD,
  expectMalformedHostsRefused,
  expectNoErrorPage,
  sendThrowing,
} from "./bad-host.ts";
import {
  MINT_SEAM_PATH,
  startMintSeam,
} from "../../control-plane/mint-seam.ts";
import { serveWebhooks } from "../../control-plane/stripe/server.ts";

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
  const proc = Bun.spawn(
    [process.execPath, "--preload", THROWING_HANDLER_PRELOAD, "-e", code],
    {
      cwd: ROOT,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  child = proc;
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(first.done).toBe(false);
}

test("the office answers a malformed Host with 400", async () => {
  const office = await startTestServer();
  try {
    const answers = await expectMalformedHostsRefused(office.port, {
      path: "/readyz",
      status: 200,
    });
    // An office answer like every other: the security headers are on it.
    for (const answer of answers)
      expect(answer.headers["content-security-policy"]).toBeTruthy();
  } finally {
    await office.stop();
  }
});

test("the provisioner seam answers a malformed Host with 400", async () => {
  // The URL parse comes before any store or hold access.
  const seam = startMintSeam({
    store: {} as never,
    hold: {} as never,
    token: "t".repeat(40),
    port: 0,
  });
  try {
    await expectMalformedHostsRefused(seam.port, {
      path: MINT_SEAM_PATH,
      status: 405,
    });
  } finally {
    await seam.stop();
  }
});

test("the Stripe webhook server answers a malformed Host with 400", async () => {
  const stripe = serveWebhooks({ processor: {} as never, port: 0 });
  try {
    await expectMalformedHostsRefused(stripe.port, {
      path: "/healthz",
      status: 200,
    });
  } finally {
    await stripe.stop();
  }
});

test("the office answers a throwing request without the error page", async () => {
  home = mkdtempSync(join(tmpdir(), "isomux-production-errors-"));
  const port = await freePort();
  child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      THROWING_HANDLER_PRELOAD,
      join(ROOT, "server/isomux-office.ts"),
    ],
    {
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
    },
  );
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await Bun.sleep(50);
  }
  expect(up).toBe(true);
  expectNoErrorPage(await sendThrowing(port));
}, 15_000);

test("the provisioner seam answers a throwing request without the error page", async () => {
  const port = await freePort();
  await startChild(`
    const { startMintSeam } = await import("./control-plane/mint-seam.ts");
    startMintSeam({ store: {}, hold: {}, token: "t".repeat(40), port: ${port} });
    console.log("listening");
  `);
  expectNoErrorPage(await sendThrowing(port));
});

test("the Stripe webhook server answers a throwing request without the error page", async () => {
  const port = await freePort();
  await startChild(`
    const { serveWebhooks } = await import("./control-plane/stripe/server.ts");
    serveWebhooks({ processor: {}, port: ${port} });
    console.log("listening");
  `);
  expectNoErrorPage(await sendThrowing(port));
});
