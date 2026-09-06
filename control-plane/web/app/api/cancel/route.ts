import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  requestCancel,
} from "../../../lib/services.server";

import { languageForRequest } from "../../../lib/i18n/request.server";

export const dynamic = "force-dynamic";

/**
 * Ends (or un-ends) the subscription at the period end.
 *
 * The same origin check as every other writing route: this one spends nothing,
 * but a cross-site form that could cancel somebody's office on the strength of
 * their cookie is exactly the thing the check exists for.
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

  const language = await languageForRequest();
  const result = await requestCancel(language, accountId, instanceId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
