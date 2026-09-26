// An engine the office host cannot run (full_state.unavailableEngines; OpenCode
// off Linux) shows as unavailable in the agent dialog, and its model list is
// never requested. The context menu and cronjob dialog are covered in
// engine-availability.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { DEFAULT_AGENT_CAPABILITIES } = await import("../../shared/types.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type UnavailableEngines = import("../../shared/types.ts").UnavailableEngines;

const NO_OPENCODE: UnavailableEngines = { opencode: "needs_linux" };
const room = {
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
};

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

function stateWith(
  unavailableEngines: UnavailableEngines,
  agents: AgentInfo[],
) {
  return {
    rooms: [room],
    agents,
    hasReceivedInitialState: true,
    unavailableEngines,
  };
}

function engineCard(container: HTMLElement, engine: string): HTMLButtonElement {
  const card = [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".spawn-engine-options button",
    ),
  ].find((button) => button.textContent?.startsWith(engine));
  if (!card) throw new Error(`no ${engine} engine card`);
  return card;
}

function engineOption(
  select: HTMLSelectElement,
  engine: string,
): HTMLOptionElement {
  const option = [...select.options].find((o) => o.value === engine);
  if (!option) throw new Error(`no ${engine} option`);
  return option;
}

describe("spawn dialog", () => {
  it("the OpenCode card is disabled, with the reason in place of its blurb, only when OpenCode is unavailable", async () => {
    const cards: { disabled: boolean; text: string }[] = [];
    for (const unavailable of [{}, NO_OPENCODE]) {
      shimRequests();
      const view = render(
        onLanguage(
          "en",
          <EditAgentDialog
            onClose={() => {}}
            deskIndex={0}
            roomId={room.id}
            defaultCwd="~"
            spawnAgentType="claude"
          />,
          stateWith(unavailable, []),
        ),
      );
      try {
        await settle();
        const openCode = engineCard(view.container, "OpenCode");
        expect(engineCard(view.container, "Codex").disabled).toBe(false);
        cards.push({
          disabled: openCode.disabled,
          text: openCode.textContent ?? "",
        });
      } finally {
        view.unmount();
      }
    }
    expect(cards.map((card) => card.disabled)).toEqual([false, true]);
    expect(cards[0].text).not.toBe(cards[1].text);
  });
});

describe("edit dialog", () => {
  it("a Claude agent cannot switch to an unavailable OpenCode", async () => {
    shimRequests();
    const agent = agentOn("claude");
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog onClose={() => {}} agent={agent} />,
        stateWith(NO_OPENCODE, [agent]),
      ),
    );
    try {
      await settle();
      const select = view.container.querySelector(
        ".agent-engine-control select",
      ) as HTMLSelectElement;
      expect(engineOption(select, "opencode").disabled).toBe(true);
      expect(engineOption(select, "codex").disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("an existing OpenCode agent keeps its engine, skips model discovery and can still save", async () => {
    const requests = shimRequests();
    const agent = agentOn("opencode");
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog onClose={() => {}} agent={agent} />,
        stateWith(NO_OPENCODE, [agent]),
      ),
    );
    try {
      await settle();
      expect(requests.filter((r) => r.includes("/api/backends/"))).toEqual([]);
      const select = view.container.querySelector(
        ".agent-engine-control select",
      ) as HTMLSelectElement;
      expect(engineOption(select, "opencode").disabled).toBe(false);
      const save = [...view.container.querySelectorAll("button")].at(-1)!;
      expect(save.disabled).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("an available OpenCode loads its models", async () => {
    const requests = shimRequests();
    const agent = agentOn("opencode");
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog onClose={() => {}} agent={agent} />,
        stateWith({}, [agent]),
      ),
    );
    try {
      await settle();
      expect(
        requests.filter((r) => r.includes("/api/backends/opencode/models")),
      ).toHaveLength(1);
    } finally {
      view.unmount();
    }
  });
});
