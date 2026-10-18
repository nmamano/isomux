// The resume-after-usage-limit switch in the agent edit dialog: on for an
// agent with no stored value, sent as limitResume on save, absent for an
// engine that cannot report a usage limit stop.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { fireEvent } = await import("@testing-library/react");
const { claudeAgent, renderEdit, settle, shimRequests } =
  await import("../test-support/claude-limits-fixture.tsx");

const toggle = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#agent-limit-resume");

async function save(container: HTMLElement) {
  fireEvent.click([...container.querySelectorAll("button")].at(-1)!);
  await settle();
  await settle();
}

describe("edit dialog resume-after-usage-limit switch", () => {
  it("is on for an agent with no stored value, and saving it off sends limitResume false", async () => {
    const patches = shimRequests();
    const { view } = renderEdit(claudeAgent("opus", "default", []), []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(true);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ limitResume: false }]);
    } finally {
      view.unmount();
    }
  });

  it("shows an agent's switch off and sends it on", async () => {
    const patches = shimRequests();
    const agent = { ...claudeAgent("opus", "default", []), limitResume: false };
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      const box = toggle(view.container)!;
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      await save(view.container);
      expect(patches).toEqual([{ limitResume: true }]);
    } finally {
      view.unmount();
    }
  });

  it("is hidden when the agent's engine cannot report a usage limit stop", async () => {
    shimRequests();
    const base = claudeAgent("opus", "default", []);
    const agent = {
      ...base,
      capabilities: { ...base.capabilities, limitResume: false },
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
