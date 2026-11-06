import {
  incidentCaller,
  jsonBody,
  postAnswer,
} from "../../../../../../lib/incident-request.server";
import { postIncidentUpdateFor } from "../../../../../../lib/services.server";

type IncidentUpdateInput = Parameters<typeof postIncidentUpdateFor>[2];

export const dynamic = "force-dynamic";

/** Post an update to an issue (IncidentUpdateInput), with the write key or as
 * an operator. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const caller = await incidentCaller(request, {
    allowKey: true,
    allowSession: true,
  });
  if ("refused" in caller) return caller.refused;
  const { id } = await context.params;
  const body = await jsonBody(request);
  if (!body) return new Response("bad request", { status: 400 });
  return postAnswer(
    await postIncidentUpdateFor(caller, id, body as IncidentUpdateInput),
    "key" in caller,
  );
}
