// What may live in `fixtures/`, and the live-mode fixture that proves the refusal.
//
// A recorded Stripe body carries customer details, so the rule is not only "no
// secrets": emails, names, addresses, card data and session URLs are scrubbed
// before a recording lands here, and synthetic fixtures are preferred for unit
// tests. This file is what makes those rules checkable rather than remembered.

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
import { listEvents, listSubscriptions } from "./billing-store.ts";
import type { StripeObjectReader } from "./reader.ts";
import {
  normalizeInvoice,
  normalizeSession,
  normalizeSubscription,
} from "./shapes.ts";
import { WebhookProcessor } from "./webhook.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const SECRET = "whsec_NOT_A_REAL_SECRET_ONLY_A_SHAPE";
const temps: string[] = [];

/**
 * A CREDENTIAL, as opposed to a placeholder that merely starts the same way.
 *
 * Real Stripe keys are a prefix and then a long run of letters and digits with no
 * punctuation. The test shapes in this suite say NOT_A_REAL_KEY, which has
 * underscores, so the scan can tell a credential from a guard literal - which it
 * must, because the guards themselves have to name these prefixes.
 */
const CREDENTIAL_SHAPES = [
  /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{20,}/,
  /\bwhsec_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Personal data that has no business in a repository.
 *
 * The scrub's own placeholders are allowed by name - `"SCRUBBED"`,
 * `scrubbed@example.com`, `scrubbed-<key>` - because their PRESENCE is the evidence
 * that the scrub ran. Any other value in these fields fails.
 */
const PLACEHOLDER = String.raw`SCRUBBED|scrubbed@example\.com|scrubbed-[a-z_]+`;
const PERSONAL_SHAPES: [RegExp, string][] = [
  [
    new RegExp(
      `"(?:receipt_email|customer_email)"\\s*:\\s*"(?!null|${PLACEHOLDER}")[^"]+"`,
    ),
    "an email field",
  ],
  [
    /"email"\s*:\s*"(?!null)[^"]*@(?!example\.com|stripe\.test)[^"]+"/,
    "a real-looking email",
  ],
  [
    /"(?:line1|line2|postal_code|city|state)"\s*:\s*"(?!null)[^"]+"/,
    "an address",
  ],
  [/"(?:last4|iin|fingerprint)"\s*:\s*"(?!null)[^"]+"/, "card data"],
  [
    /https:\/\/checkout\.stripe\.com\/c\/pay\/[A-Za-z0-9_-]{10,}/,
    "a Checkout URL with a session id",
  ],
  [/"name"\s*:\s*"(?!null)(?!cp3)[^"]*\s[A-Z][a-z]+"/, "a person's name"],
];

function fixtureFiles(): string[] {
  if (!fs.existsSync(FIXTURES)) return [];
  return fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(FIXTURES, f));
}

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the fixtures directory", () => {
  test("holds at least the live-mode refusal fixture", async () => {
    // Otherwise the scans below would pass by having nothing to scan.
    expect(fixtureFiles().length).toBeGreaterThan(0);
  });

  test("carries no credential of any shape", async () => {
    for (const file of fixtureFiles()) {
      const bytes = fs.readFileSync(file, "utf8");
      for (const shape of CREDENTIAL_SHAPES) {
        // Reported by name only; the assertion never echoes what it matched.
        expect({
          file: path.basename(file),
          matched: shape.test(bytes),
        }).toEqual({
          file: path.basename(file),
          matched: false,
        });
      }
    }
  });

  test("carries no personal data", async () => {
    for (const file of fixtureFiles()) {
      const bytes = fs.readFileSync(file, "utf8");
      for (const [shape, what] of PERSONAL_SHAPES) {
        expect({
          file: path.basename(file),
          found: shape.test(bytes) ? what : null,
        }).toEqual({ file: path.basename(file), found: null });
      }
    }
  });

  test("every fixture is valid JSON and says which mode it is", async () => {
    for (const file of fixtureFiles()) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        livemode?: unknown;
      };
      expect(typeof parsed.livemode).toBe("boolean");
    }
  });
});

describe("the synthetic live-mode delivery", () => {
  test("is refused with a valid signature, and nothing is fetched or written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-fixture-"));
    temps.push(dir);
    const store = await Store.open(
      path.join(dir, "cp.db"),
      () => 1_770_000_000_000,
    );
    const calls: string[] = [];
    const reader: StripeObjectReader = {
      getSubscription: async (id) => {
        calls.push(id);
        return { kind: "absent" };
      },
      getInvoice: async (id) => {
        calls.push(id);
        return { kind: "absent" };
      },
      getCheckoutSession: async (id) => {
        calls.push(id);
        return { kind: "absent" };
      },
    };
    const processor = new WebhookProcessor({
      store,
      reader,
      secret: SECRET,
      now: () => 1_770_000_000_000,
    });

    const raw = fs.readFileSync(
      path.join(FIXTURES, "livemode-subscription-updated.json"),
      "utf8",
    );
    const t = 1_770_000_000;
    const v1 = createHmac("sha256", SECRET)
      .update(`${t}.${raw}`, "utf8")
      .digest("hex");

    const outcome = await processor.handle(raw, `t=${t},v1=${v1}`);
    expect(outcome).toMatchObject({ status: 400, kind: "refused" });
    // The signature was GOOD. The refusal is about the mode, and it happens before
    // anything is read or written.
    expect(calls).toEqual([]);
    expect(await listEvents(store)).toEqual([]);
    expect(await listSubscriptions(store)).toEqual([]);
    await store.close();
  });
});

describe("recorded deliveries still parse", () => {
  // The ONE job of a recorded fixture: what Stripe actually sent on 2026-08-09,
  // against API version 2026-07-29.dahlia, must still normalise. Every synthetic
  // shape in shapes.test.ts was written from these.
  function objectOf(name: string): unknown {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
    ) as { data: { object: unknown } };
    return raw.data.object;
  }

  test("a completed comped session reports if_required and names its subscription", async () => {
    const snap = normalizeSession(objectOf("recorded-session-comped"));
    expect(snap.paymentMethodCollection).toBe("if_required");
    // OBSERVED 2026-08-09: a fully discounted session completes with
    // payment_status "paid" and amount_total 0 - not "no_payment_required", which is
    // what the field name invites you to assume. Nothing in the ladder reads it; it
    // is asserted so the assumption stays written down.
    expect(snap.paymentStatus).toBe("paid");
    expect(snap.subscriptionId).toMatch(/^sub_/);
    expect(snap.livemode).toBe(false);
    expect(Object.keys(snap.metadata)).toContain("isomux_account");
  });

  test("a discounted subscription EVENT cannot be normalised at all, and says why", async () => {
    // THIS is why reconciliation fetches instead of trusting the payload: the event
    // body carries the discount as a bare id, so the percentage - the whole signal
    // for "comped" - is simply not in it. Refusing is the honest answer.
    expect(() =>
      normalizeSubscription(objectOf("recorded-subscription-discounted")),
    ).toThrow(/bare id/);
  });

  test("a failed invoice still being retried names its subscription through parent", async () => {
    const snap = normalizeInvoice(objectOf("recorded-invoice-failed-retrying"));
    expect(snap.subscriptionId).toMatch(/^sub_/);
    expect(snap.nextPaymentAttempt).not.toBeNull();
    expect(snap.paid).toBe(false);
  });

  test("the exhausted invoice is the shape the ladder reads as exhaustion", async () => {
    const snap = normalizeInvoice(
      objectOf("recorded-invoice-failed-exhausted"),
    );
    expect(snap.nextPaymentAttempt).toBeNull();
    expect(snap.status).toBe("open");
    expect(snap.attemptCount).toBe(9);
    // No `paid` boolean exists in this API version; it is derived.
    expect(snap.paid).toBe(false);
  });

  test("a deleted subscription reads as canceled", async () => {
    const snap = normalizeSubscription(
      objectOf("recorded-subscription-deleted"),
    );
    expect(snap.status).toBe("canceled");
    expect(snap.livemode).toBe(false);
  });
});
