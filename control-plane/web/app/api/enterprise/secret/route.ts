import {
  enterpriseAnswer,
  enterpriseCaller,
} from "../../../../lib/enterprise-request.server";
import { renewSecretFor } from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Make a new secret; the old one stops working. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  return enterpriseAnswer(await renewSecretFor(caller.accountId));
}
