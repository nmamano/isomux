// The terminal panel's notices, from the server's terminal_status flags
// alone: envStale says the agent's secrets changed after its shell started,
// and recorded (task 749cb7fd) tells every member who opens a recorded
// terminal. A new shell's status without the flags takes them away.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setShim, shimEmit } = await import("./../ws.ts");
const { TerminalPanel } = await import("./TerminalPanel.tsx");
const { en } = await import("../../shared/i18n/en.ts");

const AGENT = "agent-1";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("the terminal notices", () => {
  it("show while the status carries their flag, side by side, and go with a new shell", async () => {
    setShim(
      () => {},
      () => {},
    );
    const view = render(
      createElement(TerminalPanel, { agentId: AGENT, onClose: () => {} }),
    );
    await settle();
    const notices = () =>
      view.queryAllByRole("status").map((notice) => notice.textContent);
    expect(notices()).toEqual([]);
    const status = async (flags: { recorded?: true; envStale?: true }) => {
      act(() =>
        shimEmit({
          type: "terminal_status",
          agentId: AGENT,
          process: "bash",
          shell: true,
          ...flags,
        }),
      );
      await settle();
    };

    await status({ envStale: true });
    expect(notices()).toEqual([en["panels.terminal.envStale"]]);
    await status({ recorded: true });
    expect(notices()).toHaveLength(1);
    expect(notices()).not.toContain(en["panels.terminal.envStale"]);
    await status({ recorded: true, envStale: true });
    expect(notices()).toHaveLength(2);
    expect(notices()).toContain(en["panels.terminal.envStale"]);
    // A new, unrecorded shell.
    await status({});
    expect(notices()).toEqual([]);
    view.unmount();
  });
});
