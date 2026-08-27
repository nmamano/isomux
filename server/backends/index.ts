// Backend registry. agent-manager calls `getBackend(agent.agentType)` to
// route session/forkSession/topic-gen/etc. calls to the right engine.
//
// The Backend interface contract is verified against claudeBackend at
// compile time.

import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "./types.ts";
import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex/adapter.ts";

export function getBackend(agentType: AgentBackendType): Backend {
  switch (agentType) {
    case "claude":
      return claudeBackend;
    case "codex":
      return codexBackend;
    default: {
      const _exhaustive: never = agentType;
      throw new Error(`Unknown agentType: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
