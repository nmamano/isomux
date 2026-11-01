// The pack picker of the agent dialog's access slider (task e77304b1, merge
// B): presets, areas and rooms, where it shows, the engines and Codex models
// a stop allows (merge C1), and the boundary note. What a save sends is in
// EditAgentDialog.access.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentInfo } from "../../shared/types.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const { AGENT_PACK_PRESETS } = await import("../../shared/agent-access.ts");
const {
  BELOW,
  STOPS,
  agentAt,
  areaSelect,
  change,
  cleanup,
  pick,
  presetSelect,
  renderEdit,
  save,
  settle,
  shim,
  stopRadio,
} = await import("../test-support/access-slider-fixture.tsx");

describe("the engine and the stops", () => {
  // engineRunsAccess with the dialog's model: Codex runs chat and office on
  // gpt-5.5 only, OpenCode no stop below Standard.
  it("each engine and model has exactly the stops it can run", async () => {
    const cases: [AgentInfo["agentType"], string, AgentAccess[]][] = [
      ["claude", "opus", []],
      ["codex", "gpt-5.5", ["folder", "web"]],
      ["codex", "gpt-5.6-sol", BELOW],
      ["opencode", "opencode/big-pickle", BELOW],
    ];
    for (const [agentType, modelFamily, off] of cases) {
      shim();
      const view = renderEdit({
        ...agentAt("standard", undefined, agentType),
        modelFamily,
      });
      try {
        await settle();
        const disabled = Object.fromEntries(
          STOPS.map((stop) => [stop, stopRadio(view.container, stop).disabled]),
        );
        expect({ agentType, modelFamily, disabled }).toEqual({
          agentType,
          modelFamily,
          disabled: Object.fromEntries(
            STOPS.map((stop) => [stop, off.includes(stop)]),
          ),
        });
      } finally {
        cleanup(view);
      }
    }
  });

  it("below Standard, the engines that cannot run the stop are disabled", async () => {
    shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      const select = view.container.querySelector<HTMLSelectElement>(
        ".agent-engine-control select",
      )!;
      const engines = () =>
        Object.fromEntries(
          [...select.options].map((o) => [o.value, o.disabled]),
        );
      expect(engines()).toMatchObject({ claude: false, codex: false });
      // Codex runs office on one model.
      await pick(view.container, "office");
      expect(engines()).toMatchObject({
        claude: false,
        codex: false,
        opencode: true,
      });
      await pick(view.container, "folder");
      expect(engines()).toMatchObject({
        claude: false,
        codex: true,
        opencode: true,
      });
    } finally {
      cleanup(view);
    }
  });

  // The model picker of a Codex agent: below Standard only a proven model
  // can be picked, and the stops follow the model picked, not the saved one.
  it("below Standard, a Codex model that is not proven is disabled; the stops follow the picked model", async () => {
    shim();
    const view = renderEdit({
      ...agentAt("standard", undefined, "codex"),
      modelFamily: "gpt-5.6-sol",
    });
    try {
      await settle();
      const models = modelSelect(view.container);
      const disabledModels = () =>
        [...models().options].filter((o) => o.disabled).map((o) => o.value);
      expect(disabledModels()).toEqual([]);
      expect(stopRadio(view.container, "office").disabled).toBe(true);
      await change(models(), "gpt-5.5");
      expect(stopRadio(view.container, "office").disabled).toBe(false);
      await pick(view.container, "office");
      expect(stopRadio(view.container, "office").checked).toBe(true);
      expect(
        [...models().options].filter((o) => !o.disabled).map((o) => o.value),
      ).toEqual(["gpt-5.5"]);
    } finally {
      cleanup(view);
    }
  });

  it("a switch to Codex at office lands on the proven model", async () => {
    shim();
    const view = renderEdit(agentAt("office", AGENT_PACK_PRESETS.asksOnly));
    try {
      await settle();
      const engine = view.container.querySelector<HTMLSelectElement>(
        ".agent-engine-control select",
      )!;
      await change(engine, "codex");
      await settle();
      expect(modelSelect(view.container)().value).toBe("gpt-5.5");
    } finally {
      cleanup(view);
    }
  });
});

// The model select: the one that offers a Codex model.
function modelSelect(container: HTMLElement): () => HTMLSelectElement {
  return () => {
    const select = [...container.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "gpt-5.5"),
    );
    if (!select) throw new Error("no Codex model select");
    return select;
  };
}

describe("the pack picker", () => {
  it("sets each preset's exact areas, and sends them", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await pick(view.container, "office");
      const levels = () =>
        Object.fromEntries(
          (["agents", "logs", "tasks", "asks"] as const)
            .map((area) => [area, areaSelect(view.container, area).value])
            .filter(([, level]) => level !== "none"),
        );
      for (const [preset, pack] of Object.entries(AGENT_PACK_PRESETS)) {
        await change(presetSelect(view.container), preset);
        expect({ preset, areas: levels() }).toEqual({
          preset,
          areas: pack.areas,
        });
      }
      await save(view.container);
      expect(calls[0]?.body).toEqual({
        access: "office",
        pack: AGENT_PACK_PRESETS.talkToAgents,
      });
    } finally {
      cleanup(view);
    }
  });

  it("shows the preset a saved pack matches, whatever its order and rooms", async () => {
    shim();
    const view = renderEdit(
      agentAt("folder", {
        areas: { asks: "write", tasks: "write" },
        rooms: ["r1"],
      }),
    );
    try {
      await settle();
      expect(presetSelect(view.container).value).toBe("tasksAndAsks");
    } finally {
      cleanup(view);
    }
  });

  it("an area edit turns the preset to custom and is sent", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await pick(view.container, "web");
      await change(presetSelect(view.container), "tasksAndAsks");
      await change(areaSelect(view.container, "agents"), "read");
      expect(presetSelect(view.container).value).toBe("custom");
      await change(areaSelect(view.container, "logs"), "read");
      await save(view.container);
      expect(calls[0]?.body).toEqual({
        access: "web",
        pack: {
          areas: {
            tasks: "write",
            asks: "write",
            agents: "read",
            logs: "read",
          },
        },
      });
    } finally {
      cleanup(view);
    }
  });

  it("some rooms sends the picked room ids", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await pick(view.container, "office");
      await change(
        view.container.querySelector('[data-testid="agent-pack-rooms"]')!,
        "some",
      );
      await act(async () => {
        fireEvent.click(
          view.container.querySelector<HTMLInputElement>(
            'input[data-room="r2"]',
          )!,
        );
      });
      await save(view.container);
      expect(calls[0]?.body).toEqual({
        access: "office",
        pack: { ...AGENT_PACK_PRESETS.asksOnly, rooms: ["r2"] },
      });
    } finally {
      cleanup(view);
    }
  });

  it("an area edit keeps the agent's rooms while the room list is not loaded or failed", async () => {
    for (const rooms of ["never"] as const) {
      const calls = shim({ rooms });
      const view = renderEdit(
        agentAt("office", { areas: { asks: "write" }, rooms: ["r2"] }),
      );
      try {
        await settle();
        await change(areaSelect(view.container, "tasks"), "read");
        await save(view.container);
        expect({ rooms, body: calls[0]?.body }).toEqual({
          rooms,
          body: {
            access: "office",
            pack: { areas: { asks: "write", tasks: "read" }, rooms: ["r2"] },
          },
        });
      } finally {
        cleanup(view);
      }
    }
  });

  it("keeps an edited pack while the slider passes through Chat", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("office", AGENT_PACK_PRESETS.asksOnly));
    try {
      await settle();
      await change(areaSelect(view.container, "tasks"), "read");
      await pick(view.container, "chat");
      await pick(view.container, "folder");
      await save(view.container);
      expect(calls[0]?.body).toEqual({
        access: "folder",
        pack: { areas: { asks: "write", tasks: "read" } },
      });
    } finally {
      cleanup(view);
    }
  });

  it("does not send a stale pack the agent kept at Standard", async () => {
    const calls = shim();
    const view = renderEdit(
      agentAt("standard", { areas: { agents: "write", logs: "read" } }),
    );
    try {
      await settle();
      await pick(view.container, "office");
      await save(view.container);
      expect(calls[0]?.body).toEqual({
        access: "office",
        pack: AGENT_PACK_PRESETS.asksOnly,
      });
    } finally {
      cleanup(view);
    }
  });

  it("is shown only at office, folder and web, and warns on logs read only", async () => {
    shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      const shown: Record<string, boolean> = {};
      for (const stop of STOPS) {
        await pick(view.container, stop);
        shown[stop] =
          view.container.querySelector("select[data-pack-preset]") !== null;
      }
      expect(shown).toEqual({
        chat: false,
        office: true,
        folder: true,
        web: true,
        standard: false,
        privileged: false,
      });
      await pick(view.container, "office");
      const warned = () =>
        view.container.querySelector("[data-pack-secrets-warning]") !== null;
      await change(presetSelect(view.container), "talkToAgents");
      expect(warned()).toBe(false);
      await change(areaSelect(view.container, "logs"), "read");
      expect(warned()).toBe(true);
    } finally {
      cleanup(view);
    }
  });
});

describe("the slider", () => {
  it("shows the boundary note at Standard and Privileged only", async () => {
    shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      const noted: Record<string, boolean> = {};
      for (const stop of STOPS) {
        await pick(view.container, stop);
        noted[stop] =
          view.container.querySelector("[data-access-boundary-note]") !== null;
      }
      expect(noted).toEqual({
        chat: false,
        office: false,
        folder: false,
        web: false,
        standard: true,
        privileged: true,
      });
    } finally {
      cleanup(view);
    }
  });
});
