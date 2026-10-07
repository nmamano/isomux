import { handlers } from "../../../../auth";
import { withAuthLimit } from "../../../../lib/rate-limit.server";

export const GET = withAuthLimit(handlers.GET);
export const POST = withAuthLimit(handlers.POST);
