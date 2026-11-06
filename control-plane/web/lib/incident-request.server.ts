// What the critical-issue routes share: the limiter, the two ways in (the
// write key, or an operator's session from this site), and the HTTP answer
// for each refusal.

import { auth } from "../auth";
import { incidentLimiter, limitRequest } from "./rate-limit.server";
import {
  checkTrustedOrigin,
  type IncidentPostOutcome,
} from "./services.server";

const NO_STORE = { "cache-control": "no-store" };

/** The caller: the write key, a signed-in account, or a refusal. With an
 * Authorization header the key is the only way in: a bad key is 401, never a
 * fall-through to the session cookie. */
export type IncidentCaller =
  | { key: string }
  | { accountId: string }
  | { refused: Response };

export async function incidentCaller(
  request: Request,
  options: { allowKey: boolean; allowSession: boolean },
): Promise<IncidentCaller> {
  // First, before the key, the session and the body.
  const limited = limitRequest(incidentLimiter, request);
  if (limited) return { refused: limited };
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization.trim());
    if (!options.allowKey || !match) {
      return { refused: new Response("unauthorized", { status: 401 }) };
    }
    return { key: match[1] };
  }
  if (!options.allowSession) {
    return { refused: new Response("unauthorized", { status: 401 }) };
  }
  if (request.method !== "GET") {
    const trusted = await checkTrustedOrigin(request.headers.get("origin"));
    if (!trusted.ok) {
      return { refused: new Response(trusted.reason, { status: 403 }) };
    }
  }
  const session = await auth();
  const accountId = session?.accountId;
  if (!accountId) {
    return { refused: new Response("not signed in", { status: 401 }) };
  }
  return { accountId };
}

/** The JSON body, or null when it is not a JSON object. */
export async function jsonBody(request: Request): Promise<unknown> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body
    : null;
}

/** Null is a bad key (401) or a non-operator (404, the same as a missing
 * issue: the ops floor does not say it exists). */
export function postAnswer(
  outcome: IncidentPostOutcome | null,
  byKey: boolean,
): Response {
  if (!outcome) {
    return byKey
      ? new Response("unauthorized", { status: 401 })
      : new Response("not found", { status: 404 });
  }
  if (outcome.ok) return Response.json(outcome, { headers: NO_STORE });
  const status =
    outcome.refused === "not_found"
      ? 404
      : outcome.refused === "resolved"
        ? 409
        : 400;
  return Response.json(outcome, { status, headers: NO_STORE });
}

export function json(body: unknown): Response {
  return Response.json(body, { headers: NO_STORE });
}
