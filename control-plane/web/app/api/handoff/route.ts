import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  confirmHandoff,
} from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * "Remove Hosted Isomux Provisioning access" - the customer confirming they are in.
 *
 * This is the observable act the design's ruling 7 turns into the end of the
 * access window, so the origin check matters as much as it does on signup: it
 * asks us to give up the only access we have to a box we may still need to
 * finish setting up, and no other site may do that on a customer's behalf.
 */
export async function POST(request: Request): Promise<Response> {
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });

  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) return new Response("not signed in", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    instanceId?: unknown;
  } | null;
  const instanceId =
    typeof body?.instanceId === "string" ? body.instanceId : "";
  if (!instanceId) return new Response("bad request", { status: 400 });

  const result = await confirmHandoff(accountId, instanceId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
