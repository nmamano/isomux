import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  requestRestart,
} from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/**
 * Restart the server.
 *
 * A restart interrupts every agent running in the office, so a cross-site form
 * post that could trigger one is a real thing to refuse - hence the same origin
 * check the other writing routes use.
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

  const result = await requestRestart(accountId, instanceId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
