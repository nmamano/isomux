#!/usr/bin/env bun
// The scripted browser transcript for slice 4a.
//
// It drives a REAL browser against a REAL dev server against a REAL Stripe test
// account, and prints a transcript rather than assertions alone: the point of
// this file is evidence a reviewer can read, so every check prints what it saw.
//
// It is not a unit test and is deliberately not named like one - `bun test`
// must not pick it up, because it needs a browser, a dev server, network and a
// Stripe key. It runs as its own process and nothing in the app imports it.
//
//   export STRIPE_TEST_SECRET_KEY=...      # source ~/nil/secrets/stripe-test.env
//   export CONTROL_PLANE_PRICE_ID=price_...   # from: billing-cli.ts bootstrap
//   export CONTROL_PLANE_COUPON_ID=...        # the 100%-off coupon it printed
//   bun run --cwd control-plane/web e2e
//
// The Stripe legs are skipped, loudly, when the key is absent, so the browser
// half still runs on a machine with no credentials.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { Store } from "../../store.ts";
import { accountForDevSignIn, reserveOffice } from "../../signup.ts";
import { StripeClient } from "../../stripe/client.ts";

const PORT = Number(process.env.E2E_PORT ?? 3311);
const BASE = `http://localhost:${PORT}`;
const WEB_DIR = path.join(import.meta.dir, "..");
const REPO = path.join(WEB_DIR, "..", "..");
const CHROME = "/usr/bin/google-chrome";

const transcript: string[] = [];
function say(line: string): void {
  const safe = line
    .replace(/sk_(test|live)_[A-Za-z0-9]+/g, "<stripe key redacted>")
    .replace(/whsec_[A-Za-z0-9]+/g, "<webhook secret redacted>")
    // A hosted Checkout URL is a live capability for that session, not an
    // identifier: anyone holding it can drive the payment. It stays out of a
    // transcript that gets pasted into reports.
    .replace(
      /https:\/\/checkout\.stripe\.com\/\S*/g,
      "<checkout session url redacted>",
    )
    .replace(/cs_(test|live)_[A-Za-z0-9]+/g, "<checkout session redacted>");
  transcript.push(safe);
  console.log(safe);
}

function check(label: string, ok: boolean, detail = ""): void {
  say(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", REPO, ...args]);
  return proc.stdout.toString();
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
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

async function submitSignup(
  page: Page,
  name: string,
  coupon = "",
): Promise<void> {
  await page.goto(`${BASE}/signup`);
  await page.fill('[data-testid="office-name"]', name);
  if (coupon) await page.fill('[data-testid="coupon"]', coupon);
  // WAIT FOR THE NAVIGATION THE CLICK CAUSES, not for the page already loaded.
  // waitForLoadState resolves immediately against the current document, so it
  // reported the form's own URL while the redirect to Stripe was still in
  // flight - and the transcript then said Checkout was never reached.
  await Promise.all([
    page
      .waitForURL((url) => url.toString() !== `${BASE}/signup`, {
        timeout: 60_000,
      })
      .catch(() => {}),
    page.click('[data-testid="signup-submit"]'),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

async function errorCopy(page: Page): Promise<string> {
  const node = await page.$('[data-testid="signup-error"]');
  return node ? ((await node.textContent()) ?? "").trim() : "";
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp4a-e2e-"));
  // The webhook leg needs the slice-3 billing server writing the SAME database,
  // so the runner passes one in. On its own the driver uses a temp file.
  const db = process.env.E2E_SHARED_DB ?? path.join(dir, "control-plane.db");
  const stripeKey = process.env.STRIPE_TEST_SECRET_KEY;
  const priceId = process.env.CONTROL_PLANE_PRICE_ID;
  const couponId = process.env.CONTROL_PLANE_COUPON_ID;
  const stripeLegs = !!(stripeKey && priceId);

  say(`# slice 4a browser transcript`);
  say(`database: ${db}`);
  say(`stripe legs: ${stripeLegs ? "on" : "SKIPPED (no key or price in env)"}`);

  const statusBefore = git(["status", "--porcelain"]);
  say(
    `git status --porcelain before: ${statusBefore.split("\n").length - 1} lines`,
  );

  // A name another account already holds, so the "taken" refusal is a real
  // cross-account refusal rather than the same owner's retry.
  {
    const store = await Store.open(db);
    const other = await accountForDevSignIn(store, "someone-else@example.com");
    const seeded = await reserveOffice(store, {
      accountId: other.id,
      officeName: "taken",
      plan: "office",
    });
    check("seeded another account's reservation", seeded.ok);
    await store.close();
  }

  const server = Bun.spawn(
    ["bun", "--bun", "node_modules/.bin/next", "dev", "-p", String(PORT)],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        CONTROL_PLANE_DB: db,
        CONTROL_PLANE_DEV_AUTH: "1",
        NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH: "1",
        AUTH_SECRET: process.env.AUTH_SECRET ?? "slice-4a-transcript-secret",
        AUTH_URL: BASE,
        NEXTAUTH_URL: BASE,
        ...(priceId ? { CONTROL_PLANE_PRICE_ID: priceId } : {}),
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

    await page.goto(BASE);
    check(
      "signed out, the front page offers sign-in",
      (await page.content()).includes("Sign in"),
    );

    await signInAs(page, "customer@example.com");
    const who = await page.textContent('[data-testid="signed-in-as"]');
    check(
      "dev sign-in produced a session",
      !!who?.includes("customer@example.com"),
      who ?? "",
    );

    // ---- the three refusals, with their actual copy
    await submitSignup(page, "Not A Label");
    say(`refusal (bad label): ${await errorCopy(page)}`);
    check("a bad label is refused", (await errorCopy(page)).length > 0);

    await submitSignup(page, "admin");
    say(`refusal (reserved): ${await errorCopy(page)}`);
    check(
      "a reserved name is refused",
      (await errorCopy(page)).includes("centrally"),
    );

    if (stripeLegs) {
      // A name another account holds is decided by the INSERT, so it can only
      // be reported by a deployment that is able to reserve at all. Without a
      // price configured, signup stops earlier and honestly says so.
      await submitSignup(page, "taken");
      say(`refusal (taken): ${await errorCopy(page)}`);
      check(
        "another account's name is refused",
        (await errorCopy(page)).includes("taken"),
      );
    } else {
      say(
        "SKIP: the taken-name refusal needs a configured price to be reached",
      );
    }

    {
      const store = await Store.open(db);
      const rows = await store.sqlGet<{ n: number }>(
        "select count(*) as n from name_reservations",
      );
      check(
        "no reservation was created by any refusal",
        rows?.n === 1,
        `rows=${rows?.n}`,
      );
      await store.close();
    }

    // ---- a post from somewhere else must write nothing and spend nothing
    {
      const before = await Store.open(db);
      const rowsBefore = (
        await before.sqlGet<{ n: number }>(
          "select count(*) as n from name_reservations",
        )
      )?.n;
      await before.close();
      const foreign = await page.request.post(`${BASE}/api/signup`, {
        headers: { origin: "https://evil.example" },
        form: { officeName: "stolen", plan: "office", couponId: "" },
        maxRedirects: 0,
      });
      const after = await Store.open(db);
      const rowsAfter = (
        await after.sqlGet<{ n: number }>(
          "select count(*) as n from name_reservations",
        )
      )?.n;
      const stolen = (
        await after.sqlGet<{ n: number }>(
          "select count(*) as n from name_reservations where name = 'stolen'",
        )
      )?.n;
      await after.close();
      say(`cross-site POST /api/signup -> ${foreign.status()}`);
      check(
        "a foreign-origin signup is refused and writes nothing",
        foreign.status() === 403 && rowsAfter === rowsBefore && stolen === 0,
        `status=${foreign.status()} rows ${rowsBefore}->${rowsAfter}`,
      );
    }

    // ---- the real signup
    if (!stripeLegs) {
      say("SKIP: Checkout, webhook and dashboard legs need a Stripe test key");
    } else {
      // The form POST is issued through the browser's own request context, with
      // redirects OFF, so the transcript carries what the SERVER said rather
      // than where Chrome ended up. Following a cross-origin 303 by clicking
      // left Chrome on an error page and the transcript claiming Checkout was
      // never reached, which was false: the session had been created.
      const posted = await page.request.post(`${BASE}/api/signup`, {
        // A browser stamps Origin on every same-origin form POST; Playwright's
        // request context does not, so it is set here to make this request the
        // one a real submission sends. The foreign-origin case above is what
        // proves the header is actually being checked.
        headers: { origin: BASE },
        form: {
          officeName: "cp1",
          plan: "office",
          couponId: couponId ?? "",
        },
        maxRedirects: 0,
      });
      const location = posted.headers()["location"] ?? "";
      say(
        `POST /api/signup -> ${posted.status()} ` +
          `${location ? new URL(location).origin : "(no location)"}` +
          `${location ? "/... <session url redacted>" : ""}`,
      );
      check(
        "signup created a Checkout session and redirected to it",
        posted.status() === 303 &&
          location.startsWith("https://checkout.stripe.com/"),
        `status=${posted.status()}`,
      );

      const store = await Store.open(db);
      const reservation = await store.sqlGet<{
        name: string;
        instance_id: string;
        coupon_id: string | null;
      }>(
        "select name, instance_id, coupon_id from name_reservations where name = 'cp1'",
      );
      const instance = reservation
        ? await store.getInstance(reservation.instance_id)
        : null;
      check(
        "the reservation row exists",
        !!reservation,
        JSON.stringify(reservation),
      );
      check(
        "the instance row exists, provisioning, with a ceiling",
        instance?.service_state === "provisioning" &&
          instance.access_window_expires_at !== null,
        `${instance?.name} ${instance?.service_state} ceiling=${instance?.access_window_expires_at}`,
      );
      await store.close();

      // The comped page collects no card: one button, no card accordion. Only
      // touched when we actually reached Stripe - clicking a "submit" on our
      // own form because Checkout was never opened is how a driver reports a
      // payment that never happened.
      // The session OBJECT is the evidence, not Stripe's DOM: what the comped
      // path must prove - test mode, nothing owed, no card collected - is
      // recorded on the session, and scraping a third party's markup for it
      // would make this transcript fail whenever they restyle a button.
      const sessionId = /cs_test_[A-Za-z0-9]+/.exec(location)?.[0] ?? "";
      if (sessionId && stripeKey) {
        const client = new StripeClient({ key: stripeKey });
        const fetched = await client.get(`/v1/checkout/sessions/${sessionId}`, {
          "expand[0]": "total_details",
        });
        if (fetched.kind === "ok") {
          const b: Record<string, unknown> = fetched.body;
          say(
            `session (id redacted): livemode=${String(b.livemode)} ` +
              `payment_method_collection=${String(b.payment_method_collection)} ` +
              `amount_total=${String(b.amount_total)} ${String(b.currency)} ` +
              `status=${String(b.status)}`,
          );
          check("the session is test mode", b.livemode === false);
          if (couponId) {
            check(
              "the comped path collects no card and owes nothing",
              b.payment_method_collection === "if_required" &&
                b.amount_total === 0,
              `${String(b.payment_method_collection)} / ${String(b.amount_total)}`,
            );
          }
        } else {
          say(`could not read the session back: ${fetched.reason}`);
        }
      }

      if (location.startsWith("https://checkout.stripe.com/")) {
        await page
          .goto(location, { timeout: 90_000, waitUntil: "domcontentloaded" })
          .catch((err: Error) =>
            say(`hosted page navigation: ${err.message.split("\n")[0]}`),
          );
        say(`hosted page origin: ${new URL(page.url()).origin}`);
        // Stripe's page is a client-rendered app: querying it the instant the
        // document loads finds no buttons and reports, wrongly, that there is
        // nothing to click.
        await page
          .waitForSelector('[data-testid="hosted-payment-submit-button"]', {
            timeout: 45_000,
          })
          .catch(() => say("the hosted page never rendered its submit button"));
        const bodyText = (
          await page.evaluate(() => document.body.innerText ?? "")
        ).replace(/\s+/g, " ");
        say(
          `hosted page asks for a card number: ${/card number/i.test(bodyText)}`,
        );
        say(
          `hosted page total: ${
            (bodyText.match(/€\s?[\d.,]+[^|]{0,70}/) ?? ["not found"])[0]
          }`,
        );
        const subscribe =
          (await page.$('[data-testid="hosted-payment-submit-button"]')) ??
          (await page.$('button[type="submit"]'));
        if (subscribe) {
          await Promise.all([
            page.waitForURL(/localhost/, { timeout: 120_000 }).catch(() => {}),
            subscribe.click(),
          ]);
          say(`after subscribing, the browser is at: ${page.url()}`);
          check(
            "paying returns the customer to their own office page",
            page.url().includes("/office/"),
            page.url(),
          );
        } else {
          say("no subscribe button found on the hosted page");
        }
      } else {
        say("SKIP: never reached Checkout, so nothing was paid");
      }

      say(
        "NOTE: the subscription row lands only when the webhook is forwarded - " +
          "run `stripe listen --forward-to http://localhost:4243/stripe/webhook` " +
          "and `bun control-plane/billing-cli.ts serve --db <this db> --port 4243` " +
          "alongside this driver",
      );
    }

    // ---- progress rendering, driven from rows
    {
      const store = await Store.open(db);
      const res = await store.sqlGet<{ instance_id: string }>(
        "select instance_id from name_reservations where account_id = " +
          "(select id from accounts where email = 'customer@example.com')",
      );
      if (res) {
        const seq = await store.nextSeq("audit");
        await store.enqueue({
          id: `op-wait_for_ssh-${seq}`,
          instance_id: res.instance_id,
          kind: "wait_for_ssh",
          inactivity_deadline_at: store.now() + 600_000,
          absolute_deadline_at: store.now() + 900_000,
          evidence: { probes: 3 },
        });
        await store.close();
        await page
          .goto(`${BASE}/office/${res.instance_id}`, { timeout: 60_000 })
          .catch((err: Error) =>
            say(`office page navigation: ${err.message.split("\n")[0]}`),
          );
        const text = (await page.textContent("body")) ?? "";
        say(`office page: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
        check(
          "the ladder renders with a live step",
          text.includes("Waiting for the server to answer"),
        );
        check(
          "no step claims to be done without a row",
          text.includes("Installing isomux") && text.includes("waiting"),
        );
        // Nothing has been ordered yet, so the page must not say we hold a key.
        check(
          "a fresh office claims no key before a box exists",
          text.includes("does not have a key to your server yet"),
          text.includes("holds a temporary key") ? "it claimed a key" : "",
        );

        // An AMBIGUOUS create, rendered. The provider may have built a machine
        // carrying our key that we cannot yet name, so the page must not say
        // there is no key. The rows are written here rather than by ordering a
        // box: this driver never spends money.
        {
          const amb = await Store.open(db);
          const asset = (await amb.assetForInstance(res.instance_id))!;
          await amb.tx(async () => {
            await amb.casAsset(asset.id, asset.version, {
              asset_state: "order_ambiguous",
            });
          });
          const seq = await amb.nextSeq("audit");
          await amb.enqueue({
            id: `op-create_instance-${seq}`,
            instance_id: res.instance_id,
            kind: "create_instance",
            inactivity_deadline_at: amb.now() + 900_000,
            absolute_deadline_at: amb.now() + 900_000,
          });
          await amb.sqlRun(
            "update operations set status = 'ambiguous' where kind = 'create_instance'",
          );
          await amb.close();
          await page.reload();
          const ambText = (
            await page.evaluate(() => document.body.innerText ?? "")
          ).replace(/\s+/g, " ");
          say(
            `with an ambiguous create (synthetic rows): ${ambText.slice(-160)}`,
          );
          check(
            "an ambiguous create never claims there is no key",
            ambText.includes("cannot confirm whether it still has a key") &&
              !ambText.includes("does not have a key"),
          );
        }

        // The other end of the same claim, rendered from a SYNTHETIC succeeded
        // revocation row (this driver has no box to revoke on). The real one is
        // in the live-box transcript.
        const after = await Store.open(db);
        const revokeSeq = await after.nextSeq("audit");
        await after.enqueue({
          id: `op-revoke_access-${revokeSeq}`,
          instance_id: res.instance_id,
          kind: "revoke_access",
          inactivity_deadline_at: after.now() + 600_000,
          absolute_deadline_at: after.now() + 900_000,
        });
        await after.sqlRun(
          "update operations set status = 'succeeded' where kind = 'revoke_access'",
        );
        await after.close();
        await page.reload();
        const revokedText = (
          await page.evaluate(() => document.body.innerText ?? "")
        ).replace(/\s+/g, " ");
        say(`after a proven revocation: ${revokedText.slice(-220)}`);
        check(
          "a proven revocation says the key is gone, and does not contradict the step",
          revokedText.includes("no longer has a key to your server") &&
            revokedText.includes("Removing our access - done"),
        );
      } else {
        await store.close();
        say("SKIP: no office to render (the Stripe leg did not run)");
      }
    }

    // ---- another account cannot read it
    {
      const store = await Store.open(db);
      const other = await store.sqlGet<{ instance_id: string }>(
        "select instance_id from name_reservations where name = 'taken'",
      );
      await store.close();
      if (other) {
        const res = await page.request.get(
          `${BASE}/api/progress/${other.instance_id}`,
        );
        check(
          "another account's office is a 404, not a leak",
          res.status() === 404,
          `status=${res.status()}`,
        );
      }
    }

    // ---- the tree the dev server left behind
    const agents = fs.existsSync(path.join(WEB_DIR, "AGENTS.md"));
    const claude = fs.existsSync(path.join(WEB_DIR, "CLAUDE.md"));
    check("next dev wrote no AGENTS.md", !agents);
    check("next dev wrote no CLAUDE.md", !claude);
    const statusAfter = git(["status", "--porcelain"]);
    check(
      "git status is byte-identical before and after the dev run",
      statusAfter === statusBefore,
      statusAfter === statusBefore
        ? ""
        : "the dev server changed tracked state",
    );
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.writeFileSync(path.join(dir, "transcript.txt"), transcript.join("\n"));
    say(`transcript: ${path.join(dir, "transcript.txt")}`);
  }
}

await main();
