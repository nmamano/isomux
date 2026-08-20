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
      if (entry.name === ".next" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function testSurfaceFiles(): string[] {
  return sourceFiles(CONTROL_PLANE).filter((file) => {
    const relative = path.relative(CONTROL_PLANE, file);
    return relative.endsWith(".test.ts") || relative.includes("/e2e/");
  });
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

function productionStripePostCallers(): string[] {
  return sourceFiles(CONTROL_PLANE)
    .filter((file) => {
      const relative = path.relative(CONTROL_PLANE, file);
      return (
        !relative.endsWith(".test.ts") &&
        !relative.startsWith("exercises/") &&
        !relative.includes("/e2e/") &&
        /\.post\s*\(/.test(fs.readFileSync(file, "utf8"))
      );
    })
    .map((file) => path.relative(CONTROL_PLANE, file))
    .sort();
}

describe("Stripe writes", () => {
  test("the webhook surface cannot add a Stripe POST", () => {
    // The webhook receives a signal and may only use StripeObjectReader GETs.
    // Pinning every production `.post(` caller makes a direct write or a new
    // write helper a deliberate failing-test change rather than a prose claim.
    expect(productionStripePostCallers()).toEqual([
      "billing-cli.ts",
      "cancel.ts",
      "reinstatement-operations.ts",
      "stripe/checkout.ts",
      "stripe/test-clock.ts",
    ]);
  });
});

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

describe("the cancellation-policy setter", () => {
  test("is ours and is called only from reconciliation", () => {
    expect(callersOf("casCancellationPolicy")).toEqual([
      "stripe/billing-store.ts",
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
      "reboot.test.ts",
      "reinstatement.test.ts",
      "requests.test.ts",
      "resume.test.ts",
      "stripe/billing-store.test.ts",
      "stripe/billing-store.ts",
      "stripe/billing-tick.test.ts",
      "stripe/cancellation-policy.test.ts",
      "stripe/reconcile.ts",
      "web-store-lifetime.test.ts",
      "web/e2e/lifecycle.e2e.ts",
      "web/e2e/signup-flow.e2e.ts",
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

describe("live-mode test isolation", () => {
  test("test and e2e surfaces cannot acquire a live runtime or credential", () => {
    const liveNames = [
      "STRIPE_" + "LIVE_SECRET_KEY",
      "STRIPE_" + "LIVE_WEBHOOK_SECRET",
    ].join("|");
    const environmentRead = new RegExp(
      `process\\.env(?:\\.(?:${liveNames})|\\[[^\\]]*(?:${liveNames})[^\\]]*\\])`,
    );
    const resolvedAmbientMode = /resolveStripeMode\s*\(\s*process\.env/;
    const liveEnvironmentHelper =
      /^[^"'`\n]*stripe(?:Key|WebhookSecret)FromEnv\s*\([^,]+,\s*process\.env/m;
    const productionRuntime =
      /(?:VERCEL_ENV\s*:\s*["']production|FLY_APP_NAME\s*:\s*["']isomux-provisioner)/;
    for (const file of testSurfaceFiles()) {
      const bytes = fs.readFileSync(file, "utf8");
      expect({
        file: path.relative(CONTROL_PLANE, file),
        environmentRead: environmentRead.test(bytes),
        resolvedAmbientMode: resolvedAmbientMode.test(bytes),
        liveEnvironmentHelper: liveEnvironmentHelper.test(bytes),
        productionRuntime: productionRuntime.test(bytes),
      }).toEqual({
        file: path.relative(CONTROL_PLANE, file),
        environmentRead: false,
        resolvedAmbientMode: false,
        liveEnvironmentHelper: false,
        productionRuntime: false,
      });
    }
  });

  test("the narrow synthetic live client allowance always injects fetch", () => {
    const allowed = new Set([
      "stripe/checkout.test.ts",
      "stripe/client.test.ts",
    ]);
    for (const file of testSurfaceFiles()) {
      const relative = path.relative(CONTROL_PLANE, file);
      const bytes = fs.readFileSync(file, "utf8");
      const constructions = bytes.match(
        /new StripeClient\(\{[\s\S]{0,300}?mode:\s*["']live["'][\s\S]{0,300}?\}\)/g,
      );
      if (!constructions) continue;
      expect(allowed.has(relative)).toBe(true);
      for (const construction of constructions) {
        expect(construction).toContain("fetchImpl");
      }
    }
  });

  test("the narrow synthetic live webhook allowance uses the fake reader", () => {
    const matches: string[] = [];
    for (const file of testSurfaceFiles()) {
      const relative = path.relative(CONTROL_PLANE, file);
      const bytes = fs.readFileSync(file, "utf8");
      if (
        /new WebhookProcessor\(\{[\s\S]{0,400}?mode:\s*["']live["']/.test(bytes)
      ) {
        matches.push(relative);
        expect(bytes).toContain('new FakeReader("live")');
      }
    }
    expect(matches).toEqual(["stripe/webhook.test.ts"]);
  });
});
