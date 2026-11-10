import { auth } from "../../../../auth";
import {
  checkTrustedOrigin,
  hostedPortalFor,
} from "../../../../lib/services.server";
import {
  billingPortalLimiter,
  limitRequest,
} from "../../../../lib/rate-limit.server";

export const dynamic = "force-dynamic";

/** A Stripe customer portal session for the signed-in owner of a Hosted
 * office, where the card is updated and the open invoice paid: the page goes
 * to its URL. An office that is not yours answers like one with no
 * subscription, so a stranger learns nothing about which offices exist. */
export async function POST(request: Request): Promise<Response> {
  const limited = limitRequest(billingPortalLimiter, request);
  if (limited) return limited;
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });

  const accountId = (await auth())?.accountId;
  if (!accountId) return new Response("not signed in", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    instanceId?: unknown;
  } | null;
  const instanceId =
    typeof body?.instanceId === "string" ? body.instanceId : "";
  if (!instanceId) return new Response("bad request", { status: 400 });

  const result = await hostedPortalFor(accountId, instanceId);
  if (result.ok) return Response.json(result);
  return Response.json(
    {
      ok: false,
      reason: result.reason === "stripe" ? "stripe" : "not_found",
    },
    { status: 409 },
  );
}
