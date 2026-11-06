import {
  incidentCaller,
  json,
} from "../../../../../../../lib/incident-request.server";
import { remakeStatusLinkFor } from "../../../../../../../lib/services.server";

export const dynamic = "force-dynamic";

/** An operator re-makes a customer's status link; old links stop working. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const caller = await incidentCaller(request, {
    allowKey: false,
    allowSession: true,
  });
  if ("refused" in caller) return caller.refused;
  if (!("accountId" in caller))
    return new Response("not found", { status: 404 });
  const { id } = await context.params;
  const made = await remakeStatusLinkFor(caller.accountId, id);
  if (!made) return new Response("not found", { status: 404 });
  return json(made);
}
