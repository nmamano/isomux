import { afterEach, describe, expect, test } from "bun:test";
import { signUpOffice } from "./web/lib/services.server";

const CUSTOMER_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

// A configuration refusal is deliberately opaque to the customer: one fixed
// sentence plus a reference code that finds the real detail in the server
// log. Which tier maps to which Stripe price is pinned where it is decided,
// in plans.test.ts ("explicit Entry pricing wins and the legacy price never
// sells Poweruser").
const OPAQUE_REFUSAL =
  /^Payments are not available right now\. Reference: PAY-[0-9A-F]{10}\.$/;

afterEach(() => {
  delete process.env.CONTROL_PLANE_PRICE_ID;
  delete process.env.CONTROL_PLANE_ENTRY_PRICE_ID;
  delete process.env.CONTROL_PLANE_POWERUSER_PRICE_ID;
  delete process.env.STRIPE_TEST_SECRET_KEY;
});

async function attempt(plan: string) {
  return signUpOffice({
    language: "en",
    accountId: "acct-price-test",
    officeName: "price-test",
    plan,
    customerSshKey: CUSTOMER_KEY,
  });
}

function expectOpaqueRefusal(result: Awaited<ReturnType<typeof attempt>>) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(OPAQUE_REFUSAL);
}

describe("signup price configuration before reservation", () => {
  test("an unconfigured tier is refused before any reservation", async () => {
    expectOpaqueRefusal(await attempt("poweruser"));
  });

  test("a legacy single price without a Stripe key still refuses both tiers", async () => {
    process.env.CONTROL_PLANE_PRICE_ID = "price-legacy";
    expectOpaqueRefusal(await attempt("office"));
    expectOpaqueRefusal(await attempt("poweruser"));
  });
});
