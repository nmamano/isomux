// The access slider as a step bar (task 8c60be00, the room view level
// slider reused): the stops in order, the ones up to the chosen one filled,
// and the stops the engine and model cannot run, which stay in the row but
// cannot be picked by click or key. What a save sends is in
// EditAgentDialog.access.dom.test.tsx; which stops each engine and model
// runs is engineRunsAccess, in shared/agent-access.test.ts; how the keys skip
// a disabled stop in the middle of the row is in StepSlider.dom.test.tsx.
// The engine and the stops describe is the dialog's wiring of that rule
// (task e77304b1, merge C1).
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentInfo } from "../../shared/types.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const {
  BELOW,
  STOPS,
  agentAt,
  change,
  cleanup,
  pick,
  renderEdit,
  save,
  settle,
  shim,
  stopChecked,
  stopDisabled,
  stopRadio,
} = await import("../test-support/access-slider-fixture.tsx");

function codexAt(access: AgentAccess, modelFamily: string): AgentInfo {
  return {
    ...agentAt(access, "codex"),
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
    const view = renderEdit(agentAt("web"));
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
    // Codex on gpt-5.6-sol runs no stop below Standard.
    const calls = shim();
    const view = renderEdit(codexAt("standard", "gpt-5.6-sol"));
    try {
      await settle();
      expect<string[]>(slider(view.container).titled).toEqual(BELOW);
      for (const stop of BELOW) {
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
        fireEvent.click(stopRadio(view.container, "privileged"));
      });
      expect(slider(view.container).checked).toEqual(["privileged"]);
      await act(async () => {
        fireEvent.click(stopRadio(view.container, "standard"));
      });
      await save(view.container);
      expect(calls).toEqual([]);
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

describe("the engine and the stops", () => {
  // Which stops each engine and model runs is engineRunsAccess
  // (shared/agent-access.test.ts); here, that the dialog asks it with the
  // engine and the model the member picked.
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
      // Codex runs every stop on one model.
      for (const stop of ["office", "folder", "web"] as const) {
        await pick(view.container, stop);
        expect({ stop, engines: engines() }).toMatchObject({
          stop,
          engines: { claude: false, codex: false, opencode: false },
        });
      }
    } finally {
      cleanup(view);
    }
  });

  // The model picker of a Codex agent: below Standard only a proven model
  // can be picked, and the stops follow the model picked, not the saved one.
  it("below Standard, a Codex model that is not proven is disabled; the stops follow the picked model", async () => {
    shim();
    const view = renderEdit({
      ...agentAt("standard", "codex"),
      modelFamily: "gpt-5.6-sol",
    });
    try {
      await settle();
      const models = modelSelect(view.container);
      const disabledModels = () =>
        [...models().options].filter((o) => o.disabled).map((o) => o.value);
      expect(disabledModels()).toEqual([]);
      expect(stopDisabled(view.container, "office")).toBe(true);
      await change(models(), "gpt-5.5");
      expect(stopDisabled(view.container, "office")).toBe(false);
      await pick(view.container, "office");
      expect(stopChecked(view.container, "office")).toBe(true);
      expect(
        [...models().options].filter((o) => !o.disabled).map((o) => o.value),
      ).toEqual(["gpt-5.5"]);
    } finally {
      cleanup(view);
    }
  });

  it("a switch to Codex at office lands on the proven model", async () => {
    shim();
    const view = renderEdit(agentAt("office"));
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
