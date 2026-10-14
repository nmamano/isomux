// The automatic-handoff switch in the agent edit dialog: shown for an engine
// that reports the measure, sent as autoHandoff on save, absent otherwise.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent } = await import("@testing-library/react");
const { claudeAgent, renderEdit, settle, shimRequests } =
  await import("../test-support/claude-limits-fixture.tsx");

const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-auto-handoff");

async function save(container: HTMLElement) {
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

describe("edit dialog automatic handoff switch", () => {
  it("is off for an agent without the setting, and saving it on sends autoHandoff", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: true }]);
    } finally {
      view.unmount();
    }
  });

  it("shows an agent's setting and sends the switch off", async () => {
    const patches = shimRequests();
    const agent = { ...claudeAgent("opus", "default", []), autoHandoff: true };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(true);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ autoHandoff: false }]);
    } finally {
      view.unmount();
    }
  });

  it("is hidden when the agent's engine cannot report the measure", async () => {
    shimRequests();
    const base = claudeAgent("opus", "default", []);
    const agent = {
      ...base,
      capabilities: { ...base.capabilities, autoHandoff: false },
    };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      expect(toggle(view.container)).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
