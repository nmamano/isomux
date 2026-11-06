import {
  enterpriseAnswer,
  enterpriseCaller,
  notJson,
} from "../../../lib/enterprise-request.server";
import { createEnterpriseFor } from "../../../lib/services.server";
import { normalizeEmail } from "../../../lib/signin-link.server";

export const dynamic = "force-dynamic";

/** Set up the signed-in account's enterprise account. The domain checks every
 * field; the billing email is normalized here like the account email. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  const { body } = caller;
  if (!body) return notJson();
  const result = await createEnterpriseFor(caller.accountId, {
    company: body.company as string,
    // An empty address is refused as the billing email, in field order.
    billingEmail: normalizeEmail(body.billingEmail) ?? "",
    plan: body.plan as "monthly" | "yearly",
    seats: body.seats as number,
  });
  return enterpriseAnswer(result);
}
