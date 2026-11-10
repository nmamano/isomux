// The access slider below Standard (task 82da687b): the agent gets one fixed
// office grant, so the slider's field has no pack, area or room picker, and a
// save sends the stop alone. What a save sends at each stop is in
// EditAgentDialog.access.dom.test.tsx, and the engines and Codex models a
// stop allows in EditAgentDialog.access-slider.dom.test.tsx.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const {
  STOPS,
  accessFieldControls,
  agentAt,
  cleanup,
  pick,
  renderEdit,
  save,
  settle,
  shim,
} = await import("../test-support/access-slider-fixture.tsx");

describe("the slider below Standard", () => {
  it("has no control but its stops at any stop", async () => {
    shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      const controls: Record<string, number> = {};
      for (const stop of STOPS) {
        await pick(view.container, stop);
        controls[stop] = accessFieldControls(view.container);
      }
      expect(controls).toEqual({
        chat: 0,
        office: 0,
        folder: 0,
        web: 0,
        standard: 0,
        privileged: 0,
      });
    } finally {
      cleanup(view);
    }
  });

  it("sends the stop alone, also after passing through Chat", async () => {
    const calls = shim();
    const view = renderEdit(agentAt("standard"));
    try {
      await settle();
      await pick(view.container, "office");
      await pick(view.container, "chat");
      await pick(view.container, "folder");
      await save(view.container);
      expect(calls).toEqual([
        {
          method: "PUT",
          path: "/api/agents/a1/access",
          body: { access: "folder" },
        },
      ]);
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
