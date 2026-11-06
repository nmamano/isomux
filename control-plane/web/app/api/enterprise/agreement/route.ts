import {
  enterpriseAnswer,
  enterpriseCaller,
  notJson,
} from "../../../../lib/enterprise-request.server";
import { signAgreementFor } from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Sign the standard agreement. The domain checks the fields and the
 * authority box. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  const { body } = caller;
  if (!body) return notJson();
  const result = await signAgreementFor(caller.accountId, {
    name: body.name as string,
    title: body.title as string,
    authority: body.authority as boolean,
  });
  return enterpriseAnswer(result);
}
