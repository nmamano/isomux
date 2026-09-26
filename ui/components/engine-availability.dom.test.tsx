// An engine the office host cannot run (full_state.unavailableEngines; OpenCode
// off Linux) shows as unavailable in the context menu and
// the cronjob dialog. The agent dialog is covered in
// EditAgentDialog.engine-availability.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { ContextMenu } = await import("./ContextMenu.tsx");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { reducer, initialState } = await import("../store.tsx");
const { DEFAULT_AGENT_CAPABILITIES } = await import("../../shared/types.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type UnavailableEngines = import("../../shared/types.ts").UnavailableEngines;

const NO_OPENCODE: UnavailableEngines = { opencode: "needs_linux" };
const room = { id: "r1", name: "Studio", prompt: null, canCloseWhenEmpty: true };

function agentOn(agentType: AgentInfo["agentType"]): AgentInfo {
  return {
    id: "a1",
    name: "Saved name",
    roomId: room.id,
    desk: 0,
    cwd: "~",
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: null,
      hat: "none",
    },
    permissionMode: "bypassPermissions",
    modelFamily: agentType === "opencode" ? "opencode/some-model" : "sonnet",
    effort: "high",
    state: "idle",
    topic: null,
    topicStale: false,
    customInstructions: "",
    customInstructionsVersion: "v1",
    agentType,
    capabilities: DEFAULT_AGENT_CAPABILITIES,
    userId: "u1",
    username: "Tester",
    queue: [],
    sessionSwapping: false,
    turnHadHumanInput: false,
  };
}

// Records every request; answers the few the dialogs make on open.
function shimRequests(): string[] {
  const requests: string[] = [];
  setApiShim(async (method, path) => {
    requests.push(`${method} ${path}`);
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    return {};
  });
  return requests;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function stateWith(unavailableEngines: UnavailableEngines, agents: AgentInfo[]) {
  return {
    rooms: [room],
    agents,
    hasReceivedInitialState: true,
    unavailableEngines,
  };
}

function engineOption(
  select: HTMLSelectElement,
  engine: string,
): HTMLOptionElement {
  const option = [...select.options].find((o) => o.value === engine);
  if (!option) throw new Error(`no ${engine} option`);
  return option;
}

describe("full_state carries the unavailable engines", () => {
  const base = {
    type: "full_state" as const,
    agents: [],
    recentCwds: [],
    office: { prompt: null, name: null },
    rooms: [],
    killedAgents: [],
  };

  it("stores them, and an older server's full_state means none", () => {
    expect(
      reducer(initialState, { ...base, unavailableEngines: NO_OPENCODE })
        .unavailableEngines,
    ).toEqual(NO_OPENCODE);
    const stale = { ...initialState, unavailableEngines: NO_OPENCODE };
    expect(reducer(stale, base).unavailableEngines).toEqual({});
  });
});

describe("context menu", () => {
  for (const [label, unavailable] of [
    ["available", {}],
    ["unavailable", NO_OPENCODE],
  ] as const) {
    it(`the new OpenCode conversation item is ${label === "available" ? "enabled" : "disabled"} when OpenCode is ${label}`, async () => {
      shimRequests();
      const agent = agentOn("claude");
      const view = render(
        onLanguage(
          "en",
          <ContextMenu
            x={0}
            y={0}
            agent={agent}
            onClose={() => {}}
            onEdit={() => {}}
          />,
          stateWith(unavailable, [agent]),
        ),
      );
      try {
        await settle();
        const items = [...view.container.querySelectorAll("button")];
        const openCode = items.filter((b) => b.textContent?.includes("OpenCode"));
        const codex = items.filter((b) => b.textContent?.includes("Codex"));
        expect(openCode).toHaveLength(1);
        expect(codex).toHaveLength(1);
        expect(openCode[0].getAttribute("aria-disabled")).toBe(
          unavailable === NO_OPENCODE ? "true" : null,
        );
        expect(codex[0].getAttribute("aria-disabled")).toBeNull();
      } finally {
        view.unmount();
      }
    });
  }
});

describe("cronjob dialog", () => {
  it("a new cronjob cannot pick an unavailable OpenCode", async () => {
    shimRequests();
    const view = render(
      onLanguage(
        "en",
        <CronjobDialog onClose={() => {}} />,
        stateWith(NO_OPENCODE, []),
      ),
    );
    try {
      await settle();
      const select = [...view.container.querySelectorAll("select")].find(
        (s) => [...s.options].some((o) => o.value === "opencode"),
      )!;
      expect(engineOption(select, "opencode").disabled).toBe(true);
      expect(engineOption(select, "codex").disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
