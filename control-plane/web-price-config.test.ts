import { afterEach, describe, expect, test } from "bun:test";
import { signUpOffice } from "./web/lib/services.server";

const CUSTOMER_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

afterEach(() => {
  delete process.env.CONTROL_PLANE_PRICE_ID;
  delete process.env.CONTROL_PLANE_ENTRY_PRICE_ID;
  delete process.env.CONTROL_PLANE_POWERUSER_PRICE_ID;
  delete process.env.STRIPE_TEST_SECRET_KEY;
});

async function attempt(plan: string) {
  return signUpOffice({
    accountId: "acct-price-test",
    officeName: "price-test",
    plan,
    customerSshKey: CUSTOMER_KEY,
  });
}

describe("signup price configuration before reservation", () => {
  test("an unconfigured tier is named in the refusal", async () => {
    expect(await attempt("poweruser")).toEqual({
      ok: false,
      reason:
        "This deployment has no Stripe price configured for the Poweruser plan",
    });
  });

  test("the legacy single price still configures Entry only", async () => {
    process.env.CONTROL_PLANE_PRICE_ID = "price-legacy";
    expect(await attempt("office")).toEqual({
      ok: false,
      reason: "This deployment has no Stripe key configured",
    });
    expect(await attempt("poweruser")).toEqual({
      ok: false,
      reason:
        "This deployment has no Stripe price configured for the Poweruser plan",
    });
  });
});
