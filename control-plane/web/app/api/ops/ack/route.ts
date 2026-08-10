import { auth } from "../../../../auth";
import {
  acknowledgeOpsInstance,
  checkTrustedOrigin,
} from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * "We have seen it."
 *
 * Acknowledging is not clearing, so this is a low-stakes write - and it still
 * takes the same origin check every other writing route takes, because it
 * happens on the strength of a cookie and writes a durable claim about who saw
 * what and when.
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

  const n = await acknowledgeOpsInstance(accountId, instanceId);
  // Null covers "not an operator" and "no such office" alike, and both are 404.
  if (n === null) return new Response("not found", { status: 404 });
  return Response.json({ ok: true, acknowledged: n });
}
