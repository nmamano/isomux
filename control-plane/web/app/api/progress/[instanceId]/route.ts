import { auth } from "../../../../auth";
import { progressForAccount } from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * The polled projection.
 *
 * The instance id in the path is a claim, not an authorisation: ownership is
 * decided against the signed-in account's reservation, and a foreign or unknown
 * id gets the same 404. Which of the two it was is not the asker's business.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ instanceId: string }> },
): Promise<Response> {
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) return new Response("not signed in", { status: 401 });

  const { instanceId } = await ctx.params;
  const view = await progressForAccount(accountId, instanceId);
  if (!view) return new Response("not found", { status: 404 });
  return Response.json(view);
}
