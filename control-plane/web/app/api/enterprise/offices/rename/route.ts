import {
  enterpriseAnswer,
  enterpriseCaller,
  notJson,
} from "../../../../../lib/enterprise-request.server";
import { renameOfficeFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** IT names one of its offices. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  const { body } = caller;
  if (!body) return notJson();
  return enterpriseAnswer(
    await renameOfficeFor(caller.accountId, {
      office: body.office,
      name: body.name,
    }),
  );
}
