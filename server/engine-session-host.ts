// The store of server/engine-session-store.ts on an agent's host: in this
// process on the local host, through the runner's fixed entries (as the
// agent user, or as the member) on a runner host.
import { inAgentSpace, type AgentHost } from "./agent-host.ts";
import {
  keepSessionFiles,
  prepareResume,
  type KeepInput,
  type SessionFilesPrepare,
} from "./engine-session-store.ts";

export function keepOnHost(
  host: AgentHost,
  input: KeepInput,
): Promise<unknown> {
  return inAgentSpace(
    "engine-session-keep",
    input,
    () => keepSessionFiles(input),
    host,
  );
}

export function prepareOnHost(
  host: AgentHost,
  input: SessionFilesPrepare,
): Promise<unknown> {
  return inAgentSpace(
    "engine-session-prepare",
    input,
    () => prepareResume(input),
    host,
  );
}
