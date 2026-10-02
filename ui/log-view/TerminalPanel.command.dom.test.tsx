// A card's command is typed only after the panel has read the prompt line, and
// xterm parses writes later than they arrive. The mounted panel over the WS
// shim pins the order: a status that follows output must be classified
// against that output, not against the screen before it.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setShim, shimEmit } = await import("./../ws.ts");
const { TerminalPanel } = await import("./TerminalPanel.tsx");
const { INTERRUPT_INPUT_BYTES, commandInputBytes } = await import(
  "./terminal-command.ts"
);
import type { ClientCommand } from "../../shared/types.ts";

const AGENT = "agent-1";
const COMMAND = "echo AFTER";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => flush());
}

function status() {
  shimEmit({
    type: "terminal_status",
    agentId: AGENT,
    process: "bash",
    shell: true,
  });
}

async function mountWithCommand() {
  const sent: ClientCommand[] = [];
  setShim(
    (cmd) => sent.push(cmd),
    () => {},
  );
  let handled = 0;
  const view = render(
    createElement(TerminalPanel, {
      agentId: AGENT,
      onClose: () => {},
      pendingCommand: COMMAND,
      onCommandHandled: () => handled++,
    }),
  );
  await settle();
  act(() => {
    shimEmit({ type: "terminal_output", agentId: AGENT, data: "$ " });
    status();
  });
  await settle();
  const requests = () =>
    sent.filter((cmd) => cmd.type === "terminal_status_request").length;
  const inputs = () =>
    sent.filter((cmd) => cmd.type === "terminal_input").map((cmd) => cmd.data);
  return { view, requests, inputs, handled: () => handled };
}

describe("a card command and the prompt it lands on", () => {
  it("reads a continuation prompt that arrived just before the status", async () => {
    const { view, requests, inputs } = await mountWithCommand();
    expect(requests()).toBe(1);
    expect(inputs()).toEqual([]);
    act(() => {
      shimEmit({
        type: "terminal_output",
        agentId: AGENT,
        data: "echo 'a\r\n> ",
      });
      status();
    });
    await settle();
    expect(inputs()).toEqual([INTERRUPT_INPUT_BYTES]);
    view.unmount();
  });

  it("types at a primary prompt with no interrupt", async () => {
    const { view, inputs, handled } = await mountWithCommand();
    act(() => status());
    await settle();
    expect(inputs()).toEqual([commandInputBytes(COMMAND)]);
    expect(handled()).toBe(1);
    view.unmount();
  });

  it("writes nothing when the terminal exits while the prompt is read", async () => {
    const { view, inputs } = await mountWithCommand();
    act(() => {
      shimEmit({ type: "terminal_output", agentId: AGENT, data: "x\r\n$ " });
      status();
      shimEmit({ type: "terminal_exit", agentId: AGENT, exitCode: 0 });
    });
    await settle();
    expect(inputs()).toEqual([]);
    view.unmount();
  });
});
