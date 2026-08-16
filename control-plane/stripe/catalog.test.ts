import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_CURRENCY,
  MANAGED_PAYMENTS_TAX_CODE,
  testPriceParams,
  testProductParams,
} from "./catalog.ts";

describe("the Managed Payments test catalogue", () => {
  test("the product carries the tentative eligible tax code", () => {
    expect(testProductParams().tax_code).toBe(MANAGED_PAYMENTS_TAX_CODE);
    expect(MANAGED_PAYMENTS_TAX_CODE).toBe("txcd_10701410");
  });

  test("the default price is USD with tax explicitly added on top", () => {
    expect(DEFAULT_TEST_CURRENCY).toBe("usd");
    expect(testPriceParams("prod_1", 100)).toMatchObject({
      product: "prod_1",
      currency: "usd",
      unit_amount: 100,
      tax_behavior: "exclusive",
    });
  });
});
