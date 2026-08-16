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
  CUSTOMER_CANCELLATION_REASON,
  LIFECYCLE_REASON,
  RETENTION_MS,
  lifecycleOperationId,
} from "../../lifecycle.ts";
import { setOperator } from "../../operator-admin.ts";
import { accountForDevSignIn, reserveOffice } from "../../signup.ts";
import { Store } from "../../store.ts";
import { releaseTestStores, testDsn } from "../../testing/pg.ts";
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

async function succeed(
  store: Store,
  instanceId: string,
  kind: string,
  id?: string,
  evidence?: object,
): Promise<void> {
  const op = await store.enqueue({
    id: id ?? `op-${kind}-${await store.nextSeq("audit")}`,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    ...(evidence ? { evidence } : {}),
  });
  await store.sqlRun(
    "update operations set status = 'succeeded', version = version + 1 where id = $1",
    [op.id],
  );
}

/** Move the cached Stripe columns the way reconciliation would. Nothing in the
 * app writes these; a webhook does, and this stands in for one. */
async function stripeSays(
  store: Store,
  patch: Record<string, string | number | null>,
): Promise<void> {
  const sets = Object.keys(patch)
    .map((k, i) => `${k} = $${i + 1}`)
    .join(", ");
  await store.sqlRun(`update subscriptions set ${sets} where id = 'sub_e2e'`, [
    ...Object.values(patch),
  ]);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp5-lifecycle-"));
  const db = await testDsn();
  const store = await Store.open(db);
  say("# slice 5 transcript: cancellation copy and the ops floor");
  say(`database: ${store.describe()}`);

  const customer = await accountForDevSignIn(store, "customer@example.com");
  const operator = await accountForDevSignIn(store, "operator@example.com");
  await setOperator(store, {
    email: "operator@example.com",
    on: true,
    actor: "e2e",
  });
  const reserved = await reserveOffice(store, {
    accountId: customer.id,
    officeName: "cp5",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;

  const instance = (await store.getInstance(instanceId))!;
  await store.casInstance(instance.id, instance.version, {
    service_state: "live",
  });
  const asset = (await store.assetForInstance(instanceId))!;
  await store.casAsset(asset.id, asset.version, {
    // Obviously synthetic: nothing in this file may act on a real box.
    provider_id: "999999999",
    ipv4: "203.0.113.10",
    asset_state: "active",
  });
  await succeed(store, instanceId, "verify_https");

  const periodEnd = Date.parse("2027-01-31T09:00:00Z");
  await store.tx(async () => {
    const account = await ensureAccount(store, {
      id: customer.id,
      email: "customer@example.com",
    });
    await insertSubscription(store, {
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
      stdout: "inherit",
      stderr: "inherit",
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
    const office = `${BASE}/office/${reserved.reservation.name}`;

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
    await stripeSays(store, { cancel_at_period_end: 1 });
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
      "S3 states period-end power-off and the retention request",
      scheduled.includes("is powered off when that period ends") &&
        scheduled.includes(
          "We retain the server data for 14 days for manual recovery. After that, we request permanent deletion as soon as the provider permits.",
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

    // ---- S5: the period has ended and power-off is due
    await stripeSays(store, {
      status: "canceled",
      ended_at: periodEnd,
      cancellation_reason: CUSTOMER_CANCELLATION_REASON,
    });
    await page.goto(office);
    const grace = await waitFor(page, "cancel-power-off");
    say(`S5: ${grace}`);
    check(
      "S5 says the office is being powered off",
      grace ===
        "Your subscription ended on 2027-01-31. Your office is being powered off. Contact support by 2027-02-14 if you need manual recovery. After that date, we request permanent deletion as soon as the provider permits.",
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

    // ---- S6: powered off, inside the 14-day retention window
    const poweredOffAt = periodEnd;
    await succeed(
      store,
      instanceId,
      "power_off",
      lifecycleOperationId("power_off", "sub_e2e", periodEnd),
      { reason: LIFECYCLE_REASON, poweredOffAt },
    );
    await page.goto(office);
    const suspended = await waitFor(page, "cancel-suspended");
    const retention = new Date(periodEnd + RETENTION_MS)
      .toISOString()
      .slice(0, 10);
    say(`S6: ${suspended}`);
    check(
      "S6 names the retention deadline and says we REQUEST deletion",
      suspended ===
        `Your office is powered off. Contact support by ${retention} if you need manual recovery. After that date, we request permanent deletion as soon as the provider permits.`,
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
    check(
      "S6 offers reinstatement of the retained office",
      (await page.$('[data-testid="reinstate-button"]')) !== null,
    );

    // ---- S7: Checkout was accepted before the hard boundary. The customer
    // sees the exact remaining deadline; this does not claim when a later
    // operator-driven lifecycle tick will run.
    await store.sqlRun(
      "insert into reinstatement_attempts " +
        "(id, account_id, reservation_id, instance_id, closed_subscription_id, closed_ended_at, " +
        "checkout_generation, accepted_at, fence_expires_at, stripe_expires_at, state, version, created_at, updated_at) " +
        "values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'pending',1,$7,$7)",
      [
        "reinstate-sub_e2e",
        customer.id,
        reserved.reservation.id,
        instanceId,
        "sub_e2e",
        periodEnd,
        Date.now(),
        periodEnd + RETENTION_MS,
        Date.now() + 30 * 60_000,
      ],
    );
    await page.goto(office);
    const pendingReinstatement = await waitFor(page, "reinstate-pending");
    say(`S7: ${pendingReinstatement}`);
    check(
      "S7 says the same retained office stays off until payment and gives the exact boundary",
      pendingReinstatement ===
        "Your office remains powered off while payment is pending. Complete payment before 2027-02-14T09:00:00Z to reinstate this same office.",
      pendingReinstatement,
    );
    check(
      "S7 does not offer a second Checkout while one is pending",
      (await page.$('[data-testid="reinstate-button"]')) === null,
    );

    // ---- the ops floor. A real raised attention from the DNS rung.
    await raiseAttention(store, {
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
        (await store.openReasons(instanceId)).length === 1,
    );
    check(
      "and it wrote an audit row",
      (await store.auditEvents()).some(
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
    await store.close();
    await releaseTestStores();
  }
}

await main();
