// Task 589a8f4f: on a phone the open asks stack is capped by the visible
// height, not by vh. iOS does not shrink vh when the keyboard opens, so a vh cap
// let a tall ask push the chat input out of the fixed shell, below the keyboard.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "waiting_for_response",
  agentType: "codex",
  modelFamily: "gpt-6-astra",
  topic: null,
  capabilities: { edit: true },
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

const ASK: AskEntry = {
  id: "aaaa0001",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "Ship it?",
  createdAt: 1,
  updatedAt: 1,
};

// The visible viewport a phone browser reports; the keyboard shrinks it.
function installVisualViewport(height: number) {
  const listeners = new Set<EventListener>();
  const viewport = {
    height,
    offsetTop: 0,
    addEventListener(type: string, listener: EventListener) {
      if (type === "resize") listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type === "resize") listeners.delete(listener);
    },
    resize(next: number) {
      viewport.height = next;
      for (const listener of listeners) listener(new Event("resize"));
    },
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}
afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
});

function Page() {
  const state = useAppState();
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries: [ASK], revision: 0 });
  }, [dispatch]);
  return (
    <StateCtx.Provider value={{ ...state, isMobile: true }}>
      <LogView
        agent={agent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

const px = (value: string) => {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return match ? Number(match[1]) : null;
};

it("caps the open asks stack on a phone by the visible height, and follows it when the keyboard opens", async () => {
  const viewport = installVisualViewport(760);
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page />
    </StoreProvider>,
  );
  const shell = view.container.querySelector<HTMLElement>(".log-view-shell")!;
  // The shell took the stubbed visible height: the phone path is on.
  await waitFor(() => expect(shell.style.height).toBe("760px"));
  const bar = await waitFor(() => {
    const el = view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    );
    expect(el).not.toBe(null);
    return el!;
  });
  fireEvent.click(bar);
  const body = view.container.querySelector<HTMLElement>("[data-asks-body]")!;
  expect(body.style.maxHeight).toMatch(/^\d+(\.\d+)?px$/);
  const open = px(body.style.maxHeight);
  // A share of the visible height that leaves room for the header, the
  // composer and some log.
  expect(open!).toBeGreaterThan(760 * 0.25);
  expect(open!).toBeLessThan(760 * 0.5);

  // The keyboard opens: the visible height shrinks and the cap with it.
  await act(async () => viewport.resize(452));
  expect(shell.style.height).toBe("452px");
  const typing = px(body.style.maxHeight)!;
  expect(typing).toBeLessThan(open!);
  expect(Math.abs(typing - (open! * 452) / 760)).toBeLessThanOrEqual(1);
  view.unmount();
});
