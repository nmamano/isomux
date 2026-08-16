import type { FormValue } from "./client.ts";
import { TEST_PREFIX } from "./test-clock.ts";

/** Tentative test-mode code; the live product requires Nil's explicit sign-off. */
export const MANAGED_PAYMENTS_TAX_CODE = "txcd_10701410";
export const DEFAULT_TEST_CURRENCY = "usd";

export function testProductParams(): Record<string, FormValue> {
  return {
    name: `${TEST_PREFIX} slice-3 test office (not a real plan)`,
    tax_code: MANAGED_PAYMENTS_TAX_CODE,
    metadata: { isomux_test: "slice3" },
  };
}

export function testPriceParams(
  productId: string,
  amount: number,
  currency = DEFAULT_TEST_CURRENCY,
): Record<string, FormValue> {
  return {
    product: productId,
    currency,
    unit_amount: amount,
    tax_behavior: "exclusive",
    recurring: { interval: "month" },
    nickname: `${TEST_PREFIX} test price - not a product price`,
    metadata: { isomux_test: "slice3" },
  };
}
