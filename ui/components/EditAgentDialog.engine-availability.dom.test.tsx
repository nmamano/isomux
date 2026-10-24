// An engine the office host cannot run (full_state.unavailableEngines; OpenCode
// off Linux) shows as unavailable in the agent dialog, and its model list is
// never requested. The context menu and cronjob dialog are covered in
// engine-availability.dom.test.tsx. Also what a new Codex or Claude agent, or
// one switched to Codex or Claude, is saved with.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const {
  CODEX_MODELS,
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_EFFORT,
  MODEL_FAMILIES,
} = await import("../../shared/types.ts");
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
    topicGenerating: false,
    customInstructions: "",
    customInstructionsVersion: "v1",
    agentType,
    capabilities: DEFAULT_AGENT_CAPABILITIES,
    userId: "u1",
    manager: "Tester",
    queue: [],
    sessionSwapping: false,
    turnMemberIds: [],
  };
}

// Records every request and each agent write's body; answers the few requests
// the dialogs make on open.
function shimRequests(): {
  requests: string[];
  writes: { method: string; body: unknown }[];
} {
  const requests: string[] = [];
  const writes: { method: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    requests.push(`${method} ${path}`);
    if (method !== "GET" && path.startsWith("/api/agents"))
      writes.push({ method, body });
    if (path === "/api/validate/cwd") return { ok: true };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "v1", size: 0, cap: 5000 };
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    if (path.startsWith("/api/backends/")) return { models: [] };
    return {};
  });
  return { requests, writes };
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

const saveButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].at(-1)!;

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

  for (const [label, unavailable] of [
    ["available", {}],
    ["unavailable", NO_OPENCODE],
  ] as const) {
    it(`an existing OpenCode agent keeps its engine when OpenCode is ${label}, and loads models only when available`, async () => {
      const { requests } = shimRequests();
      const agent = agentOn("opencode");
      const view = render(
        onLanguage(
          "en",
          <EditAgentDialog onClose={() => {}} agent={agent} />,
          stateWith(unavailable, [agent]),
        ),
      );
      try {
        await settle();
        expect(
          requests.filter((r) => r.includes("/api/backends/opencode/models")),
        ).toHaveLength(unavailable === NO_OPENCODE ? 0 : 1);
        const select = view.container.querySelector(
          ".agent-engine-control select",
        ) as HTMLSelectElement;
        expect(engineOption(select, "opencode").disabled).toBe(false);
        // OpenCode's two modes, and no other engine's.
        const modes = [...view.container.querySelectorAll("select")].find(
          (candidate) =>
            [...candidate.options].some((o) => o.value === "bypassPermissions"),
        )!;
        expect([...modes.options].map((o) => o.value)).toStrictEqual([
          "default",
          "bypassPermissions",
        ]);
        if (unavailable === NO_OPENCODE)
          expect(saveButton(view.container).disabled).toBe(false);
      } finally {
        view.unmount();
      }
    });
  }
});

// Full access without approval prompts, whether the agent is new or switched.
describe("Codex defaults", () => {
  it("a new Codex agent is spawned with full access and no approval prompts", async () => {
    const { writes } = shimRequests();
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog
          onClose={() => {}}
          deskIndex={0}
          roomId={room.id}
          defaultCwd="~"
          spawnAgentType="codex"
        />,
        stateWith({}, []),
      ),
    );
    try {
      await settle();
      await act(async () => {
        fireEvent.click(saveButton(view.container));
      });
      await settle();
      expect(writes.map((w) => w.method)).toStrictEqual(["POST"]);
      expect(writes[0].body).toMatchObject({
        agentType: "codex",
        permissionMode: "never",
        codexSandbox: "danger-full-access",
      });
    } finally {
      view.unmount();
    }
  });

  it("a Claude agent switched to Codex saves the seeded Codex values", async () => {
    const { writes } = shimRequests();
    const agent = agentOn("claude");
    const view = render(
      onLanguage(
        "en",
        <EditAgentDialog onClose={() => {}} agent={agent} />,
        stateWith({}, [agent]),
      ),
    );
    try {
      await settle();
      const select = view.container.querySelector(
        ".agent-engine-control select",
      ) as HTMLSelectElement;
      await act(async () => {
        fireEvent.change(select, { target: { value: "codex" } });
      });
      await settle();
      await act(async () => {
        fireEvent.click(saveButton(view.container));
      });
      await settle();
      expect(writes).toStrictEqual([
        {
          method: "PATCH",
          body: {
            agentType: "codex",
            modelFamily: CODEX_MODELS[0].value,
            effort: DEFAULT_EFFORT,
            permissionMode: "never",
            codexSandbox: "danger-full-access",
          },
        },
      ]);
    } finally {
      view.unmount();
    }
  });
});

// Task f49289bd: a new Claude agent, or one switched to Claude, is saved in
// Bypass, also where the default family has no Auto (which used to give Ask).
describe("Claude defaults", () => {
  const limitedCases = [[MODEL_FAMILIES[0].family], []];
  // The mode picker offers Auto only where the family has it.
  const offersAuto = (container: HTMLElement) =>
    [...container.querySelectorAll("select")].some(
      (select) =>
        [...select.options].some((o) => o.value === "acceptEdits") &&
        [...select.options].some((o) => o.value === "auto"),
    );

  it("a new Claude agent is spawned in Bypass on any family", async () => {
    for (const limited of limitedCases) {
      const { writes } = shimRequests();
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
          {
            ...stateWith({}, []),
            sessionContext: {
              userId: "u1",
              username: "Tester",
              role: "owner",
              currentSessionPrefix: "00000000",
              connectionId: "c1",
              limitedClaudeFamilies: limited,
            },
          },
        ),
      );
      try {
        await settle();
        expect(offersAuto(view.container)).toBe(limited.length === 0);
        await act(async () => {
          fireEvent.click(saveButton(view.container));
        });
        await settle();
        expect(writes.map((w) => w.method)).toStrictEqual(["POST"]);
        expect(writes[0].body).toMatchObject({
          agentType: "claude",
          modelFamily: MODEL_FAMILIES[0].family,
          permissionMode: "bypassPermissions",
        });
      } finally {
        view.unmount();
      }
    }
  });

  it("a Codex agent switched to Claude saves Bypass on any family", async () => {
    for (const limited of limitedCases) {
      const { writes } = shimRequests();
      const agent = { ...agentOn("codex"), limitedClaudeFamilies: limited };
      const view = render(
        onLanguage(
          "en",
          <EditAgentDialog onClose={() => {}} agent={agent} />,
          stateWith({}, [agent]),
        ),
      );
      try {
        await settle();
        const select = view.container.querySelector(
          ".agent-engine-control select",
        ) as HTMLSelectElement;
        await act(async () => {
          fireEvent.change(select, { target: { value: "claude" } });
        });
        await settle();
        expect(offersAuto(view.container)).toBe(limited.length === 0);
        await act(async () => {
          fireEvent.click(saveButton(view.container));
        });
        await settle();
        expect(writes.map((w) => w.method)).toStrictEqual(["PATCH"]);
        expect(writes[0].body).toMatchObject({
          agentType: "claude",
          modelFamily: MODEL_FAMILIES[0].family,
          permissionMode: "bypassPermissions",
        });
      } finally {
        view.unmount();
      }
    }
  });
});
