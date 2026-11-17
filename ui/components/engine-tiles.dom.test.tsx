// The engine is one setting, so it has one control (AGENTS.md "UI rules";
// task ff602b30): the option tiles, each with its hint, in the New agent
// dialog, on the Agent settings page and in the schedule dialog. What each
// place disables is in EditAgentDialog.engine-availability.dom.test.tsx,
// engine-availability.dom.test.tsx and EditAgentDialog.access-slider.dom.test.tsx;
// here, that the three places draw the same control, that a pick switches the
// engine, and the cases of an engine the host cannot run that are kept.
import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { EditAgentDialog } = await import("./EditAgentDialog.tsx");
const { CronjobDialog } = await import("./CronjobDialog.tsx");
const { settingsAt } = await import("../test-support/settings-item.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { ENGINE_OPTIONS } = await import("../engine-options.ts");
const { DEFAULT_AGENT_CAPABILITIES, DEFAULT_EFFORT } =
  await import("../../shared/types.ts");
const { ENGINES, engineGroup, engineTile, pickEngine, pressedEngines } =
  await import("../test-support/engine-tiles.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AgentBackendType = import("../../shared/types.ts").AgentBackendType;
type CronjobListWire = import("../../shared/types.ts").CronjobListWire;
type UnavailableEngines = import("../../shared/types.ts").UnavailableEngines;

const NO_OPENCODE: UnavailableEngines = { opencode: "needs_linux" };
const room = {
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
};

function agentOn(agentType: AgentBackendType): AgentInfo {
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
    topicState: null,
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

function scheduleOn(agentType: AgentBackendType): CronjobListWire {
  return {
    id: "c0ffee03",
    name: "Nightly",
    schedule: { type: "interval", minutes: 60 },
    prompt: "Run the health check.",
    cwd: "~",
    agentType,
    modelFamily: agentType === "opencode" ? "opencode/some-model" : "opus",
    effort: "high",
    permissionMode: "bypassPermissions",
    enabled: true,
    createdBy: "Tester",
    userId: "u1",
    username: "Tester",
    createdAt: 1,
    lastFireAt: null,
    nextFireAt: 2,
    canManage: true,
  };
}

const CODEX_MODEL = "m-codex";
let cronWrites: { method: string; body: unknown }[] = [];
setApiShim(async (method, path, body) => {
  if (path === "/api/validate/cwd") return { ok: true };
  if (path.startsWith("/api/memory"))
    return { text: "", version: "v1", size: 0, cap: 5000 };
  if (path.includes("/sessions"))
    return { sessions: [], currentSessionId: null };
  if (path === "/api/backends/codex/models")
    return {
      models: [
        {
          id: CODEX_MODEL,
          label: "Codex model",
          isDefault: true,
          supportedEfforts: [{ level: DEFAULT_EFFORT }],
        },
      ],
    };
  if (path.startsWith("/api/backends/")) return { models: [] };
  if (path.startsWith("/api/cronjobs")) {
    cronWrites.push({ method, body });
    return {};
  }
  return {};
});
afterAll(() => setApiShim(null));

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

type Place = "spawn" | "settings" | "schedule";

function renderAt(
  place: Place,
  engine: AgentBackendType = "claude",
  unavailable: UnavailableEngines = {},
) {
  const agent = agentOn(engine);
  const element =
    place === "spawn" ? (
      <EditAgentDialog
        onClose={() => {}}
        deskIndex={0}
        roomId={room.id}
        defaultCwd="~"
        spawnAgentType={engine}
      />
    ) : place === "settings" ? (
      settingsAt({ kind: "agent", agentId: agent.id, part: "engine" })
    ) : (
      <CronjobDialog
        onClose={() => {}}
        {...(engine === "claude" ? {} : { cronjob: scheduleOn(engine) })}
      />
    );
  return render(
    onLanguage(
      "en",
      element,
      stateWith(unavailable, place === "settings" ? [agent] : []),
    ),
  );
}

// What a member reads on each tile, by engine.
function tileTexts(root: ParentNode): Record<string, string> {
  return Object.fromEntries(
    ENGINES.map((engine) => [engine, engineTile(root, engine).textContent]),
  );
}

describe("one engine control", () => {
  it("the New agent dialog, Agent settings and the schedule dialog draw the same labelled tile group, each tile with a hint", async () => {
    const seen: Record<string, unknown>[] = [];
    for (const place of ["spawn", "settings", "schedule"] as const) {
      const view = renderAt(place);
      try {
        await settle();
        const group = engineGroup(view.container);
        const labelId = group.getAttribute("aria-labelledby") ?? "";
        const label = labelId ? document.getElementById(labelId) : null;
        const tiles = [...group.querySelectorAll("button")];
        seen.push({
          place,
          role: group.getAttribute("role"),
          labelled: (label?.textContent ?? "").trim().length > 0,
          labelInView: label !== null && view.container.contains(label),
          engines: tiles.map((tile) => tile.dataset.engine),
          types: tiles.map((tile) => tile.getAttribute("type")),
          pressed: pressedEngines(view.container),
          texts: tileTexts(view.container),
        });
      } finally {
        view.unmount();
      }
    }
    const [spawn] = seen;
    for (const place of seen)
      expect(place).toEqual({
        ...spawn,
        place: place.place,
      });
    expect(spawn).toMatchObject({
      role: "group",
      labelled: true,
      labelInView: true,
      engines: [...ENGINES],
      types: ENGINES.map(() => "button"),
      pressed: ["claude"],
    });
    // Each tile is the engine's name with its own hint after it.
    const texts = spawn.texts as Record<string, string>;
    const hints = ENGINE_OPTIONS.map((option) => {
      const text = texts[option.agentType];
      expect(text.startsWith(option.label)).toBe(true);
      return text.slice(option.label.length).trim();
    });
    expect(hints.every((hint) => hint.length > 0)).toBe(true);
    expect(new Set(hints).size).toBe(hints.length);
  });
});

describe("Agent settings", () => {
  // The switch hint: a line in the engine field, outside the tiles.
  const switchHints = (root: ParentNode) =>
    [
      ...(root.querySelector(".agent-engine-control")?.querySelectorAll("p") ??
        []),
    ].filter((line) => !line.closest(".engine-options")).length;

  it("a tile pick switches the engine and shows the switch hint; the saved engine's tile takes it back", async () => {
    const view = renderAt("settings");
    try {
      await settle();
      expect(pressedEngines(view.container)).toEqual(["claude"]);
      expect(switchHints(view.container)).toBe(0);
      await pickEngine(view.container, "codex");
      expect(pressedEngines(view.container)).toEqual(["codex"]);
      expect(switchHints(view.container)).toBe(1);
      await pickEngine(view.container, "claude");
      expect(pressedEngines(view.container)).toEqual(["claude"]);
      expect(switchHints(view.container)).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("an OpenCode agent on a host without OpenCode keeps its tile pickable, with the reason in place of the hint", async () => {
    const seen: { disabled: boolean; pressed: string[]; text: string }[] = [];
    for (const unavailable of [{}, NO_OPENCODE]) {
      const view = renderAt("settings", "opencode", unavailable);
      try {
        await settle();
        const tile = engineTile(view.container, "opencode");
        seen.push({
          disabled: tile.disabled,
          pressed: pressedEngines(view.container),
          text: tile.textContent ?? "",
        });
      } finally {
        view.unmount();
      }
    }
    expect(
      seen.map(({ disabled, pressed }) => ({ disabled, pressed })),
    ).toEqual([
      { disabled: false, pressed: ["opencode"] },
      { disabled: false, pressed: ["opencode"] },
    ]);
    expect(seen[0].text).not.toBe(seen[1].text);
  });
});

describe("schedule dialog", () => {
  it("on a host without OpenCode, an OpenCode schedule keeps its tile pickable with the reason; a Claude schedule cannot pick it", async () => {
    const seen: Record<string, unknown>[] = [];
    for (const [engine, unavailable] of [
      ["opencode", {}],
      ["opencode", NO_OPENCODE],
      ["claude", NO_OPENCODE],
    ] as const) {
      const view = render(
        onLanguage(
          "en",
          <CronjobDialog onClose={() => {}} cronjob={scheduleOn(engine)} />,
          stateWith(unavailable, []),
        ),
      );
      try {
        await settle();
        const tile = engineTile(view.container, "opencode");
        seen.push({
          engine,
          pressed: pressedEngines(view.container),
          disabled: tile.disabled,
          text: tile.textContent,
        });
      } finally {
        view.unmount();
      }
    }
    expect(seen.map(({ text: _text, ...rest }) => rest)).toEqual([
      { engine: "opencode", pressed: ["opencode"], disabled: false },
      { engine: "opencode", pressed: ["opencode"], disabled: false },
      { engine: "claude", pressed: ["claude"], disabled: true },
    ]);
    expect(seen[0].text).not.toBe(seen[1].text);
    expect(seen[2].text).toBe(seen[1].text);
  });

  it("a Codex pick on a new schedule saves Codex with Codex's defaults, not the Claude values it opened with", async () => {
    cronWrites = [];
    const view = renderAt("schedule");
    try {
      await settle();
      await pickEngine(view.container, "codex");
      await waitFor(() =>
        expect(
          view.container.querySelector(`option[value="${CODEX_MODEL}"]`)
            ?.parentElement instanceof HTMLSelectElement,
        ).toBe(true),
      );
      const prompt = view.container.querySelector("textarea")!;
      await act(async () => {
        fireEvent.change(prompt, {
          target: { value: "Run the health check." },
        });
      });
      const buttons = [...view.container.querySelectorAll("button")];
      await act(async () => {
        fireEvent.click(buttons.at(-1)!);
      });
      await waitFor(() => expect(cronWrites.length).toBe(1));
      expect(cronWrites[0]).toMatchObject({
        method: "POST",
        body: {
          agentType: "codex",
          modelFamily: CODEX_MODEL,
          effort: DEFAULT_EFFORT,
          permissionMode: "never",
        },
      });
    } finally {
      view.unmount();
    }
  });
});
