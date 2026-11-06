import {
  incidentCaller,
  json,
} from "../../../../../lib/incident-request.server";
import { rotateIncidentKeyFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** An operator rotates the write key; the new key is in the answer, once. */
export async function POST(request: Request): Promise<Response> {
  const caller = await incidentCaller(request, {
    allowKey: false,
    allowSession: true,
  });
  if ("refused" in caller) return caller.refused;
  if (!("accountId" in caller))
    return new Response("not found", { status: 404 });
  const made = await rotateIncidentKeyFor(caller.accountId);
  if (!made) return new Response("not found", { status: 404 });
  return json(made);
}
