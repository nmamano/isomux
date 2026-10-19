// The terminal panel says when the agent's secrets changed after its shell
// started: the server sets envStale on terminal_status, and a restart
// (a new shell) clears it.

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

describe("the secrets notice", () => {
  it("shows while the status says the secrets changed, and goes with a new shell", async () => {
    setShim(
      () => {},
      () => {},
    );
    const view = render(
      createElement(TerminalPanel, { agentId: AGENT, onClose: () => {} }),
    );
    await settle();
    const notice = () => view.queryByRole("status");
    expect(notice()).toBeNull();

    act(() =>
      shimEmit({
        type: "terminal_status",
        agentId: AGENT,
        process: "bash",
        shell: true,
        envStale: true,
      }),
    );
    await settle();
    expect(notice()?.textContent).toBe(en["panels.terminal.envStale"]);

    // Restarted: the new shell's status has no flag.
    act(() =>
      shimEmit({
        type: "terminal_status",
        agentId: AGENT,
        process: "bash",
        shell: true,
      }),
    );
    await settle();
    expect(notice()).toBeNull();
    view.unmount();
  });
});
