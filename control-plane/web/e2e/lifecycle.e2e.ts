#!/usr/bin/env bun
// The cancellation surface and the ops floor, in a real browser.
//
// WHAT IS REAL: the store, the signup rows, the projection, lifecycle.ts's own
// arithmetic, ops.ts with its in-service authority check, the Next app, the
// routes, and a real Chrome. WHAT IS SEEDED: the subscription rows, because
// walking a customer from cancellation to deletion at Stripe's pace would take
// five weeks and prove nothing this does not.
//
// The Stripe leg is exercised separately and for real, by
// `exercises/cancel-live.ts`, which drives cancel.ts against the live test-mode
// API. This file is about what the CUSTOMER READS at each state, and about the
// operator page - including the 404 a non-operator gets, which is the only
// evidence that "refusal is indistinguishable from absence" is true in the
// running app rather than only in a unit test.
//
//   bun run --cwd control-plane/web e2e:lifecycle

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { raiseAttention } from "../../attention.ts";
import {
  addUtcMonth,
  CUSTOMER_CANCELLATION_REASON,
  GRACE_MS,
  LIFECYCLE_REASON,
  lifecycleOperationId,
} from "../../lifecycle.ts";
import { setOperator } from "../../operator-admin.ts";
import { accountForDevSignIn, reserveOffice } from "../../signup.ts";
import { Store } from "../../store.ts";
import {
  ensureAccount,
  insertSubscription,
} from "../../stripe/billing-store.ts";

const PORT = Number(process.env.E2E_PORT ?? 3315);
const BASE = `http://localhost:${PORT}`;
const WEB_DIR = path.join(import.meta.dir, "..");
const CHROME = "/usr/bin/google-chrome";

const transcript: string[] = [];
function say(line: string): void {
  transcript.push(line);
  console.log(line);
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

async function textOf(page: Page, testid: string): Promise<string> {
  const node = await page.$(`[data-testid="${testid}"]`);
  return node
    ? ((await node.textContent()) ?? "").replace(/\s+/g, " ").trim()
    : "";
}

async function waitFor(
  page: Page,
  testid: string,
  ms = 30_000,
): Promise<string> {
  try {
    await page.waitForSelector(`[data-testid="${testid}"]`, { timeout: ms });
  } catch {
    return "";
  }
  return textOf(page, testid);
}

function succeed(
  store: Store,
  instanceId: string,
  kind: string,
  id?: string,
  evidence?: object,
): void {
  const op = store.enqueue({
    id: id ?? `op-${kind}-${store.nextSeq("audit")}`,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    ...(evidence ? { evidence } : {}),
  });
  store.db.run(
    "update operations set status = 'succeeded', version = version + 1 where id = ?",
    [op.id],
  );
}

/** Move the cached Stripe columns the way reconciliation would. Nothing in the
 * app writes these; a webhook does, and this stands in for one. */
function stripeSays(
  store: Store,
  patch: Record<string, string | number | null>,
): void {
  const sets = Object.keys(patch)
    .map((k) => `${k} = ?`)
    .join(", ");
  store.db.run(`update subscriptions set ${sets} where id = 'sub_e2e'`, [
    ...Object.values(patch),
  ]);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp5-lifecycle-"));
  const db = path.join(dir, "control-plane.db");
  const store = new Store(db);
  say("# slice 5 transcript: cancellation copy and the ops floor");
  say(`database: ${db}`);

  const customer = accountForDevSignIn(store, "customer@example.com");
  const operator = accountForDevSignIn(store, "operator@example.com");
  setOperator(store, {
    email: "operator@example.com",
    on: true,
    actor: "e2e",
  });
  const reserved = reserveOffice(store, {
    accountId: customer.id,
    officeName: "cp5",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;

  const instance = store.getInstance(instanceId)!;
  store.casInstance(instance.id, instance.version, { service_state: "live" });
  const asset = store.assetForInstance(instanceId)!;
  store.casAsset(asset.id, asset.version, {
    // Obviously synthetic: nothing in this file may act on a real box.
    provider_id: "999999999",
    ipv4: "203.0.113.10",
    asset_state: "active",
  });
  succeed(store, instanceId, "verify_https");

  const periodEnd = Date.parse("2027-01-31T09:00:00Z");
  store.tx(() => {
    const account = ensureAccount(store, {
      id: customer.id,
      email: "customer@example.com",
    });
    insertSubscription(store, {
      id: "sub_e2e",
      account_id: account.id,
      instance_id: instanceId,
      stripe_customer_id: "cus_e2e",
      status: "active",
      current_period_end: periodEnd,
      cancel_at_period_end: 0,
      ended_at: null,
      canceled_at: null,
      cancellation_reason: null,
      discount_percent_off: null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: 0,
      latest_invoice_id: null,
      payment_failures: 0,
      exhaustion_observed_at: null,
      coupon_grace_until: null,
      episode_id: null,
      last_event_id: null,
      last_event_created: null,
    });
  });

  const server = Bun.spawn(
    ["bun", "--bun", "node_modules/.bin/next", "dev", "-p", String(PORT)],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        CONTROL_PLANE_DB: db,
        CONTROL_PLANE_DEV_AUTH: "1",
        NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH: "1",
        AUTH_SECRET: "slice-5-lifecycle-secret",
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
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const signIn = async (email: string): Promise<void> => {
      await page.context().clearCookies();
      await page.goto(`${BASE}/signin`);
      await page.fill('[data-testid="dev-email"]', email);
      await page.click('[data-testid="dev-submit"]');
      await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
    };

    await signIn("customer@example.com");
    const office = `${BASE}/office/${instanceId}`;

    // ---- S1: nothing is scheduled
    await page.goto(office);
    await waitFor(page, "cancel-offer");
    say(`S1 caveat: ${await textOf(page, "cancel-caveat")}`);
    check(
      "S1 says cancelling keeps the office to the end of the paid period",
      (await textOf(page, "cancel-caveat")) ===
        "Cancelling keeps your office running until the end of the period you have paid for.",
    );
    const planS1 = await textOf(page, "subscription");
    say(`S1 plan: ${planS1}`);
    check(
      "S1 calls the date a NEXT INVOICE, because there is one",
      planS1 === "office - active, next invoice 2027-01-31",
      planS1,
    );

    // ---- S3: Stripe has confirmed a SCHEDULED cancellation
    stripeSays(store, { cancel_at_period_end: 1 });
    await page.goto(office);
    const scheduled = await waitFor(page, "cancel-scheduled");
    say(`S3: ${scheduled}`);
    check(
      "S3 says SCHEDULED to end, not cancelled",
      scheduled.includes(
        "Your subscription is scheduled to end on 2027-01-31.",
      ) && !scheduled.includes("Your subscription is cancelled"),
    );
    check(
      "S3 states the grace week and what happens after it",
      scheduled.includes("for a further 7 days until 2027-02-07") &&
        scheduled.includes(
          "After 2027-02-07 your server is powered off. Your data stays on it for one calendar month, and then the server is permanently deleted.",
        ),
    );
    check(
      "S3 names NO exact deletion date before the power-off has happened",
      !/permanent deletion on \d{4}-\d{2}-\d{2}/.test(scheduled),
    );
    const planS3 = await textOf(page, "subscription");
    say(`S3 plan: ${planS3}`);
    check(
      "S3 calls the date a PERIOD END, not a next invoice",
      planS3 === "office - active, period ends 2027-01-31",
      planS3,
    );
    say(`S3 keep caveat: ${await textOf(page, "uncancel-caveat")}`);
    check(
      "the keep-office caveat says billing CONTINUES, not restarts",
      (await textOf(page, "uncancel-caveat")).includes(
        "your subscription renews on 2027-01-31 and normal billing continues",
      ),
    );

    // ---- S5: the period has ended and the grace week is running
    stripeSays(store, {
      status: "canceled",
      ended_at: periodEnd,
      cancellation_reason: CUSTOMER_CANCELLATION_REASON,
    });
    await page.goto(office);
    const grace = await waitFor(page, "cancel-grace");
    say(`S5: ${grace}`);
    check(
      "S5 says the office keeps serving through the grace week",
      grace ===
        "Your subscription ended on 2027-01-31. Your office keeps serving until 2027-02-07 so you can take your work out. After that your server is powered off.",
    );
    const planS5 = await textOf(page, "subscription");
    say(`S5 plan: ${planS5}`);
    check(
      "S5 shows NO date at all, because a past next invoice is a lie",
      planS5 === "office - canceled",
      planS5,
    );
    say(`S8: ${await textOf(page, "cancel-restart-refused")}`);
    check(
      "S8 does not offer to bring the office back",
      !(await textOf(page, "cancel-restart-refused")).includes(
        "want your office back",
      ),
    );

    // ---- S6: powered off, inside the retention month
    const poweredOffAt = periodEnd + GRACE_MS;
    succeed(
      store,
      instanceId,
      "power_off",
      lifecycleOperationId("power_off", "sub_e2e", periodEnd),
      { reason: LIFECYCLE_REASON, poweredOffAt },
    );
    await page.goto(office);
    const suspended = await waitFor(page, "cancel-suspended");
    const retention = new Date(addUtcMonth(poweredOffAt))
      .toISOString()
      .slice(0, 10);
    say(`S6: ${suspended}`);
    check(
      "S6 names the retention deadline and says we REQUEST deletion",
      suspended ===
        `Your office is powered off. Your data stays on its server, which we keep until ${retention} - then the server is permanently deleted. Contact support if you need help before deletion.`,
      retention,
    );
    check(
      "S6 does not claim the provider deletes on our date",
      !suspended.includes("the server is deleted on"),
    );
    const planS6 = await textOf(page, "subscription");
    check(
      "S6 still shows no invoice date",
      planS6 === "office - canceled",
      planS6,
    );

    // ---- the ops floor. A real raised attention from the DNS rung.
    raiseAttention(store, {
      instanceId,
      reasonClass: "operation_condition",
      sourceOpId: "op-remove_dns-e2e",
      reason:
        "the DNS record for cp5.test.isomux.app still points at 203.0.113.10 and has to be removed by hand",
      severity: "warning",
    });

    const opsUrl = `${BASE}/ops`;
    const asCustomer = await page.goto(opsUrl);
    say(`ops as a NON-operator: HTTP ${asCustomer?.status()}`);
    check(
      "a non-operator gets 404, not 403",
      asCustomer?.status() === 404,
      String(asCustomer?.status()),
    );

    await signIn("operator@example.com");
    await page.goto(opsUrl);
    const floor = await waitFor(page, "ops-attention");
    say(`ops floor: ${floor}`);
    check(
      "the floor lists the raised reason with its class and severity",
      floor.includes("warning") &&
        floor.includes("operation_condition") &&
        floor.includes("still points at"),
    );

    await page.goto(`${BASE}/ops/${instanceId}`);
    await waitFor(page, "ops-reasons");
    say(`ops ack caveat: ${await textOf(page, "ops-ack-caveat")}`);
    // Capture what the SERVER said, not only what the page did with it: a
    // refused write and a write that landed look identical from the DOM for the
    // moment before the reload.
    const [ackResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/ops/ack")),
      page.click('[data-testid="ops-ack"]'),
    ]);
    // Status only: the page reloads on success, and Chrome discards the body of
    // a response whose page has navigated away.
    say(`ack response: HTTP ${ackResponse.status()}`);
    await page.waitForLoadState("networkidle");
    await waitFor(page, "ops-reasons");
    const acked = await textOf(page, "ops-reasons");
    say(`after acknowledging: ${acked}`);
    check(
      "the acknowledgement is shown as seen, and the reason is STILL open",
      acked.includes("(we have seen it: account:") &&
        store.openReasons(instanceId).length === 1,
    );
    check(
      "and it wrote an audit row",
      store
        .auditEvents()
        .some(
          (e) =>
            e.action === "acknowledge_attention" &&
            e.actor === `account:${operator.id}`,
        ),
    );

    // ---- the operator's own dashboard is unaffected by the flag
    const audit = await textOf(page, "ops-audit");
    check("the audit trail is rendered", audit.length > 0);
  } finally {
    await browser?.close();
    server.kill();
    const out = path.join(dir, "transcript.txt");
    fs.writeFileSync(out, `${transcript.join("\n")}\n`);
    say(`transcript: ${out}`);
    store.close();
  }
}

await main();
