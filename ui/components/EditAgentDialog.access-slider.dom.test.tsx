// The access slider as a step bar (task 8c60be00, the room view level
// slider reused): the stops in order, the ones up to the chosen one filled,
// and the stops the engine and model cannot run, which stay in the row but
// cannot be picked by click or key. What a save sends is in
// EditAgentDialog.access.dom.test.tsx; which stops each engine runs is in
// EditAgentDialog.pack.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentInfo } from "../../shared/types.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const { AGENT_PACK_PRESETS } = await import("../../shared/agent-access.ts");
const {
  STOPS,
  agentAt,
  cleanup,
  renderEdit,
  save,
  settle,
  shim,
  stopDisabled,
  stopRadio,
} = await import("../test-support/access-slider-fixture.tsx");

function codexAt(access: AgentAccess, modelFamily: string): AgentInfo {
  return {
    ...agentAt(
      access,
      access === "standard" ? undefined : AGENT_PACK_PRESETS.asksOnly,
      "codex",
    ),
    modelFamily,
  };
}

function slider(container: HTMLElement) {
  const group = container.querySelector<HTMLElement>(
    '[role="radiogroup"][data-access-stop]',
  );
  if (!group) throw new Error("no access slider");
  const steps = [
    ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];
  const pick = (attr: string) =>
    steps.filter((s) => s.getAttribute(attr) === "true").map(stopOf);
  return {
    group,
    steps,
    order: steps.map(stopOf),
    checked: pick("aria-checked"),
    filled: pick("data-filled"),
    tabStops: steps.filter((s) => s.tabIndex === 0).map(stopOf),
    titled: steps.filter((s) => s.title !== "").map(stopOf),
  };
}

function stopOf(step: HTMLElement): string {
  return step.getAttribute("data-access-stop") ?? "";
}

function focused() {
  return stopOf(document.activeElement as HTMLElement);
}

async function key(k: string) {
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: k });
  });
}

describe("the access slider", () => {
  it("six stops in order, each named, the chosen one checked, it and the ones below it filled, one tab stop", async () => {
    shim();
    const view = renderEdit(agentAt("web", AGENT_PACK_PRESETS.asksOnly));
    try {
      await settle();
      const s = slider(view.container);
      expect<string[]>(s.order).toEqual(STOPS);
      expect(s.group.dataset.accessStop).toBe("web");
      expect(s.checked).toEqual(["web"]);
      expect(s.filled).toEqual(["chat", "office", "folder", "web"]);
      expect(s.tabStops).toEqual(["web"]);
      // Each step shows the name it is announced by; no two share one.
      const names = s.steps.map(
        (step) => step.getAttribute("aria-label") ?? "",
      );
      expect(s.steps.map((step) => step.textContent ?? "")).toEqual(names);
      expect(names.every((n) => n !== "")).toBe(true);
      expect(new Set(names).size).toBe(STOPS.length);
      // Claude runs every stop: no step is disabled or has a tooltip.
      expect(
        STOPS.filter((stop) => stopDisabled(view.container, stop)),
      ).toEqual([]);
      expect(s.titled).toEqual([]);
    } finally {
      cleanup(view);
    }
  });

  it("a click on a stop the engine cannot run picks nothing; only those stops have a tooltip", async () => {
    // Codex on gpt-5.5 runs chat and office, not folder and web.
    const calls = shim();
    const view = renderEdit(codexAt("standard", "gpt-5.5"));
    try {
      await settle();
      expect(slider(view.container).titled).toEqual(["folder", "web"]);
      for (const stop of ["folder", "web"] as const) {
        await act(async () => {
          fireEvent.click(stopRadio(view.container, stop));
        });
        expect({ stop, checked: slider(view.container).checked }).toEqual({
          stop,
          checked: ["standard"],
        });
      }
      // A stop it can run still picks on click.
      await act(async () => {
        fireEvent.click(stopRadio(view.container, "office"));
      });
      expect(slider(view.container).checked).toEqual(["office"]);
      await act(async () => {
        fireEvent.click(stopRadio(view.container, "standard"));
      });
      await save(view.container);
      expect(calls).toEqual([]);
    } finally {
      cleanup(view);
    }
  });

  it("arrows, Home and End skip the stops the engine cannot run, and focus follows the checked stop", async () => {
    shim();
    const view = renderEdit(codexAt("office", "gpt-5.5"));
    try {
      await settle();
      stopRadio(view.container, "office").focus();
      const seen: Array<[string, string[], string]> = [];
      for (const k of [
        "ArrowRight",
        "ArrowLeft",
        "ArrowDown",
        "ArrowLeft",
        "End",
        "ArrowDown",
        "Home",
        "ArrowUp",
        "ArrowUp",
      ]) {
        await key(k);
        seen.push([k, slider(view.container).checked, focused()]);
      }
      expect(seen).toEqual([
        // Over folder and web to standard, and back.
        ["ArrowRight", ["standard"], "standard"],
        ["ArrowLeft", ["office"], "office"],
        ["ArrowDown", ["chat"], "chat"],
        // Already at the first stop.
        ["ArrowLeft", ["chat"], "chat"],
        ["End", ["privileged"], "privileged"],
        ["ArrowDown", ["standard"], "standard"],
        ["Home", ["chat"], "chat"],
        ["ArrowUp", ["office"], "office"],
        ["ArrowUp", ["standard"], "standard"],
      ]);
    } finally {
      cleanup(view);
    }
  });

  it("a saved stop the model cannot run stays the tab stop; the keys leave it only for a stop the model runs", async () => {
    // Codex on gpt-5.6-sol runs no stop below Standard.
    shim();
    const view = renderEdit(codexAt("office", "gpt-5.6-sol"));
    try {
      await settle();
      expect(stopDisabled(view.container, "office")).toBe(true);
      const s = slider(view.container);
      expect(s.checked).toEqual(["office"]);
      expect(s.tabStops).toEqual(["office"]);
      stopRadio(view.container, "office").focus();
      const seen: Array<[string, string[], string]> = [];
      for (const k of ["ArrowLeft", "Home", "ArrowLeft", "ArrowDown", "End"]) {
        await key(k);
        seen.push([k, slider(view.container).checked, focused()]);
      }
      expect(seen).toEqual([
        // Chat is below and the model cannot run it either.
        ["ArrowLeft", ["office"], "office"],
        // The first stop the model runs.
        ["Home", ["standard"], "standard"],
        ["ArrowLeft", ["standard"], "standard"],
        ["ArrowDown", ["standard"], "standard"],
        ["End", ["privileged"], "privileged"],
      ]);
    } finally {
      cleanup(view);
    }
  });
});
