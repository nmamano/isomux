// T0 unit tier: the pendingPrompt derivation (task 29daebe2).
//
// Only ONE of the four prompt kinds is reachable through the integration tests
// (a permission prompt is the only one a backend raises; the other three are
// user-initiated slash commands). Without this file three of the four enum
// cases could break silently, and the field's whole job is telling an operator
// WHICH answer an agent is waiting for.
//
// Precedence is asserted deliberately rather than incidentally: the flags are
// not mutually exclusive in the type, so the order has to be a decision.
import { describe, expect, it } from "bun:test";

import { inMultiStepFlow, pendingPromptOf } from "./internal-types.ts";
import type { ManagedAgent } from "./internal-types.ts";

// Only the four pending-* fields matter here; the rest of ManagedAgent is
// irrelevant to a pure derivation over them.
function agentWith(flags: Partial<ManagedAgent>): ManagedAgent {
  return {
    pendingPermission: null,
    pendingResume: false,
    pendingModelPick: false,
    pendingEffortPick: false,
    ...flags,
  } as ManagedAgent;
}

const permission: ManagedAgent["pendingPermission"] = {
  approvalId: "a1",
  toolName: "Bash",
  inputSummary: {},
  allowPersistent: false,
};

describe("pendingPromptOf", () => {
  it("names each prompt, null when not parked, and agrees with inMultiStepFlow", () => {
    // The two derive from the same parked states and are read by different
    // callers (the queue gates use the boolean, the wire uses the enum). They
    // must never disagree about whether an agent is parked.
    const cases: [Partial<ManagedAgent>, ReturnType<typeof pendingPromptOf>][] =
      [
        [{}, null],
        [{ pendingPermission: permission }, "permission"],
        [{ pendingResume: true }, "resume"],
        [{ pendingModelPick: true }, "model"],
        [{ pendingEffortPick: true }, "effort"],
        [
          {
            pendingInteraction: {
              id: "interaction-1",
              agentId: "agent-1",
              kind: "cronjob",
              title: "Choose a schedule",
              instruction: "Choose",
              choices: [],
            },
          },
          "cronjob",
        ],
      ];
    for (const [flags, kind] of cases) {
      const managed = agentWith(flags);
      expect({
        prompt: pendingPromptOf(managed),
        parked: inMultiStepFlow(managed),
      }).toEqual({ prompt: kind, parked: kind !== null });
    }
  });

  it("reports permission first when flags overlap", () => {
    // A permission prompt is the one raised by the BACKEND rather than by the
    // user, so it is the one an operator needs to know about: the other three
    // mean someone typed a slash command and already knows they were asked.
    expect(
      pendingPromptOf(
        agentWith({
          pendingPermission: permission,
          pendingResume: true,
          pendingModelPick: true,
          pendingEffortPick: true,
        }),
      ),
    ).toBe("permission");
  });
});
