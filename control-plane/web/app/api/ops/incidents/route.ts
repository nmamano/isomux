import {
  incidentCaller,
  json,
  jsonBody,
  postAnswer,
} from "../../../../lib/incident-request.server";
import {
  incidentsForKey,
  openIncidentFor,
} from "../../../../lib/services.server";

type OpenIncidentInput = Parameters<typeof openIncidentFor>[1];

export const dynamic = "force-dynamic";

/** The open issues for the write key; with ?due=1 only those whose last
 * update is 40 minutes old or more. The office reminder polls this. */
export async function GET(request: Request): Promise<Response> {
  const caller = await incidentCaller(request, {
    allowKey: true,
    allowSession: false,
  });
  if ("refused" in caller) return caller.refused;
  if (!("key" in caller)) return new Response("unauthorized", { status: 401 });
  const dueOnly = new URL(request.url).searchParams.get("due") === "1";
  const items = await incidentsForKey(caller.key, dueOnly);
  if (!items) return new Response("unauthorized", { status: 401 });
  return json(items);
}

/** An operator opens an issue with its first update (OpenIncidentInput). */
export async function POST(request: Request): Promise<Response> {
  const caller = await incidentCaller(request, {
    allowKey: false,
    allowSession: true,
  });
  if ("refused" in caller) return caller.refused;
  if (!("accountId" in caller))
    return new Response("not found", { status: 404 });
  const body = await jsonBody(request);
  if (!body) return new Response("bad request", { status: 400 });
  return postAnswer(
    await openIncidentFor(caller.accountId, body as OpenIncidentInput),
    false,
  );
}
