// The chat composer shows its caret after the draft changes under it (task
// fefacd08): a long draft in the capped field scrolls so the caret line shows,
// on a phone too, where the field is shortest. Here: the draft restored when
// the chat opens, and the draft an ask's "Discuss in chat" adds to (the ask's
// Cite asks for the composer's focus the same way). The chat's Cite is in
// LogView.cite-touch.dom.test.tsx, a failed edit put back in
// LogView.failed-edit.dom.test.tsx, the scroll itself in
// ui/composer-height.dom.test.ts.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { _resetOutboxForTests } = await import("./outbox.ts");
const { layOutTextareas, scrolledToEnd } =
  await import("../test-support/textarea-layout.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = import("../store.tsx").AppState;

const AGENT = {
  id: "caret-agent",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "/w",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  userId: "u1",
  username: "Tester",
  queue: [],
  contextUsage: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
  capabilities: DEFAULT_AGENT_CAPABILITIES,
} as unknown as AgentInfo;

const ASK: AskEntry = {
  id: "ask00001",
  agentId: AGENT.id,
  memberUserId: "u1",
  prompt: "Should we move the nightly backups to the desktop box tonight?",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  options: ["Yes", "No"],
};

// Taller than the phone's cap.
const LONG = Array.from({ length: 20 }, (_, i) => `note ${i + 1}`).join("\n");

let undoLayout = () => {};
let undoPointer = () => {};
beforeEach(() => {
  _resetOutboxForTests();
  setApiShim(async () => ({}));
  undoLayout = layOutTextareas();
  // A touch screen: the composer takes no focus of its own when the chat
  // opens.
  undoPointer = primaryPointer(true);
});
afterEach(() => {
  undoPointer();
  undoLayout();
  setApiShim(null);
});

// The chat on a phone (narrow, touch), opened with `draft` in the composer.
function mount(draft: string) {
  const seeded: AppState = stateWithSelfUser(null, {
    agents: [AGENT],
    rooms: [
      { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
    ] as AppState["rooms"],
    asks: [ASK],
    drafts: new Map([[AGENT.id, draft]]),
    hasReceivedInitialState: true,
    connected: true,
    isMobile: true,
  });
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(
          LanguageProvider,
          null,
          createElement(LogView, {
            agent: AGENT,
            logs: [],
            onBack: () => {},
            onEditAgent: () => {},
          }),
        ),
      ),
    );
  }
  return render(createElement(Harness));
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const all = container.querySelectorAll("textarea");
  return all[all.length - 1];
}

it("a long draft restored when the chat opens shows its end, with the caret there and no focus, so no keyboard opens", async () => {
  const view = mount(LONG);
  await act(async () => {});
  const ta = composer(view.container);
  expect(ta.value).toBe(LONG);
  expect(scrolledToEnd(ta)).toEqual({ overflows: true, atEnd: true });
  expect(ta.selectionStart).toBe(LONG.length);
  // A boolean, not toBe on two nodes: a red run would serialise both.
  expect(document.activeElement === ta).toBe(false);
  view.unmount();
});

it("Discuss in chat on a long draft shows the end of the draft inside the click, with focus", async () => {
  const view = mount(LONG);
  await act(async () => {});
  const ta = composer(view.container);
  // A phone shows the stack folded: open it.
  const unfold = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-stack="collapsed"] button',
  );
  expect(unfold === null).toBe(false);
  act(() => {
    fireEvent.click(unfold!);
  });
  // Scrolled up, as a member reading the draft leaves it.
  ta.scrollTop = 0;
  const button = view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${ASK.id}"] button[data-ask-about]`,
  );
  expect(button === null).toBe(false);
  // No wait after the click: a phone opens its keyboard only for a focus
  // inside the tap.
  act(() => {
    fireEvent.click(button!);
  });
  expect(ta.value.startsWith(`${LONG}\n\n`)).toBe(true);
  expect(document.activeElement === ta).toBe(true);
  expect(ta.selectionStart).toBe(ta.value.length);
  expect(scrolledToEnd(ta)).toEqual({ overflows: true, atEnd: true });
  view.unmount();
});
