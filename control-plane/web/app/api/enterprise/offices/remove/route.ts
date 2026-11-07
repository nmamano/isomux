import {
  enterpriseAnswer,
  enterpriseCaller,
  notJson,
} from "../../../../../lib/enterprise-request.server";
import { removeOfficeFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** IT removes a shut-down office; it rejoins if it checks in again. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  const { body } = caller;
  if (!body) return notJson();
  return enterpriseAnswer(
    await removeOfficeFor(caller.accountId, { office: body.office }),
  );
}
