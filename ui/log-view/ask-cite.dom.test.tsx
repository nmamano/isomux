// Cite on an ask card (task ad4b51ac): a selection inside the ask's prompt
// shows the Cite pill, and the pill puts the selection into the ask's reply
// field. AskCard is the card of the chat's ask stack and of the Inbox. The
// pill's place and a real mouse need a browser and are not checked here.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AskCard } = await import("./AskCard.tsx");
const { citationBlock, insertCite } = await import("./cite.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;

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

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
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
  }, [dispatch]);
  return <>{children}</>;
}

// The cards sit in a scroller of their own, as in the Inbox and the stack.
async function mount(entries: AskEntry[]) {
  const view = render(
    <StoreProvider>
      <Seed>
        <div data-test-scroller="" style={{ overflowY: "auto" }}>
          {entries.map((e) => (
            <AskCard key={e.id} entry={e} isMobile={false} />
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
  return view;
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

it("cites a prompt selection over the untouched default, and focuses the field after it", async () => {
  const view = await mount([ASK]);
  const input = field(view, ASK.id);
  // The enabling state: the field holds the untouched default.
  expect(input.value).toBe("Approve");
  input.blur();
  expect(document.activeElement).not.toBe(input);

  await selectInPrompt(view, ASK.id, "First point here.");
  await press(pills(view)[0]);

  const block = citationBlock("First point here.");
  await waitFor(() => expect(input.value).toBe(block));
  // The field has focus, with the caret after the block: not the whole
  // field selected again, as a focus on the untouched default does.
  await waitFor(() => expect(document.activeElement === input).toBe(true));
  expect([input.selectionStart, input.selectionEnd]).toEqual([
    block.length,
    block.length,
  ]);
  // The pill and the page selection are gone.
  await waitFor(() => expect(pills(view).length).toBe(0));
  expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
});

it("appends a cite to a typed reply after a blank line", async () => {
  const view = await mount([ASK]);
  const input = field(view, ASK.id);
  await act(async () => {
    fireEvent.change(input, { target: { value: "My answers:" } });
  });
  expect(input.value).toBe("My answers:");
  input.blur();

  await selectInPrompt(view, ASK.id, "Second point there.");
  await press(pills(view)[0]);

  const want = insertCite(
    "My answers:",
    citationBlock("Second point there."),
  ).draft;
  await waitFor(() => expect(input.value).toBe(want));
  expect(input.value.startsWith("My answers:\n\n")).toBe(true);
  // A second cite goes after the first. A drag in the prompt takes the
  // focus off the field in a browser; happy-dom keeps it, so blur.
  input.blur();
  await selectInPrompt(view, ASK.id, "First point here.");
  await press(pills(view)[0]);
  await waitFor(() =>
    expect(input.value).toBe(
      insertCite(want, citationBlock("First point here.")).draft,
    ),
  );
});

it("shows no pill for a selection that leaves the prompt", async () => {
  const view = await mount([ASK]);
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

it("shows no pill on an ask with no agent, which has no reply field", async () => {
  const view = await mount([NO_AGENT_ASK, ASK]);
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
  const view = await mount([ASK]);
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
