#!/usr/bin/env bun
// The scripted browser transcript for slice 4b: handoff, the access window, and
// the restart.
//
// It drives a REAL browser against a REAL dev server against a REAL provisioner
// holding a REAL box, and prints what it saw. Like 4a's it is not a unit test
// and is deliberately not named like one - `bun test` must not pick it up.
//
// THE INVITE IS NEVER PRINTED. say() redacts anything invite-shaped before it
// reaches the transcript or the terminal, and the checks below assert on the
// LINK'S BEHAVIOUR - that a superseded one is refused by the office itself -
// rather than on its text. A transcript that carries a live credential is a
// transcript nobody can paste into a report.
//
//   export CONTROL_PLANE_DB=...            # the provisioner's database
//   export CONTROL_PLANE_MINT_URL=http://127.0.0.1:4311
//   export CONTROL_PLANE_MINT_TOKEN=...    # the same one the provisioner has
//   export E2E_INSTANCE=inst-...  E2E_OFFICE_NAME=my-office  E2E_EMAIL=...
//   bun run --cwd control-plane/web e2e:handoff

import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = Number(process.env.E2E_PORT ?? 3312);
const BASE = `http://localhost:${PORT}`;
const WEB_DIR = path.join(import.meta.dir, "..");
const CHROME = "/usr/bin/google-chrome";

const transcript: string[] = [];
function say(line: string): void {
  const safe = line
    // An invite is a live capability for somebody's office. Redacted by SHAPE,
    // because the point is to catch material we did not expect to be holding.
    .replace(/https?:\/\/\S*\/(?:i|invite)\/\S+/g, "<invite url redacted>")
    .replace(/sk_(test|live)_[A-Za-z0-9]+/g, "<stripe key redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<credential redacted>");
  transcript.push(safe);
  console.log(safe);
}

function check(label: string, ok: boolean, detail = ""): void {
  say(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
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

async function signInAs(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/signin`);
  await page.fill('[data-testid="dev-email"]', email);
  await page.click('[data-testid="dev-submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
}

async function textOf(page: Page, testid: string): Promise<string> {
  const node = await page.$(`[data-testid="${testid}"]`);
  return node ? ((await node.textContent()) ?? "").trim() : "";
}

/** Wait for a testid to appear, returning its text (or "" if it never does). */
async function waitFor(
  page: Page,
  testid: string,
  timeoutMs = 90_000,
): Promise<string> {
  try {
    await page.waitForSelector(`[data-testid="${testid}"]`, {
      timeout: timeoutMs,
    });
  } catch {
    return "";
  }
  return textOf(page, testid);
}

/**
 * Ask the page for the invite and read the href out of the DOM.
 *
 * The value is returned to the caller and never printed. What the transcript
 * records is that a link EXISTED and what happened when it was used.
 */
async function collectInvite(page: Page): Promise<string> {
  await page.click('[data-testid="invite-button"]');
  const shown = await waitFor(page, "invite-link");
  if (!shown) return "";
  const href = await page.getAttribute('[data-testid="invite-link"]', "href");
  return href ?? "";
}

async function main(): Promise<void> {
  const db = process.env.CONTROL_PLANE_DB;
  const instanceId = process.env.E2E_INSTANCE;
  const officeName = process.env.E2E_OFFICE_NAME;
  const email = process.env.E2E_EMAIL;
  const mintUrl = process.env.CONTROL_PLANE_MINT_URL;
  const mintToken = process.env.CONTROL_PLANE_MINT_TOKEN;
  if (!db || !instanceId || !officeName || !email || !mintUrl || !mintToken) {
    throw new Error(
      "CONTROL_PLANE_DB, E2E_INSTANCE, E2E_OFFICE_NAME, E2E_EMAIL, " +
        "CONTROL_PLANE_MINT_URL and CONTROL_PLANE_MINT_TOKEN are all required",
    );
  }

  say("# slice 4b browser transcript: handoff, the access window, the restart");
  say(`database: ${db}`);
  say(`instance: ${instanceId}`);

  const server = Bun.spawn(
    ["bun", "--bun", "node_modules/.bin/next", "dev", "-p", String(PORT)],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        CONTROL_PLANE_DB: db,
        CONTROL_PLANE_DEV_AUTH: "1",
        NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH: "1",
        AUTH_SECRET: process.env.AUTH_SECRET ?? "slice-4b-transcript-secret",
        AUTH_URL: BASE,
        NEXTAUTH_URL: BASE,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let browser: Browser | null = null;
  try {
    await waitForServer(`${BASE}/signin`);
    say("dev server is up");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await signInAs(page, email);
    await page.goto(`${BASE}/office/${officeName}`);

    // ---- 1. the office is live, and NOTHING has minted on its own
    const status = await waitFor(page, "office-status");
    say(`status: ${status}`);
    check("the office is serving", status.includes("ready"));
    const beforeAsking = await textOf(page, "handoff");
    check(
      "no invite exists before the customer asks for one",
      !beforeAsking.includes("Open your office and sign in"),
    );
    say(`access: ${await textOf(page, "access-window")}`);
    say(`nag: ${await textOf(page, "handoff-nag")}`);
    check(
      "the nag is shown while our key is held",
      !!(await textOf(page, "handoff-nag")),
    );

    // ---- 2. the customer asks, and the link is shown once
    const first = await collectInvite(page);
    check("an invite was shown to the owner session", first.length > 0);
    say(`invite (redacted): ${first}`);

    // A reload must not show it again: the provisioner dropped it when this
    // page collected it, and nothing on our side kept a copy.
    await page.reload();
    await waitFor(page, "handoff", 30_000);
    check(
      "a reload does not show the link again",
      !(await textOf(page, "handoff")).includes("Open your office and sign in"),
    );

    // ---- 3. a resend re-mints, and the previous link is dead
    const second = await collectInvite(page);
    check("a resend produced a link", second.length > 0);
    check("the resent link is not the previous one", second !== first);

    // The proof is the OFFICE's answer, not our bookkeeping: a superseded
    // invite must be refused by the box that issued it.
    const oldLink = await fetch(first, { redirect: "manual" });
    const oldBody = await oldLink.text().catch(() => "");
    say(`the superseded link answers HTTP ${oldLink.status}`);
    check(
      "the superseded invite no longer works",
      oldLink.status >= 400 || /invalid|expired|not found|used/i.test(oldBody),
      `status ${oldLink.status}`,
    );

    // ---- 4. the restart, with its caveat, and the liveness dip it causes
    say(`restart caveat: ${await textOf(page, "restart-caveat")}`);
    say(`liveness before: ${await textOf(page, "liveness")}`);
    await page.click('[data-testid="restart-button"]');
    await page.waitForTimeout(4_000);
    const restarting = await page.getAttribute(
      '[data-testid="restart-button"]',
      "disabled",
    );
    check(
      "a second restart cannot be fired while one is active",
      restarting !== null,
    );

    // Sample the ladder while the box goes down and comes back. Reloading each
    // time rather than trusting the poll cadence: once the restart operation is
    // terminal the page slows down, and the dip is exactly what we came to see.
    const readings: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(10_000);
      await page.reload();
      await waitFor(page, "handoff", 30_000);
      const reading = await textOf(page, "liveness");
      if (reading && reading !== readings[readings.length - 1]) {
        readings.push(reading);
        say(`liveness t+${(i + 1) * 10}s: ${reading}`);
      }
      if (readings.length > 1 && reading.includes("Checked just now")) break;
    }
    check(
      "liveness dipped while the server restarted",
      readings.some((r) => !r.includes("Checked just now")),
      `${readings.length} distinct readings`,
    );
    check(
      "and recovered afterwards",
      readings[readings.length - 1]?.includes("Checked just now") ?? false,
    );

    // ---- 5. the customer confirms, and our access goes
    await page.click('[data-testid="revoke-button"]');
    const revocation = await waitFor(page, "revocation-state", 180_000);
    say(`revocation: ${revocation}`);
    check("the revocation is reported", revocation.length > 0);

    const proven = await (async () => {
      const deadline = Date.now() + 300_000;
      for (;;) {
        const text = await textOf(page, "access-window");
        if (text.includes("no longer has a key")) return text;
        if (Date.now() > deadline) return text;
        await page.waitForTimeout(5_000);
        await page.reload();
        await waitFor(page, "handoff", 30_000);
      }
    })();
    say(`access after revocation: ${proven}`);
    check(
      "the page says our key is gone, on proof",
      proven.includes("no longer has a key"),
    );

    // ---- 6. minting is over, and the page says so plainly
    const closed = await textOf(page, "invite-closed");
    say(`closed-window copy: ${closed}`);
    check("the page says it can no longer create invites", closed.length > 0);
    check(
      "and the button is gone rather than shown and broken",
      !(await page.$('[data-testid="invite-button"]')),
    );

    // The seam refuses too, not just the button: a caller with the credential
    // and an operation id still gets nothing after the window closes.
    const direct = await fetch(new URL("/internal/invite", mintUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountId: "unknown",
        instanceId,
        operationId: "op-mint_invite-0",
      }),
    });
    const body = (await direct.json()) as { status?: string };
    say(`seam answer for a stranger: ${body.status}`);
    check(
      "the seam refuses an account that does not own it",
      body.status === "forbidden",
    );
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  say("");
  say(`# ${transcript.length} lines, no invite material above`);
}

await main();
