// Backend registry. agent-manager calls `getBackend(agent.agentType)` to
// route session/forkSession/topic-gen/etc. calls to the right engine.
//
// Codex backend lands at step 7; until then only "claude" is wired and
// requesting "codex" throws. The Backend interface contract is verified
// against claudeBackend at compile time.

import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "./types.ts";
import { claudeBackend } from "./claude.ts";

export function getBackend(agentType: AgentBackendType): Backend {
  switch (agentType) {
    case "claude":
      return claudeBackend;
    case "codex":
      throw new Error("Codex backend is not yet wired (planned for step 7 of task f352984f).");
    default: {
      const _exhaustive: never = agentType;
      throw new Error(`Unknown agentType: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
