#!/usr/bin/env bun
// The billing commands. TEST MODE ONLY.
//
//   bootstrap  create the test product, price and 100%-off coupon
//   checkout   create a Checkout session and print its URL
//   serve      run the local webhook endpoint behind `stripe listen`
//   subs       the cached subscription rows and their dunning episodes
//   events     the durable event ledger (what arrived, and what it did)
//   tick       one pass over expired coupon-lapse holds
//   clock      create / advance / list / delete a test clock
//   cleanup    delete the test clocks and coupons THIS SLICE created, and only
//              those - the test account is shared
//
// Separate from cli.ts deliberately. That file drives real boxes and its most
// important property is an absence - no command in it can reach a paid create -
// and mixing billing commands into it would dilute the audit surface that makes
// that property checkable.
//
// There is also an absence here: the `power_off` handler is NOT registered in this
// process. Billing can REQUEST a suspension - that is the boundary this slice
// builds - but nothing runnable here can power a real box off.

import * as fs from "node:fs";
import { DB_FILE, STATE_ROOT } from "./config.ts";
import { Reporter } from "./report.ts";
import { Store } from "./store.ts";
import {
  casAccount,
  ensureAccount,
  getAccount,
  listEvents,
  listSubscriptions,
} from "./stripe/billing-store.ts";
import { billingTick } from "./stripe/billing-tick.ts";
import { lifecycleTick } from "./lifecycle-tick.ts";
import { StripeClient, type StripeResult } from "./stripe/client.ts";
import { openCheckout } from "./stripe/checkout.ts";
import {
  deleteOwned,
  listAll,
  ownsClock,
  ownsTaggedObject,
  selectOwned,
} from "./stripe/cleanup.ts";
import { LiveStripeReader } from "./stripe/reader.ts";
import { DEFAULT_WEBHOOK_PORT, serveWebhooks } from "./stripe/server.ts";
import {
  TEST_PREFIX,
  advanceTestClock,
  createTestClock,
  deleteTestClock,
  listTestClocks,
} from "./stripe/test-clock.ts";
import { WebhookProcessor } from "./stripe/webhook.ts";

const reporter = new Reporter();

// ---------------------------------------------------------------- arguments

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      out.set(arg.slice(2), next && !next.startsWith("--") ? next : "true");
      if (next && !next.startsWith("--")) i++;
    }
  }
  return out;
}

function required(args: Map<string, string>, name: string): string {
  const v = args.get(name);
  if (!v || v === "true") die(`--${name} is required`);
  return v;
}

function die(message: string): never {
  reporter.problem(`error: ${message}`);
  process.exit(2);
}

/**
 * The test key, from the environment.
 *
 * The path of the file it lives in is the CALLER's business - the same rule the
 * Contabo credentials follow. Nothing here reads a secrets file, and nothing
 * prints, logs or echoes the value.
 */
function makeClient(): StripeClient {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key) {
    die(
      "STRIPE_TEST_SECRET_KEY is not set. Source the test-mode env file in your " +
        "shell first (set -a; . ~/nil/secrets/stripe-test.env; set +a). This " +
        "command refuses live-mode keys.",
    );
  }
  // StripeClient's constructor refuses anything that is not a test key.
  return new StripeClient({ key });
}

/**
 * The durable state, defaulting to the one database the control plane uses.
 *
 * `--db` follows slice 2's exercise convention (`exercises/rerun-leg.ts`): a live
 * billing exercise wants its own store rather than the provisioning box's, and a
 * database written before this slice refuses to open by name anyway - deliberately,
 * since there is no migration.
 */
function openStore(args: Map<string, string>): Store {
  const override = args.get("db");
  if (override && override !== "true") return new Store(override);
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  return new Store(DB_FILE);
}

function newId(prefix: string): string {
  return `${prefix}-${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
}

function okOrDie(res: StripeResult, what: string): Record<string, unknown> {
  if (res.kind !== "ok") die(`${what}: ${res.reason}`);
  return res.body;
}

// ----------------------------------------------------------------- commands

/**
 * The product, price and coupon this slice sells.
 *
 * THE AMOUNT IS NOT A PRICING DECISION. Plans and prices are parked for Nil; this
 * is a deliberately odd test amount with a name that says so, so nothing here can
 * be mistaken for the product's price table.
 */
async function cmdBootstrap(args: Map<string, string>): Promise<void> {
  const client = makeClient();
  const amount = Number(args.get("amount") ?? 100);
  const currency = args.get("currency") ?? "eur";

  const product = okOrDie(
    await client.post(
      "/v1/products",
      {
        name: `${TEST_PREFIX} slice-3 test office (not a real plan)`,
        metadata: { isomux_test: "slice3" },
      },
      `${TEST_PREFIX}-product-1`,
    ),
    "could not create the test product",
  );
  const price = okOrDie(
    await client.post(
      "/v1/prices",
      {
        product: String(product.id),
        currency,
        unit_amount: amount,
        recurring: { interval: "month" },
        nickname: `${TEST_PREFIX} test price - not a product price`,
        metadata: { isomux_test: "slice3" },
      },
      `${TEST_PREFIX}-price-1`,
    ),
    "could not create the test price",
  );
  const coupon = okOrDie(
    await client.post(
      "/v1/coupons",
      {
        percent_off: 100,
        duration: "repeating",
        duration_in_months: 1,
        name: `${TEST_PREFIX} comped one month`,
        metadata: { isomux_test: "slice3" },
      },
      `${TEST_PREFIX}-coupon-1`,
    ),
    "could not create the test coupon",
  );

  reporter.line(`product: ${String(product.id)}`);
  reporter.line(
    `price:   ${String(price.id)} (${amount} ${currency}/month, test only)`,
  );
  reporter.line(`coupon:  ${String(coupon.id)} (100% off, 1 month)`);
}

async function cmdCheckout(args: Map<string, string>): Promise<void> {
  const email = required(args, "email");
  const officeName = required(args, "office-name");
  const priceId = required(args, "price");

  const store = openStore(args);
  try {
    const accountId = store.tx(
      () => ensureAccount(store, { id: newId("acct"), email }).id,
    );
    const client = makeClient();
    // openCheckout owns the ORDER: verify the coupon (read-only) before creating a
    // customer, and check the customer before creating a session, so a refusal
    // anywhere leaves nothing behind.
    const opened = await openCheckout(client, {
      accountId,
      email,
      officeName,
      priceId,
      label: officeName,
      couponId: args.get("coupon") === "true" ? undefined : args.get("coupon"),
      customerId:
        args.get("customer") === "true" ? undefined : args.get("customer"),
      instanceId:
        args.get("instance") === "true" ? undefined : args.get("instance"),
      successUrl:
        args.get("success-url") ??
        "https://cloud.isomux.com/welcome?session={CHECKOUT_SESSION_ID}",
      cancelUrl: args.get("cancel-url") ?? "https://isomux.com/hosted",
      idempotencyKeys: {
        customer: newId("customer"),
        session: newId("checkout"),
      },
    });
    if (!opened.ok) {
      die(`${opened.reason}${opened.retryable ? " (try again)" : ""}`);
    }
    reporter.line(`account:  ${accountId}`);
    reporter.line(`customer: ${opened.customerId}`);
    reporter.line(`session:  ${opened.session.id}`);
    reporter.line(
      `payment_method_collection: ${opened.session.paymentMethodCollection ?? "(not reported)"}`,
    );
    // Printed live, kept out of anything durable: a Checkout URL is a
    // customer-specific link, treated exactly like slice 1 treats an invite.
    if (opened.session.url) reporter.invite(opened.session.url);
  } finally {
    store.close();
  }
}

async function cmdServe(args: Map<string, string>): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    die(
      "STRIPE_WEBHOOK_SECRET is not set. Start `stripe listen --forward-to " +
        `http://localhost:${DEFAULT_WEBHOOK_PORT}/stripe/webhook\` and export the ` +
        "signing secret it prints, without echoing it.",
    );
  }
  const store = openStore(args);
  const client = makeClient();
  const processor = new WebhookProcessor({
    store,
    reader: new LiveStripeReader(client),
    secret,
    report: (line) => reporter.line(line),
  });
  const running = serveWebhooks({
    processor,
    port: Number(args.get("port") ?? DEFAULT_WEBHOOK_PORT),
    report: (line) => reporter.line(line),
    recordDir: args.get("record") === "true" ? undefined : args.get("record"),
  });

  await new Promise<void>((resolve) => {
    const stop = () => {
      reporter.line("stopping the webhook endpoint");
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await running.stop();
  store.close();
}

function cmdSubs(args: Map<string, string>): void {
  const store = openStore(args);
  try {
    const rows = listSubscriptions(store);
    if (rows.length === 0) {
      reporter.line("no cached subscriptions");
      return;
    }
    for (const s of rows) {
      const discount =
        s.discount_percent_off === null
          ? "no discount"
          : `${s.discount_percent_off}% off (${s.discount_coupon_id})`;
      reporter.line(
        `${s.id}  ${s.status}  ${discount}  episode=${s.episode_state}` +
          `${s.episode_id ? `/${s.episode_id}` : ""}  failures=${s.payment_failures}` +
          `${s.exhaustion_observed_at ? "  exhausted" : ""}` +
          `${s.coupon_grace_until ? `  hold-until=${new Date(s.coupon_grace_until).toISOString()}` : ""}` +
          `${s.ever_full_discount ? "  (was comped)" : ""}` +
          `${s.instance_id ? `  instance=${s.instance_id}` : "  no instance"}`,
      );
    }
  } finally {
    store.close();
  }
}

function cmdEvents(args: Map<string, string>): void {
  const store = openStore(args);
  try {
    const rows = listEvents(store, Number(args.get("limit") ?? 25));
    if (rows.length === 0) {
      reporter.line("no events have been applied");
      return;
    }
    for (const e of rows) {
      reporter.line(
        `${new Date(e.received_at).toISOString()}  ${e.type}  ${e.outcome}` +
          `${e.subscription_id ? `  ${e.subscription_id}` : ""}  ${e.detail ?? ""}`,
      );
    }
  } finally {
    store.close();
  }
}

function cmdTick(args: Map<string, string>): void {
  const store = openStore(args);
  try {
    const summary = billingTick(store, store.now(), (line) =>
      reporter.line(line),
    );
    reporter.line(
      `holds examined ${summary.examined}, resumed to the ladder ` +
        `${summary.resumedToLadder}, suspensions requested ` +
        `${summary.suspensionsRequested}, closed ${summary.closed}`,
    );
    // The cancellation timeline rides the same pass. Both are non-webhook
    // billing transitions over the same rows, and running them apart would let
    // an operator run one and believe they had run the machine.
    const life = lifecycleTick(store, store.now(), (line) =>
      reporter.line(line),
    );
    reporter.line(
      `cancellations examined ${life.examined}, operations opened ` +
        `${life.opened}, data ends recorded ${life.finished}, attention raised ` +
        `${life.raised}` +
        (Object.keys(life.phases).length > 0
          ? ` (${Object.entries(life.phases)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")})`
          : ""),
    );
  } finally {
    store.close();
  }
}

async function cmdClock(args: Map<string, string>): Promise<void> {
  const client = makeClient();
  const action = args.get("action") ?? "list";
  if (action === "create") {
    const clock = await createTestClock(
      client,
      {
        label: required(args, "label"),
        frozenTimeSec: Number(args.get("at") ?? Math.floor(Date.now() / 1000)),
      },
      newId("clock"),
    );
    reporter.line(`clock ${clock.id} ${clock.status} at ${clock.frozenTime}`);
    return;
  }
  if (action === "advance") {
    const clock = await advanceTestClock(
      client,
      required(args, "clock"),
      Number(required(args, "to")),
      { idempotencyKey: newId("advance") },
    );
    reporter.line(`clock ${clock.id} ${clock.status} at ${clock.frozenTime}`);
    return;
  }
  if (action === "delete") {
    await deleteTestClock(client, required(args, "clock"));
    reporter.line("deleted, with its customers and subscriptions");
    return;
  }
  for (const clock of await listTestClocks(client)) {
    reporter.line(
      `${clock.id}  ${clock.status}  at ${new Date(clock.frozenTime * 1000).toISOString()}`,
    );
  }
}

/**
 * Delete what THIS SLICE created, and nothing else.
 *
 * The test account is shared - it is the company's real account in test mode - so
 * ownership is proven per object type: a metadata-bearing object must carry our
 * exact `isomux_test=slice3` tag, and only a test clock (which Stripe gives no
 * metadata at all) is identified by its name. Anything unprovable is kept and named.
 *
 * Every delete result is checked. A refused or AMBIGUOUS delete makes the whole
 * cleanup incomplete and exits non-zero, because "we asked" is not "it is gone".
 */
async function cmdCleanup(): Promise<void> {
  const client = makeClient();
  const problems: string[] = [];
  const skipped: { id: string; why: string }[] = [];

  // Clocks first: deleting one takes its customers and subscriptions with it, so
  // the customers pass afterwards has less to do and its 404s are expected.
  const clocks = await listAll(client, "/v1/test_helpers/test_clocks");
  if (!clocks.complete) {
    problems.push(
      `could not list every test clock: ${clocks.reason ?? "unknown"}`,
    );
  }
  const clockPick = selectOwned(
    clocks.objects.map((o) => ({
      id: typeof o.id === "string" ? o.id : "",
      name: typeof o.name === "string" ? o.name : null,
    })),
    ownsClock,
  );
  skipped.push(...clockPick.skipped);
  let deletedClocks = 0;
  for (const clock of clockPick.owned) {
    if (!clock.id) continue;
    const out = await deleteOwned(
      client,
      `/v1/test_helpers/test_clocks/${encodeURIComponent(clock.id)}`,
    );
    if (out.deleted) deletedClocks++;
    else problems.push(`test clock ${clock.id} was NOT deleted: ${out.reason}`);
  }

  // Customers: only our exact tag. A customer that went with a clock answers 404,
  // which deleteOwned treats as the success it is.
  const customers = await listAll(client, "/v1/customers");
  if (!customers.complete) {
    problems.push(
      `could not list every customer: ${customers.reason ?? "unknown"}`,
    );
  }
  const customerPick = selectOwned(customers.objects, ownsTaggedObject);
  skipped.push(...customerPick.skipped);
  let deletedCustomers = 0;
  for (const customer of customerPick.owned) {
    if (typeof customer.id !== "string") continue;
    const out = await deleteOwned(
      client,
      `/v1/customers/${encodeURIComponent(customer.id)}`,
    );
    if (out.deleted) deletedCustomers++;
    else
      problems.push(`customer ${customer.id} was NOT deleted: ${out.reason}`);
  }

  const coupons = await listAll(client, "/v1/coupons");
  if (!coupons.complete) {
    problems.push(
      `could not list every coupon: ${coupons.reason ?? "unknown"}`,
    );
  }
  const couponPick = selectOwned(coupons.objects, ownsTaggedObject);
  skipped.push(...couponPick.skipped);
  let deletedCoupons = 0;
  for (const coupon of couponPick.owned) {
    if (typeof coupon.id !== "string") continue;
    const out = await deleteOwned(
      client,
      `/v1/coupons/${encodeURIComponent(coupon.id)}`,
    );
    if (out.deleted) deletedCoupons++;
    else problems.push(`coupon ${coupon.id} was NOT deleted: ${out.reason}`);
  }

  reporter.line(
    `deleted ${deletedClocks} test clock(s) - with their customers and ` +
      `subscriptions - ${deletedCustomers} customer(s) and ${deletedCoupons} coupon(s).`,
  );
  if (skipped.length > 0) {
    // Named, not counted: "left 3 alone" invites the assumption that they were ours
    // and unimportant.
    reporter.line(`left alone (not ours): ${skipped.length}`);
    for (const item of skipped) reporter.line(`  ${item.id}: ${item.why}`);
  }
  reporter.line(
    "Prices and products are NOT touched: a used price cannot be deleted, only " +
      "archived, and archiving on a shared account should be a deliberate act.",
  );
  if (problems.length > 0) {
    for (const problem of problems) reporter.problem(problem);
    reporter.problem(
      "this cleanup was INCOMPLETE - re-run it, or finish by hand",
    );
    process.exit(1);
  }
}

/** Attach a Stripe customer id to a local account, for a test-clock customer. */
function cmdAdopt(args: Map<string, string>): void {
  const accountId = required(args, "account");
  const customerId = required(args, "customer");
  const store = openStore(args);
  try {
    store.tx(() => {
      const account = getAccount(store, accountId);
      if (!account) die(`no account ${accountId}`);
      if (
        !casAccount(store, account.id, account.version, {
          stripe_customer_id: customerId,
        })
      ) {
        die(`account ${accountId} moved; re-read and try again`);
      }
    });
    reporter.line(`${accountId} -> ${customerId}`);
  } finally {
    store.close();
  }
}

// -------------------------------------------------------------------- entry

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "bootstrap":
      return cmdBootstrap(args);
    case "checkout":
      return cmdCheckout(args);
    case "serve":
      return cmdServe(args);
    case "subs":
      return cmdSubs(args);
    case "events":
      return cmdEvents(args);
    case "tick":
      return cmdTick(args);
    case "clock":
      return cmdClock(args);
    case "cleanup":
      return cmdCleanup();
    case "adopt":
      return cmdAdopt(args);
    default:
      reporter.line(
        "usage: bun control-plane/billing-cli.ts " +
          "<bootstrap|checkout|serve|subs|events|tick|clock|cleanup|adopt> [--flags]",
      );
      process.exit(2);
  }
}

await main();
