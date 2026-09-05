// The terminal must not answer the scrollback it is seeded with.
//
// Task 74d33445: every visit to an agent view with the terminal open appended
// one more `11;rgb:0a0a/0e0e/1616;1R` to the shell prompt. The server seeds a
// freshly mounted panel with the whole PTY scrollback, xterm parses a query in
// it as if a program had just asked, and its answer goes to the PTY as input.
//
// The panel is mounted for real over the WS shim, because the PTY input is what
// the boss sees and nothing below the panel decides whether a chunk is
// scrollback. The first test pins the untouched xterm behaviour that makes the
// bug possible, so a guard that stops working is not mistaken for an xterm that
// stopped answering.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { Terminal } = await import("@xterm/xterm");
const { setShim, shimEmit } = await import("./../ws.ts");
const { TerminalPanel } = await import("./TerminalPanel.tsx");
const { installReplayGuard } = await import("./terminal-replay-guard.ts");
import type { ClientCommand } from "../../shared/types.ts";

const AGENT = "agent-1";
// A background-colour query and a cursor-position request, the two Nil's
// prompt line collected. Any program can leave them in the scrollback.
const QUERIES = "\x1b]11;?\x07\x1b[6n";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => flush());
}

function mountPanel() {
  const sent: ClientCommand[] = [];
  setShim(
    (cmd) => sent.push(cmd),
    () => {},
  );
  const view = render(
    createElement(TerminalPanel, { agentId: AGENT, onClose: () => {} }),
  );
  const inputs = () =>
    sent.filter((cmd) => cmd.type === "terminal_input").map((cmd) => cmd.data);
  return { view, inputs };
}

describe("a terminal seeded with scrollback", () => {
  it("answers those queries when they arrive live, and xterm alone always would", async () => {
    // Untouched xterm, no guard: this is the behaviour the panel has to
    // contain, and the reason the panel cannot simply hand every chunk over.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const bare = new Terminal({
      theme: { background: "#0a0e16" },
      allowProposedApi: true,
    });
    bare.open(host);
    const bareAnswers: string[] = [];
    bare.onData((data) => bareAnswers.push(data));
    await new Promise<void>((resolve) => bare.write(QUERIES, () => resolve()));
    expect(bareAnswers).toEqual(["\x1b]11;rgb:0a0a/0e0e/1616\x1b\\", "\x1b[1;1R"]);
    bare.dispose();
    host.remove();

    // The panel keeps that behaviour for live output.
    const { view, inputs } = mountPanel();
    await settle();
    act(() => {
      shimEmit({ type: "terminal_output", agentId: AGENT, data: QUERIES });
    });
    await settle();
    expect(inputs()).toEqual(["\x1b]11;rgb:0a0a/0e0e/1616\x1b\\", "\x1b[1;1R"]);
    view.unmount();
  });

  it("stays silent when the same queries arrive as replayed scrollback", async () => {
    // The reported case: leave the agent view and come back, three times over.
    // Every visit mounts a new terminal and is seeded with the same scrollback.
    let last: ReturnType<typeof mountPanel> | null = null;
    for (let visit = 0; visit < 3; visit++) {
      last?.view.unmount();
      last = mountPanel();
      await settle();
      act(() => {
        shimEmit({
          type: "terminal_output",
          agentId: AGENT,
          data: `nil@auntie-2:~/nil/isomux$ ${QUERIES}`,
          replay: true,
        });
      });
      await settle();
      expect(last.inputs()).toEqual([]);
    }

    // Suppression is scoped to the replayed chunk: a program that asks after
    // the seeding still gets its answer.
    act(() => {
      shimEmit({ type: "terminal_output", agentId: AGENT, data: QUERIES });
    });
    await settle();
    expect(last!.inputs().length).toBe(2);
    last!.view.unmount();
  });
});

describe("installReplayGuard", () => {
  it("applies a colour a replayed chunk sets, and only swallows the queries", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({
      theme: { background: "#0a0e16" },
      allowProposedApi: true,
    });
    term.open(host);
    const answers: string[] = [];
    term.onData((data) => answers.push(data));
    const guard = installReplayGuard(term);

    // OSC 11 with a colour is a command, not a query, so it has to reach
    // xterm even inside a replay - otherwise the scrollback renders in the
    // wrong colours.
    await new Promise<void>((resolve) =>
      guard.writeReplay(`\x1b]11;#ff0000\x07${QUERIES}`, resolve),
    );
    expect(answers).toEqual([]);
    expect(guard.suppressing()).toBe(false);

    // The live query reports the colour the replayed chunk set.
    await new Promise<void>((resolve) => term.write(QUERIES, () => resolve()));
    expect(answers[0]).toBe("\x1b]11;rgb:ffff/0000/0000\x1b\\");

    guard.dispose();
    term.dispose();
    host.remove();
  });
});
