// What the enterprise account routes share: the limiter, the origin check and
// the session, in that order, and the HTTP answer for a domain result.

import { auth } from "../auth";
import { enterpriseLimiter, limitRequest } from "./rate-limit.server";
import { checkTrustedOrigin } from "./services.server";

const NO_STORE = { "cache-control": "no-store" };

/** The signed-in account and its JSON body (null when it is not a JSON
 * object), or the refusal to answer with. */
export async function enterpriseCaller(
  request: Request,
): Promise<
  | { accountId: string; body: Record<string, unknown> | null }
  | { refused: Response }
> {
  // First, before the origin, the session and the body.
  const limited = limitRequest(enterpriseLimiter, request);
  if (limited) return { refused: limited };
  const trusted = await checkTrustedOrigin(request.headers.get("origin"));
  if (!trusted.ok) {
    return { refused: new Response(trusted.reason, { status: 403 }) };
  }
  const accountId = (await auth())?.accountId;
  if (!accountId) {
    return { refused: new Response("not signed in", { status: 401 }) };
  }
  const body: unknown = await request.json().catch(() => null);
  return {
    accountId,
    body:
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null,
  };
}

/** 200 when ok, 400 for a bad field, 409 for every other refusal. */
export function enterpriseAnswer(
  result: { ok: true } | { ok: false; reason: string },
): Response {
  const status = result.ok ? 200 : result.reason === "invalid" ? 400 : 409;
  return Response.json(result, { status, headers: NO_STORE });
}

/** A body that is not a JSON object. */
export function notJson(): Response {
  return Response.json(
    { ok: false, reason: "invalid" },
    { status: 400, headers: NO_STORE },
  );
}
