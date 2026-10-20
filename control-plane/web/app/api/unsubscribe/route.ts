import {
  handleUnsubscribeGet,
  handleUnsubscribePost,
} from "../../../lib/unsubscribe-request.server";
import { unsubscribeWelcomeMail } from "../../../lib/services.server";

export const dynamic = "force-dynamic";

/** The welcome series opt-out. See lib/unsubscribe-request.server.ts. */
export async function POST(request: Request): Promise<Response> {
  return handleUnsubscribePost(request, {
    unsubscribe: unsubscribeWelcomeMail,
  });
}

export function GET(request: Request): Response {
  return handleUnsubscribeGet(request);
}
