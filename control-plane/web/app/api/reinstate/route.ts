import { auth } from "../../../auth";
import {
  checkTrustedOrigin,
  reinstateOffice,
} from "../../../lib/services.server";

import { languageForRequest } from "../../../lib/i18n/request.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) return new Response(trusted.reason, { status: 403 });
  const session = await auth();
  if (!session?.accountId) return Response.json({ ok: false }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    instanceId?: unknown;
  };
  if (typeof body.instanceId !== "string")
    return Response.json({ ok: false }, { status: 400 });
  const language = await languageForRequest();
  const result = await reinstateOffice(
    language,
    session.accountId,
    body.instanceId,
  );
  return result.ok
    ? Response.json(result)
    : Response.json(result, { status: 409 });
}
