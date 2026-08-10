import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  requestInvite,
} from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * Ask for an owner invite.
 *
 * No URL comes back from here. This opens the request; the provisioner mints it
 * under a lease and holds the result in its own memory, and the page collects
 * it once from /api/invite/reveal. Splitting the two is what keeps a ~15s
 * two-hop SSH out of a browser request and the mint inside the leased-operation
 * discipline.
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

  // Ownership is decided in the control plane, against the reservation row.
  // Nothing here treats the id in the body as authorisation.
  const result = await requestInvite(accountId, instanceId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
