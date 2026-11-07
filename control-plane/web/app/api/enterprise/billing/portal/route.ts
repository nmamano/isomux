import {
  enterpriseAnswer,
  enterpriseCaller,
} from "../../../../../lib/enterprise-request.server";
import { enterprisePortalFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** A Stripe customer portal session for the account's invoices and payment
 * method; the page goes to its URL. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  return enterpriseAnswer(
    await enterprisePortalFor(caller.accountId, "/enterprise"),
  );
}
