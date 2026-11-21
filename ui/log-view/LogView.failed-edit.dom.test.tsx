// Task eb9002b4: a failed edit never loses the member's edited text. A
// failure the server reports keeps the text in its error entry, with an action
// that appends it to the composer; a rejected edit request appends it at once.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { FAILED_EDIT_TEXT_KEY } = await import("../../shared/failed-edit.ts");
const { layOutTextareas, scrolledToEnd } =
  await import("../test-support/textarea-layout.ts");
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
let undoLayout = () => {};
afterEach(() => {
  undoLayout();
  undoLayout = () => {};
});
type LogEntry = import("../../shared/types.ts").LogEntry;

function agentWith(canEdit: boolean): AgentInfo {
  return {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "waiting_for_response",
    agentType: "codex",
    modelFamily: "gpt-6-astra",
    topic: null,
    capabilities: { edit: canEdit },
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
}

const failedEdit: LogEntry = {
  id: "err-1",
  agentId: "a1",
  timestamp: 1,
  kind: "error",
  content: "edit failed",
  metadata: { [FAILED_EDIT_TEXT_KEY]: "my edited text" },
};

const userMessage: LogEntry = {
  id: "msg-1",
  agentId: "a1",
  timestamp: 1,
  kind: "user_message",
  content: "original",
};

// Real store drafts, so the composer shows what the restore dispatches.
function Page({ agent, logs }: { agent: AgentInfo; logs: LogEntry[] }) {
  const state = useAppState();
  return (
    <StateCtx.Provider value={state}>
      <LogView
        agent={agent}
        logs={logs}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const all = container.querySelectorAll("textarea");
  return all[all.length - 1];
}

it("appends a failed edit's text to the composer without replacing newer text, and shows the end of a long draft", async () => {
  setApiShim(async () => ({ counts: {} }));
  undoLayout = layOutTextareas();
  // Taller than the composer's cap (task fefacd08).
  const newer = Array.from({ length: 20 }, (_, i) => `newer ${i + 1}`).join(
    "\n",
  );
  const view = render(
    <StoreProvider>
      <Page agent={agentWith(true)} logs={[failedEdit]} />
    </StoreProvider>,
  );
  const shown = view.container.querySelector("[data-failed-edit-text]");
  expect(shown?.textContent).toBe("my edited text");
  const box = composer(view.container);
  fireEvent.change(box, { target: { value: newer } });
  box.scrollTop = 0;
  fireEvent.click(view.container.querySelector("[data-restore-failed-edit]")!);
  await waitFor(() =>
    expect(composer(view.container).value).toBe(`${newer}\n\nmy edited text`),
  );
  // Let pending effects settle before the DOM goes away.
  await act(async () => {});
  const ta = composer(view.container);
  expect(ta.selectionStart).toBe(ta.value.length);
  expect(scrolledToEnd(ta)).toEqual({ overflows: true, atEnd: true });
  view.unmount();
});

it("shows the text but no restore action to a viewer who cannot edit", async () => {
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page agent={agentWith(false)} logs={[failedEdit]} />
    </StoreProvider>,
  );
  expect(
    view.container.querySelector("[data-failed-edit-text]")?.textContent,
  ).toBe("my edited text");
  expect(view.container.querySelector("[data-restore-failed-edit]")).toBe(null);
  // Let pending effects settle before the DOM goes away.
  await act(async () => {});
  view.unmount();
});

it("puts the text back in the composer with an inline error when the edit request is rejected", async () => {
  setApiShim(async (method) => {
    if (method === "PATCH") throw new Error("edit request refused");
    return { counts: {} };
  });
  const view = render(
    <StoreProvider>
      <Page agent={agentWith(true)} logs={[userMessage]} />
    </StoreProvider>,
  );
  fireEvent.change(composer(view.container), { target: { value: "draft" } });
  fireEvent.click(view.container.querySelector("[data-edit-message]")!);
  const editor = [...view.container.querySelectorAll("textarea")].find(
    (t) => t.value === "original",
  )!;
  fireEvent.change(editor, { target: { value: "rejected edit" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  await waitFor(() =>
    expect(composer(view.container).value).toBe("draft\n\nrejected edit"),
  );
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
    "edit request refused",
  );
  // Let pending effects settle before the DOM goes away.
  await act(async () => {});
  view.unmount();
});
