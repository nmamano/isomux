// Cite on an ask card (task ad4b51ac): a selection inside the ask's prompt
// shows the Cite pill. The pill puts the selection into the agent's chat
// draft, as "Discuss in chat" does, and not into the ask's reply field: a
// member cites a part to ask about it before answering (task d9a347a6). It
// asks the composer for focus after the block and opens the agent's chat
// (onChatAgent on the Inbox, onFocusAgent elsewhere); the composer side of
// that request is ask-about.dom.test.tsx. AskCard is the card of the chat's
// ask stack and of the Inbox. The pill's place and a real mouse need a
// browser and are not checked here.
import { afterAll, afterEach, beforeEach, expect, it, mock } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useAppState, useDispatch } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AskCard } = await import("./AskCard.tsx");
const { citationBlock, insertCite } = await import("./cite.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = import("../store.tsx").AppState;

const NOW = Date.now();
const ASK: AskEntry = {
  id: "ab12cd34",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "First point here. Second point there.",
  options: ["Approve", "Reject"],
  recommended: "Approve",
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
};
// Two dollars in one cite: insertCite escapes them, a plain append does not.
// In a code span, so the prompt shows them as typed.
const DOLLAR_ASK: AskEntry = {
  ...ASK,
  id: "ef56ab12",
  prompt: "Run `echo $HOME/$USER` first.",
};
const NO_AGENT_ASK: AskEntry = {
  ...ASK,
  id: "cd34ef56",
  agentId: "",
  prompt: "Nobody reads this one.",
  options: undefined,
  recommended: undefined,
};

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});
beforeEach(() => setApiShim(async () => undefined));
afterAll(() => setApiShim(null));

// happy-dom has no layout: give every selection and every box a size, so the
// hook's visibility check passes. Descriptors, put back after each test:
// happy-dom's classes outlive the window.
const rectsDesc = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
const boundsDesc = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
beforeEach(() => {
  const box = new DOMRect(10, 40, 100, 20);
  Range.prototype.getClientRects = () =>
    Object.assign([box], { item: () => box }) as unknown as DOMRectList;
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 500, 500);
});
afterEach(() => {
  const putBack = (target: object, name: string, d?: PropertyDescriptor) => {
    if (d) Object.defineProperty(target, name, d);
    else Reflect.deleteProperty(target, name);
  };
  putBack(Range.prototype, "getClientRects", rectsDesc);
  putBack(HTMLElement.prototype, "getBoundingClientRect", boundsDesc);
  window.getSelection()?.removeAllRanges();
  cleanup();
});

// The store as of the last commit.
const latest: { state: AppState | null } = { state: null };
function Probe() {
  const state = useAppState();
  useEffect(() => {
    latest.state = state;
  });
  return null;
}
function store(): AppState {
  if (!latest.state) throw new Error("no store yet");
  return latest.state;
}
afterEach(() => {
  latest.state = null;
});

function Seed({
  chatDraft,
  children,
}: {
  chatDraft: string;
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    if (chatDraft)
      dispatch({ type: "set_draft", agentId: ASK.agentId, text: chatDraft });
    dispatch({
      type: "users_list",
      users: [
        {
          id: "u1",
          name: "alice",
          role: "member",
          avatarColor: "#336699",
          avatarVariant: 0,
          createdAt: 1,
        },
      ] as unknown as import("../../shared/types.ts").UserPublicWire[],
    });
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "alice",
        role: "member",
      } as import("../../shared/types.ts").SessionContext,
    });
  }, [dispatch, chatDraft]);
  return <>{children}</>;
}

// The cards sit in a scroller of their own, as in the Inbox and the stack.
// `inbox` passes onChatAgent too, as the Inbox does.
async function mount(
  entries: AskEntry[],
  { chatDraft = "", inbox = false } = {},
) {
  const onFocusAgent = mock((_agentId: string) => {});
  const onChatAgent = mock((_agentId: string) => {});
  const view = render(
    <StoreProvider>
      <Seed chatDraft={chatDraft}>
        <Probe />
        <div data-test-scroller="" style={{ overflowY: "auto" }}>
          {entries.map((e) => (
            <AskCard
              key={e.id}
              entry={e}
              isMobile={false}
              onFocusAgent={onFocusAgent}
              onChatAgent={inbox ? onChatAgent : undefined}
            />
          ))}
        </div>
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask-prompt]").length).toBe(
      entries.length,
    ),
  );
  // The enabling state: the seeded chat draft is in the store.
  expect(store().drafts.get(ASK.agentId) ?? "").toBe(chatDraft);
  return { view, onFocusAgent, onChatAgent };
}

function card(view: ReturnType<typeof render>, id: string): HTMLElement {
  return view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
}

function field(view: ReturnType<typeof render>, id: string) {
  return card(view, id).querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
}

function textNodeOf(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(text)) return n as Text;
  throw new Error(`no text node holds ${text}`);
}

// The pill is portalled into <body>: the buttons outside the rendered tree.
function pills(view: ReturnType<typeof render>): HTMLButtonElement[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((b) => !view.container.contains(b));
}

async function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  await act(async () => {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

// Select `text` inside the prompt of ask `id`; resolves once the pill shows.
async function selectInPrompt(
  view: ReturnType<typeof render>,
  id: string,
  text: string,
) {
  const prompt = card(view, id).querySelector("[data-ask-prompt]")!;
  const node = textNodeOf(prompt, text);
  const at = node.textContent!.indexOf(text);
  await select(node, at, node, at + text.length);
  await waitFor(() => expect(pills(view).length).toBe(1));
}

async function press(pill: HTMLButtonElement) {
  await act(async () => {
    fireEvent.pointerDown(pill, { button: 0 });
  });
}

// The block went into the agent's chat draft as `want`; the composer is asked
// for focus with the caret after the block; the ask's reply draft and field
// are as they were, and the field does not take the focus.
async function expectCitedToChat(
  view: ReturnType<typeof render>,
  askId: string,
  want: string,
  reply: { draft: string | undefined; value: string },
) {
  await waitFor(() => expect(store().drafts.get(ASK.agentId)).toBe(want));
  expect(store().pendingComposerFocus.get(ASK.agentId)).toBe(want.length);
  expect(store().askDrafts.get(askId)).toBe(reply.draft);
  const input = field(view, askId);
  expect(input.value).toBe(reply.value);
  expect(document.activeElement === input).toBe(false);
  // The pill and the page selection are gone.
  await waitFor(() => expect(pills(view).length).toBe(0));
  expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
}

it("cites a prompt selection into the agent's chat draft and opens the chat, leaving the untouched reply default", async () => {
  const { view, onFocusAgent } = await mount([ASK]);
  const input = field(view, ASK.id);
  // The enabling state: the field holds the untouched default.
  expect(input.value).toBe("Approve");
  expect(store().askDrafts.has(ASK.id)).toBe(false);
  input.blur();

  await selectInPrompt(view, ASK.id, "First point here.");
  await press(pills(view)[0]);

  await expectCitedToChat(view, ASK.id, citationBlock("First point here."), {
    draft: undefined,
    value: "Approve",
  });
  expect(onFocusAgent.mock.calls).toEqual([[ASK.agentId]]);
});

it("appends a cite after the chat draft with a blank line, and leaves a typed reply as typed", async () => {
  const { view, onFocusAgent } = await mount([ASK], {
    chatDraft: "My question:",
  });
  const input = field(view, ASK.id);
  await act(async () => {
    fireEvent.change(input, { target: { value: "My answers:" } });
  });
  expect(store().askDrafts.get(ASK.id)).toBe("My answers:");
  input.blur();

  await selectInPrompt(view, ASK.id, "Second point there.");
  await press(pills(view)[0]);
  const want = insertCite(
    "My question:",
    citationBlock("Second point there."),
  ).draft;
  expect(want.startsWith("My question:\n\n")).toBe(true);
  await expectCitedToChat(view, ASK.id, want, {
    draft: "My answers:",
    value: "My answers:",
  });

  // A second cite goes after the first.
  await selectInPrompt(view, ASK.id, "First point here.");
  await press(pills(view)[0]);
  await expectCitedToChat(
    view,
    ASK.id,
    insertCite(want, citationBlock("First point here.")).draft,
    { draft: "My answers:", value: "My answers:" },
  );
  expect(onFocusAgent.mock.calls).toEqual([[ASK.agentId], [ASK.agentId]]);
});

it("escapes the dollars of a cite that would render as math in the chat draft", async () => {
  const { view } = await mount([DOLLAR_ASK]);
  await selectInPrompt(view, DOLLAR_ASK.id, "echo $HOME/$USER");
  await press(pills(view)[0]);
  const want = insertCite("", citationBlock("echo $HOME/$USER")).draft;
  // The enabling state: insertCite escapes this block.
  expect(want).toContain("\\$HOME/\\$USER");
  await expectCitedToChat(view, DOLLAR_ASK.id, want, {
    draft: undefined,
    value: "Approve",
  });
});

it("on the Inbox, opens the chat panel on the agent, not the agent's chat", async () => {
  const { view, onFocusAgent, onChatAgent } = await mount([ASK], {
    inbox: true,
  });
  await selectInPrompt(view, ASK.id, "First point here.");
  await press(pills(view)[0]);
  await expectCitedToChat(view, ASK.id, citationBlock("First point here."), {
    draft: undefined,
    value: "Approve",
  });
  expect(onChatAgent.mock.calls).toEqual([[ASK.agentId]]);
  expect(onFocusAgent.mock.calls.length).toBe(0);
});

it("shows no pill for a selection that leaves the prompt", async () => {
  const { view } = await mount([ASK]);
  const prompt = card(view, ASK.id).querySelector("[data-ask-prompt]")!;
  const start = textNodeOf(prompt, "First point");
  // The enabling state: a selection inside the prompt shows the pill.
  await selectInPrompt(view, ASK.id, "First point here.");
  // Into an option button: below the prompt, in the same card.
  const option = textNodeOf(card(view, ASK.id), "Reject");
  expect(prompt.contains(option)).toBe(false);
  await select(start, 0, option, option.length);
  await waitFor(() => expect(pills(view).length).toBe(0));
  // From an option back into the prompt: also none.
  await selectInPrompt(view, ASK.id, "First point here.");
  await select(option, 0, start, 5);
  await waitFor(() => expect(pills(view).length).toBe(0));
});

it("shows no pill on an ask with no agent, which has no chat", async () => {
  const { view } = await mount([NO_AGENT_ASK, ASK]);
  expect(
    card(view, NO_AGENT_ASK.id).querySelectorAll("[data-ask-reply-input]")
      .length,
  ).toBe(0);
  const prompt = card(view, NO_AGENT_ASK.id).querySelector(
    "[data-ask-prompt]",
  )!;
  const node = textNodeOf(prompt, "Nobody reads");
  await select(node, 0, node, node.length);
  // Wait out the hook's frame, then check: the other card's selection below
  // shows a pill through the same frame.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(pills(view).length).toBe(0);
  // The enabling state: the same geometry shows a pill on a card with an agent.
  await selectInPrompt(view, ASK.id, "First point here.");
});

it("hides the pill when a scroller around the card scrolls", async () => {
  const { view } = await mount([ASK]);
  await selectInPrompt(view, ASK.id, "First point here.");
  const scroller = view.container.querySelector("[data-test-scroller]")!;
  await act(async () => {
    // A scroll event does not bubble.
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await waitFor(() => expect(pills(view).length).toBe(0));
  // The selection is still there: only the pill went.
  expect(window.getSelection()?.isCollapsed).toBe(false);
});
