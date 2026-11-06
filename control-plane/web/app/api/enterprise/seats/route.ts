import {
  enterpriseAnswer,
  enterpriseCaller,
  notJson,
} from "../../../../lib/enterprise-request.server";
import { changeSeatsFor } from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** Change the seat count N from `from` to `to`. A stale `from` is refused, so
 * a confirm that showed the cost of another N cannot commit. */
export async function POST(request: Request): Promise<Response> {
  const caller = await enterpriseCaller(request);
  if ("refused" in caller) return caller.refused;
  const { body } = caller;
  if (!body) return notJson();
  const result = await changeSeatsFor(caller.accountId, {
    from: body.from as number,
    to: body.to as number,
  });
  return enterpriseAnswer(result);
}
