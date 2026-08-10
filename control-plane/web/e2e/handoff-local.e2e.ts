#!/usr/bin/env bun
// The handoff surface, driven in a real browser with the BOX faked.
//
// Its sibling `handoff.e2e.ts` is the real-box driver and stays the primary
// evidence. This one exists because the real box's certificate is subject to
// Let's Encrypt's duplicate-certificate limit (5 per week per name), so the
// dashboard legs cannot always be re-run on demand - and the collection race
// this file pins was found by a real run and must be provable afterwards.
//
// WHAT IS REAL HERE: the store, the signup rows, requests.ts, the projection,
// the invite hold, the mint seam, the Next app and a real Chrome. WHAT IS
// FAKED: the SSH mint (a fake exec returns a distinct URL per call) and the
// revocation (marked succeeded directly, since proving removal needs a box).
// Nothing about the invite's handling is faked - that is the point.
//
//   bun run --cwd control-plane/web e2e:handoff-local

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { boxHandlers } from "../../handlers.ts";
import { InviteHold } from "../../invite-hold.ts";
import { startMintSeam } from "../../mint-seam.ts";
import { Reporter, type Sink } from "../../report.ts";
import { saveRun, type RunRecord } from "../../run-record.ts";
import { accountForDevSignIn, reserveOffice } from "../../signup.ts";
import { Store } from "../../store.ts";
import type { Exec, ExecOptions, ExecResult } from "../../ssh.ts";
import { Ticker } from "../../tick.ts";

const PORT = Number(process.env.E2E_PORT ?? 3313);
const SEAM_PORT = Number(process.env.E2E_SEAM_PORT ?? 4319);
const BASE = `http://localhost:${PORT}`;
const WEB_DIR = path.join(import.meta.dir, "..");
const CHROME = "/usr/bin/google-chrome";
const TOKEN = "local-transcript-credential-0123456789abcdef";

const transcript: string[] = [];
function say(line: string): void {
  const safe = line
    .replace(/https?:\/\/\S*\/(?:i|invite)\/\S+/g, "<invite url redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<credential redacted>");
  transcript.push(safe);
  console.log(safe);
}

function check(label: string, ok: boolean, detail = ""): void {
  say(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/** A different link every time, so "the resend gave me a new one" is provable
 * without printing either. */
let minted = 0;
class FakeMint implements Exec {
  async run(_argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
    minted++;
    return {
      code: 0,
      stdout: `https://cp1.test.isomux.app/i/local-link-${minted}\n`,
      stderr: "",
    };
  }
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} never came up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function textOf(page: Page, testid: string): Promise<string> {
  const node = await page.$(`[data-testid="${testid}"]`);
  return node ? ((await node.textContent()) ?? "").trim() : "";
}

async function waitFor(
  page: Page,
  testid: string,
  ms = 60_000,
): Promise<string> {
  try {
    await page.waitForSelector(`[data-testid="${testid}"]`, { timeout: ms });
  } catch {
    return "";
  }
  return textOf(page, testid);
}

async function collect(page: Page): Promise<string> {
  await page.click('[data-testid="invite-button"]');
  const shown = await waitFor(page, "invite-link");
  if (!shown) return "";
  return (await page.getAttribute('[data-testid="invite-link"]', "href")) ?? "";
}

async function succeed(
  store: Store,
  instanceId: string,
  kind: string,
): Promise<void> {
  const op = await store.enqueue({
    id: `op-${kind}-${await store.nextSeq("audit")}`,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
  });
  const leased = (await store.tryLease(
    op.id,
    op.version,
    "seed",
    0,
    Date.now(),
  ))!;
  await store.casOperation(
    { id: leased.id, version: leased.version, holder: "seed" },
    { status: "succeeded" },
  );
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp4b-local-"));
  const db = path.join(dir, "control-plane.db");
  const store = await Store.open(db);
  say("# slice 4b local transcript: the handoff surface with the box faked");
  say(`database: ${db}`);

  const account = await accountForDevSignIn(store, "local@example.com");
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cp1",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;

  const rec: RunRecord = {
    runId: "run-local",
    state: "reachable",
    host: "cp1.test.isomux.app",
    instanceId: "999999999",
    ipv4: "203.0.113.10",
    loginUser: "root",
    privateKeyPath: path.join(dir, "key"),
    publicKeyPath: path.join(dir, "key.pub"),
    algorithm: "ssh-ed25519",
    blob: "AAAAC3NzaC1lZDI1NTE5AAAAILOCALBLOB",
    knownHostsFile: path.join(dir, "known_hosts"),
  };
  saveRun(dir, rec);
  const instance = (await store.getInstance(instanceId))!;
  await store.casInstance(instance.id, instance.version, {
    run_id: "run-local",
    service_state: "live",
  });
  const asset = (await store.assetForInstance(instanceId))!;
  await store.casAsset(asset.id, asset.version, {
    // An obviously synthetic provider id: nothing in this file may act on a
    // real box, and the seed-instance helper's rule applies here too.
    provider_id: "999999999",
    ipv4: "203.0.113.10",
    asset_state: "active",
  });
  await succeed(store, instanceId, "first_contact");
  await succeed(store, instanceId, "verify_https");

  const hold = new InviteHold();
  const lines: string[] = [];
  const sink: Sink = { out: (l) => lines.push(l), err: (l) => lines.push(l) };
  const reporter = new Reporter(sink);
  const ticker = new Ticker({
    store,
    handlers: boxHandlers({
      exec: new FakeMint(),
      reporter,
      runsDir: dir,
      keysDir: dir,
      deliver: hold,
    }),
    report: (l) => lines.push(l),
  });
  const seam = startMintSeam({ store, hold, token: TOKEN, port: SEAM_PORT });
  // The provisioner's loop, in miniature: the same Ticker the real one runs.
  let ticking = true;
  const loop = (async () => {
    while (ticking) {
      await ticker.once();
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  const server = Bun.spawn(
    ["bun", "--bun", "node_modules/.bin/next", "dev", "-p", String(PORT)],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        CONTROL_PLANE_DB: db,
        CONTROL_PLANE_DEV_AUTH: "1",
        NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH: "1",
        AUTH_SECRET: "slice-4b-local-secret",
        AUTH_URL: BASE,
        NEXTAUTH_URL: BASE,
        CONTROL_PLANE_MINT_URL: `http://127.0.0.1:${seam.port}`,
        CONTROL_PLANE_MINT_TOKEN: TOKEN,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let browser: Browser | null = null;
  try {
    await waitForServer(`${BASE}/signin`);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.goto(`${BASE}/signin`);
    await page.fill('[data-testid="dev-email"]', "local@example.com");
    await page.click('[data-testid="dev-submit"]');
    await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
    await page.goto(`${BASE}/office/${instanceId}`);
    await waitFor(page, "handoff");

    check("nothing minted before the customer asked", minted === 0);
    say(`access: ${await textOf(page, "access-window")}`);
    say(`nag: ${await textOf(page, "handoff-nag")}`);

    const first = await collect(page);
    check("the first invite was shown", first.length > 0);
    check("exactly one mint happened", minted === 1, `${minted}`);

    await page.reload();
    await waitFor(page, "handoff");
    check(
      "a reload does not show it again",
      !(await textOf(page, "handoff")).includes("Open your office and sign in"),
    );

    // THE REGRESSION THIS FILE EXISTS FOR. The resend must collect the link
    // ITS OWN request minted, not the one the projection still describes.
    const second = await collect(page);
    check("the resend was shown a link", second.length > 0);
    check("and it is a different link", !!second && second !== first);
    check("two mints happened in total", minted === 2, `${minted}`);
    say(`resend caveat: ${await textOf(page, "resend-caveat")}`);

    // The seam refuses a second collection of the same one.
    const opId = (await store.operationsFor(instanceId))
      .filter((o) => o.kind === "mint_invite")
      .map((o) => o.id)
      .pop()!;
    const again = await fetch(`http://127.0.0.1:${seam.port}/internal/invite`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountId: account.id,
        instanceId,
        operationId: opId,
      }),
    });
    const body = (await again.json()) as { status?: string };
    say(`collecting the same invite twice: ${body.status}`);
    check(
      "a collected invite cannot be collected again",
      body.status === "expired_or_lost",
    );

    // ---- the window closes
    await succeed(store, instanceId, "revoke_access");
    await page.reload();
    await waitFor(page, "handoff");
    say(`access after revocation: ${await textOf(page, "access-window")}`);
    say(`closed-window copy: ${await textOf(page, "invite-closed")}`);
    check(
      "the page says our key is gone",
      (await textOf(page, "access-window")).includes("no longer has a key"),
    );
    check(
      "the invite button is gone rather than shown and broken",
      !(await page.$('[data-testid="invite-button"]')),
    );
    check(
      "the nag is gone once the handoff is done",
      !(await textOf(page, "handoff-nag")),
    );

    const closed = await fetch(
      `http://127.0.0.1:${seam.port}/internal/invite`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: account.id,
          instanceId,
          operationId: opId,
        }),
      },
    );
    const closedBody = (await closed.json()) as { status?: string };
    say(`seam answer after the window closed: ${closedBody.status}`);
    check(
      "the seam refuses after the window closes",
      closedBody.status === "window_closed",
    );

    // Nothing anywhere durable carries a link.
    const dump = fs.readFileSync(db).toString("latin1");
    check(
      "no invite in the database file",
      !/https?:\/\/\S*\/i\/local-link/.test(dump),
    );
    check(
      "no invite in the provisioner's own output",
      !/local-link/.test(lines.join("\n")),
    );
  } finally {
    ticking = false;
    await loop;
    if (browser) await browser.close();
    server.kill();
    await seam.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  say("");
  say(`# ${transcript.length} lines, no invite material above`);
}

await main();
