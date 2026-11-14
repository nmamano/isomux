// The access slider as a step bar (task 8c60be00, the room view level
// slider reused): the stops in order, the ones up to the chosen one filled,
// and the stops the engine and model cannot run, which stay in the row but
// cannot be picked by click or key. What a save sends is in
// EditAgentDialog.access.dom.test.tsx; which stops each engine and model
// runs is engineRunsAccess, in shared/agent-access.test.ts; how the keys skip
// a disabled stop in the middle of the row is in StepSlider.dom.test.tsx.
// The engine and the stops describe is the form's wiring of that rule
// (task e77304b1, merge C1): on the Agent settings page the engine and the
// model are on Engine, the slider on Access (task 59538509).
// The folder hint follows the stop the slider shows (task 6c2bb97c).
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import type { AgentAccess } from "../../shared/agent-access.ts";
import type { AgentInfo } from "../../shared/types.ts";
import { SUPPORTED_LANGUAGES } from "../../shared/languages.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const {
  BELOW,
  STOPS,
  agentAt,
  change,
  cleanup,
  openSection,
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
  // (shared/agent-access.test.ts); here, that the form asks it with the
  // engine and the model the member picked.
  it("below Standard, the engines that cannot run the stop are disabled", async () => {
    shim();
    const view = renderEdit(
      agentAt("standard"),
      undefined,
      undefined,
      "engine",
    );
    try {
      await settle();
      const engines = () =>
        Object.fromEntries(
          [
            ...view.container.querySelector<HTMLSelectElement>(
              ".agent-engine-control select",
            )!.options,
          ].map((o) => [o.value, o.disabled]),
        );
      expect(engines()).toMatchObject({ claude: false, codex: false });
      // Codex runs every stop on one model.
      for (const stop of ["office", "folder", "web"] as const) {
        await openSection(view.container, "access");
        await pick(view.container, stop);
        await openSection(view.container, "engine");
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
    const view = renderEdit(
      {
        ...agentAt("standard", "codex"),
        modelFamily: "gpt-5.6-sol",
      },
      undefined,
      undefined,
      "engine",
    );
    try {
      await settle();
      const models = modelSelect(view.container);
      const disabledModels = () =>
        [...models().options].filter((o) => o.disabled).map((o) => o.value);
      expect(disabledModels().length).toBe(0);
      await openSection(view.container, "access");
      expect(stopDisabled(view.container, "office")).toBe(true);
      await openSection(view.container, "engine");
      await change(models(), "gpt-5.5");
      await openSection(view.container, "access");
      expect(stopDisabled(view.container, "office")).toBe(false);
      await pick(view.container, "office");
      expect(stopChecked(view.container, "office")).toBe(true);
      await openSection(view.container, "engine");
      expect(
        [...models().options].filter((o) => !o.disabled).map((o) => o.value),
      ).toEqual(["gpt-5.5"]);
    } finally {
      cleanup(view);
    }
  });

  it("a switch to Codex at office lands on the proven model", async () => {
    shim();
    const view = renderEdit(agentAt("office"), undefined, undefined, "engine");
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

// The folder hint follows the stop (task 6c2bb97c): below Standard the agent
// reaches no file outside its folder, so the hint says only where it starts
// work; at Standard and Privileged it also says the agent reaches files
// outside. It follows the live slider, not the saved stop.
describe("the folder hint", () => {
  const { t } = translatorFor("en");
  const WITHOUT_SHELL = t("dialogs.agent.cwdHint");
  const WITH_SHELL = t("dialogs.agent.cwdHintWithShell");
  const expected = (stop: AgentAccess) =>
    BELOW.includes(stop) ? WITHOUT_SHELL : WITH_SHELL;

  // The hint is the folder field's paragraph that shows one of the two
  // messages; exactly one shows.
  function folderHint(container: HTMLElement): string {
    const field = container.querySelector(".agent-directory-field");
    if (!field) throw new Error("no folder field");
    const shown = [...field.querySelectorAll("p")]
      .map((p) => p.textContent ?? "")
      .filter((text) => text === WITHOUT_SHELL || text === WITH_SHELL);
    if (shown.length !== 1)
      throw new Error(`${shown.length} folder hints shown`);
    return shown[0]!;
  }

  it("the two messages differ in every language", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(1);
    // The languages whose two messages are the same.
    const same = SUPPORTED_LANGUAGES.map(({ code }) => code).filter((code) => {
      const tr = translatorFor(code);
      return (
        tr.t("dialogs.agent.cwdHint") === tr.t("dialogs.agent.cwdHintWithShell")
      );
    });
    expect(same).toEqual([]);
  });

  it("a saved agent at each stop shows the hint of that stop", async () => {
    const seen: Record<string, string> = {};
    for (const stop of STOPS) {
      // cleanup drops the shim: each render gets its own.
      shim();
      const view = renderEdit(agentAt(stop));
      try {
        await settle();
        expect(stopChecked(view.container, stop)).toBe(true);
        seen[stop] = folderHint(view.container);
      } finally {
        cleanup(view);
      }
    }
    expect(seen).toEqual(
      Object.fromEntries(STOPS.map((stop) => [stop, expected(stop)])),
    );
  });

  it("the hint changes when the slider crosses Standard, both ways", async () => {
    shim();
    const view = renderEdit(agentAt("folder"));
    try {
      await settle();
      const seen: Array<[string, string]> = [
        ["folder", folderHint(view.container)],
      ];
      for (const stop of ["standard", "web", "privileged", "chat"] as const) {
        await pick(view.container, stop);
        expect(stopChecked(view.container, stop)).toBe(true);
        seen.push([stop, folderHint(view.container)]);
      }
      expect(seen).toEqual(
        (["folder", "standard", "web", "privileged", "chat"] as const).map(
          (stop) => [stop, expected(stop)],
        ),
      );
    } finally {
      cleanup(view);
    }
  });
});
