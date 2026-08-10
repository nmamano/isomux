// Who may write what, asserted against the source.
//
// "Webhooks are the only writer of subscription state" is a property of the code's
// SHAPE, not of any single run, so no behavioural test can hold it: a future
// dashboard button or Checkout success handler would pass every other test in this
// suite while quietly becoming a second writer. This file is the guard that fails
// when that happens, and it names the two setters so that the failure explains
// itself.
//
// It also scans the control-plane tree for live-key literals, which is the same
// check the frozen diff gets before review.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const STRIPE_DIR = import.meta.dir;
const CONTROL_PLANE = path.dirname(STRIPE_DIR);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function callersOf(symbol: string): string[] {
  const callers: string[] = [];
  for (const file of sourceFiles(CONTROL_PLANE)) {
    const bytes = fs.readFileSync(file, "utf8");
    // The definition and the import both mention it; what matters is the CALL.
    if (new RegExp(`${symbol}\\s*\\(`).test(bytes)) {
      callers.push(path.relative(CONTROL_PLANE, file));
    }
  }
  return callers.sort();
}

describe("the Stripe-owned setter", () => {
  test("is called only from reconciliation", async () => {
    // If this fails: something other than webhook reconciliation is writing the
    // cache of Stripe truth. Fetch the object and reconcile, or leave the row
    // alone - do not add the caller to this list.
    expect(callersOf("casStripeOwnedSubscription")).toEqual([
      "stripe/billing-store.test.ts",
      "stripe/billing-store.ts",
      "stripe/reconcile.ts",
    ]);
  });
});

describe("the episode setter", () => {
  test("is called only from reconciliation and the coupon-hold tick", async () => {
    // The tick is the ONE non-webhook writer the design asks for, and it is
    // deliberately narrow: episode bookkeeping only, never Stripe truth.
    expect(callersOf("casEpisodeBookkeeping")).toEqual([
      "stripe/billing-store.test.ts",
      "stripe/billing-store.ts",
      "stripe/billing-tick.ts",
      "stripe/reconcile.ts",
    ]);
  });
});

describe("the subscription insert", () => {
  test("happens only where a fetched object establishes the row", async () => {
    // Test files that SEED a row are listed rather than excluded by a pattern:
    // the point of this pin is that adding a caller is a deliberate edit here,
    // and a rule that skipped tests would let a "just for the fixture" writer in.
    // reconcile.ts is still the only production caller.
    expect(callersOf("insertSubscription")).toEqual([
      "cancel.test.ts",
      "exercises/cancel-live.ts",
      "lifecycle-tick.test.ts",
      "resume.test.ts",
      "stripe/billing-store.test.ts",
      "stripe/billing-store.ts",
      "stripe/billing-tick.test.ts",
      "stripe/reconcile.ts",
      "web/e2e/lifecycle.e2e.ts",
    ]);
  });
});

describe("live-mode credentials", () => {
  test("no literal live key appears anywhere in control-plane/", async () => {
    // The guards themselves must name the sk_live_ prefix, so the scan looks for a
    // credential-shaped BODY after it rather than for the prefix alone.
    const credential = /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/;
    for (const file of sourceFiles(CONTROL_PLANE)) {
      const bytes = fs.readFileSync(file, "utf8");
      expect({
        file: path.relative(CONTROL_PLANE, file),
        matched: credential.test(bytes),
      }).toEqual({ file: path.relative(CONTROL_PLANE, file), matched: false });
    }
  });

  test("no webhook signing secret appears anywhere in control-plane/", async () => {
    const credential = /\bwhsec_[A-Za-z0-9]{20,}/;
    for (const file of sourceFiles(CONTROL_PLANE)) {
      const bytes = fs.readFileSync(file, "utf8");
      expect({
        file: path.relative(CONTROL_PLANE, file),
        matched: credential.test(bytes),
      }).toEqual({ file: path.relative(CONTROL_PLANE, file), matched: false });
    }
  });
});
