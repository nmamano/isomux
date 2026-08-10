import { auth } from "../../../../auth";
import {
  checkTrustedOrigin,
  revealInvite,
} from "../../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * Collect the minted invite, once.
 *
 * POST rather than GET on purpose: this is not a readable resource. Collecting
 * it CONSUMES it, so it must not be prefetchable, cacheable, or something a
 * browser or proxy can replay on its own initiative. The no-store headers say
 * the same thing to anything in between.
 *
 * The response body carries the URL to the page that asked and nowhere else -
 * there is no log line, no cookie and no cache on this path.
 */
export async function POST(request: Request): Promise<Response> {
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });

  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) return new Response("not signed in", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    instanceId?: unknown;
    operationId?: unknown;
  } | null;
  const instanceId =
    typeof body?.instanceId === "string" ? body.instanceId : "";
  const operationId =
    typeof body?.operationId === "string" ? body.operationId : "";
  if (!instanceId || !operationId) {
    return new Response("bad request", { status: 400 });
  }

  const result = await revealInvite(accountId, instanceId, operationId);
  return Response.json(result, {
    status: 200,
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
