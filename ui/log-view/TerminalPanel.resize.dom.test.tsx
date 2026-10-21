// The PTY gets one resize after a window drag settles, not one per frame:
// each SIGWINCH makes readline redraw the line being typed, and a redraw
// computed for an older width leaves a copy of the line in the scrollback
// (task 15cb8cf7). xterm itself still fits on every ResizeObserver callback.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { FitAddon } = await import("@xterm/addon-fit");
const { setShim } = await import("./../ws.ts");
const { TerminalPanel } = await import("./TerminalPanel.tsx");
const { PTY_RESIZE_SETTLE_MS } = await import("./terminal-resize.ts");
const { en } = await import("../../shared/i18n/en.ts");
import type { ClientCommand } from "../../shared/types.ts";

const AGENT = "agent-1";

// happy-dom has no layout and no ResizeObserver: the test owns both. The fit
// addon's measurement is replaced by the size the "window" has now; its fit()
// still runs and resizes xterm.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  static resizeAll() {
    for (const observer of FakeResizeObserver.instances)
      if (!observer.disconnected && observer.targets.length > 0)
        observer.callback([]);
  }
  targets: Element[] = [];
  disconnected = false;
  constructor(readonly callback: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

let layout = { cols: 100, rows: 30 };
const globals = globalThis as Record<string, unknown>;
const originalResizeObserver = globals.ResizeObserver;
const propose = spyOn(FitAddon.prototype, "proposeDimensions");
beforeAll(() => {
  globals.ResizeObserver = FakeResizeObserver;
  propose.mockImplementation(() => ({ ...layout }));
});
afterAll(() => {
  globals.ResizeObserver = originalResizeObserver;
  propose.mockRestore();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => wait(0));
}

type Resize = Extract<ClientCommand, { type: "terminal_resize" }>;

async function mount() {
  FakeResizeObserver.instances = [];
  layout = { cols: 100, rows: 30 };
  const sent: ClientCommand[] = [];
  setShim(
    (cmd) => sent.push(cmd),
    () => {},
  );
  const view = render(
    createElement(TerminalPanel, { agentId: AGENT, onClose: () => {} }),
  );
  await settle();
  const resizes = () =>
    sent
      .filter((cmd): cmd is Resize => cmd.type === "terminal_resize")
      .map(({ agentId, cols, rows }) => ({ agentId, cols, rows }));
  // The mount sends the fitted size at once: the PTY starts at 80x24.
  expect(resizes()).toEqual([{ agentId: AGENT, cols: 100, rows: 30 }]);
  sent.length = 0;
  return { view, sent, resizes };
}

// xterm's DOM renderer keeps one element per row: it shows the size xterm has
// now, independent of what the PTY was told.
function shownRows(container: HTMLElement): number {
  return container.querySelector(".xterm-rows")?.children.length ?? -1;
}

async function drag(sizes: { cols: number; rows: number }[]) {
  for (const size of sizes) {
    layout = size;
    act(() => FakeResizeObserver.resizeAll());
  }
}

describe("terminal panel resize", () => {
  it("sends the PTY one resize, with the last size, after a drag settles", async () => {
    const { view, resizes } = await mount();
    const steps = [95, 90, 85, 80, 75, 70, 65, 60].map((cols, i) => ({
      cols,
      rows: 30 - i,
    }));
    await drag(steps);
    // xterm followed the drag at once...
    await settle();
    expect(shownRows(view.container)).toBe(23);
    // ...while the PTY was not told yet.
    expect(resizes()).toEqual([]);

    await act(async () => wait(PTY_RESIZE_SETTLE_MS + 100));
    expect(resizes()).toEqual([{ agentId: AGENT, cols: 60, rows: 23 }]);
    view.unmount();
  });

  it("sends nothing when the drag ends at the size the PTY already has", async () => {
    const { view, resizes } = await mount();
    await drag([
      { cols: 90, rows: 30 },
      { cols: 100, rows: 30 },
    ]);
    await act(async () => wait(PTY_RESIZE_SETTLE_MS + 100));
    expect(resizes()).toEqual([]);
    // A real change afterwards still goes out.
    await drag([{ cols: 100, rows: 20 }]);
    await act(async () => wait(PTY_RESIZE_SETTLE_MS + 100));
    expect(resizes()).toEqual([{ agentId: AGENT, cols: 100, rows: 20 }]);
    view.unmount();
  });

  it("never sends a resize that is pending when the panel closes", async () => {
    const { view, sent, resizes } = await mount();
    await drag([{ cols: 70, rows: 20 }]);
    // The resize is pending: nothing went out yet.
    expect(resizes()).toEqual([]);
    view.unmount();
    const sentBeforeClose = sent.length;
    await act(async () => wait(PTY_RESIZE_SETTLE_MS + 100));
    expect(sent.slice(sentBeforeClose)).toEqual([]);
  });

  it("tells the restarted PTY the panel's size right after the restart", async () => {
    const { view, sent } = await mount();
    fireEvent.click(
      view.getByRole("button", { name: en["panels.terminal.restart"] }),
    );
    // The new PTY starts at 80x24, so the size goes out at once and in order,
    // although the panel's size did not change since the last resize it sent.
    const order = () =>
      sent
        .filter(
          (cmd) =>
            cmd.type === "terminal_restart" || cmd.type === "terminal_resize",
        )
        .map((cmd) =>
          cmd.type === "terminal_resize"
            ? `resize ${cmd.cols}x${cmd.rows}`
            : cmd.type,
        );
    expect(order()).toEqual(["terminal_restart", "resize 100x30"]);
    await act(async () => wait(PTY_RESIZE_SETTLE_MS + 100));
    expect(order()).toEqual(["terminal_restart", "resize 100x30"]);
    view.unmount();
  });
});
