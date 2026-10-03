import { fail, ok, type RouteHandler } from "../executor.ts";
import {
  AGENT_REFERENCE_VERSION,
  agentReferenceContent,
  agentReferenceTopics,
} from "../../agent-reference.ts";

export function agentReferenceHandlers(): Record<string, RouteHandler> {
  return {
    "agentReference.list": ({ identity }) => {
      const topics = agentReferenceTopics(identity);
      return topics
        ? ok({ version: AGENT_REFERENCE_VERSION, topics })
        : fail(403, "forbidden", "This identity cannot read agent references.");
    },
    "agentReference.get": ({ identity, params }) => {
      const markdown = agentReferenceContent(identity, params.topic);
      if (markdown === null)
        return fail(
          403,
          "forbidden",
          "This identity cannot read agent references.",
        );
      if (markdown === undefined)
        return fail(404, "reference_not_found", "Unknown reference topic.");
      return ok({ version: AGENT_REFERENCE_VERSION, topic: params.topic, markdown });
    },
  };
}
