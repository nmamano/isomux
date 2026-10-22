// The Stripe customer's email, which is where Stripe sends receipts. It follows
// the account's address when the customer changes it (signup.ts
// changeAccountEmail).

import type { StripeClient } from "./client.ts";

/**
 * `missing`: Stripe has no such customer (deleted), so there is nothing to
 * follow the address. `failed`: any other rejection, or an answer that does not
 * say whether Stripe applied the write.
 */
export type CustomerEmailResult = "updated" | "missing" | "failed";

export async function updateCustomerEmail(
  client: StripeClient,
  customerId: string,
  email: string,
  idempotencyKey: string,
): Promise<CustomerEmailResult> {
  const result = await client.post(
    `/v1/customers/${encodeURIComponent(customerId)}`,
    { email },
    idempotencyKey,
  );
  if (result.kind === "ok") return "updated";
  if (
    result.kind === "rejected" &&
    result.status === 404 &&
    result.code === "resource_missing"
  ) {
    return "missing";
  }
  return "failed";
}
