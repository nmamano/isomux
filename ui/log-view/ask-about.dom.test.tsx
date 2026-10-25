// "About your ask" on a card in the agent's chat (task 715ab3dd): the button
// puts a prefix that quotes the start of the question in front of the chat
// draft, focuses the composer with the caret after the prefix, and calls no
// ask route; the message the member then sends leaves the ask open. The Inbox
// path, where the chat mounts after the click, is in
// ui/App.inbox-ask-about.dom.test.tsx.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { _resetOutboxForTests } = await import("./outbox.ts");
const { askExcerpt } = await import("./ask-about.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = import("../store.tsx").AppState;

const AGENT = {
  id: "about-agent",
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

// Long enough to be cut, so the excerpt and the whole prompt differ.
const REPLY_ASK: AskEntry = {
  id: "ask00001",
  agentId: AGENT.id,
  memberUserId: "u1",
  prompt: "Should we move the nightly backups to the desktop box tonight?",
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  options: ["Yes", "No"],
};
const SECRET_ASK: AskEntry = {
  id: "ask00002",
  agentId: AGENT.id,
  memberUserId: "u1",
  prompt: "To open the pull request.",
  createdAt: Date.now() - 30_000,
  updatedAt: Date.now() - 30_000,
  secret: {
    requestId: "req-1",
    scope: "personal",
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    form: { kind: "authorization" },
    reason: "To open the pull request.",
  },
};

// Every API call the page makes, in order.
let calls: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  _resetOutboxForTests();
  calls = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return {};
  });
});
afterAll(() => setApiShim(null));

const askCalls = () => calls.filter((c) => c.path.includes("/asks"));
const messagePosts = () =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));

function mount(draft: string) {
  const seeded: AppState = stateWithSelfUser(null, {
    agents: [AGENT],
    rooms: [
      { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
    ] as AppState["rooms"],
    asks: [REPLY_ASK, SECRET_ASK],
    drafts: draft ? new Map([[AGENT.id, draft]]) : new Map(),
    hasReceivedInitialState: true,
    connected: true,
    isMobile: false,
  });
  const latest: { state: AppState } = { state: seeded };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    latest.state = state;
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
  return { view: render(createElement(Harness)), latest };
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const all = container.querySelectorAll("textarea");
  return all[all.length - 1];
}

function aboutButton(container: HTMLElement, askId: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-ask="${askId}"] button[data-ask-about]`,
  );
  if (!button) throw new Error(`no about button on ask ${askId}`);
  return button;
}

// A click with no wait after it: the composer takes focus inside the click,
// not a frame later, since a phone browser opens its keyboard only for a focus
// inside the tap.
function click(button: HTMLButtonElement) {
  act(() => {
    fireEvent.click(button);
  });
}

function blurComposer(container: HTMLElement) {
  const ta = composer(container);
  ta.blur();
  expect(document.activeElement === ta).toBe(false);
}

// The composer holds a prefix that quotes the excerpt, then `rest`; it has
// focus, with the caret right after the prefix.
function expectPrefixed(container: HTMLElement, ask: AskEntry, rest: string) {
  const ta = composer(container);
  // A boolean, not toBe on two nodes: a red run would serialise both.
  expect(document.activeElement === ta).toBe(true);
  const value = ta.value;
  expect(value.endsWith(rest)).toBe(true);
  const prefix = value.slice(0, value.length - rest.length);
  expect(prefix).toContain(`"${askExcerpt(ask.prompt)}"`);
  expect(prefix.endsWith(" ")).toBe(true);
  expect(ta.selectionStart).toBe(prefix.length);
  expect(ta.selectionEnd).toBe(prefix.length);
}

it("puts the prefix in front of the typed draft, focuses after it, and calls no ask route", async () => {
  const { view, latest } = mount("and the tag?");
  // The member was in the reply field, not the composer.
  const reply = view.container.querySelector<HTMLInputElement>(
    '[data-ask="ask00001"] input[data-ask-reply-input]',
  )!;
  reply.focus();
  expect(document.activeElement === reply).toBe(true);

  click(aboutButton(view.container, "ask00001"));
  expectPrefixed(view.container, REPLY_ASK, "and the tag?");
  // The quote is the excerpt, not the whole question.
  expect(composer(view.container).value).not.toContain(REPLY_ASK.prompt);
  // The store holds the same draft, and the focus request is spent.
  expect(latest.state.drafts.get(AGENT.id)).toBe(
    composer(view.container).value,
  );
  expect(latest.state.pendingComposerFocus.has(AGENT.id)).toBe(false);
  expect(askCalls()).toEqual([]);
  expect(view.container.querySelector('[data-ask="ask00001"]')).not.toBeNull();
  view.unmount();
});

it("sends the prefixed message as a normal chat message, and the ask stays open", async () => {
  const { view, latest } = mount("");
  // The composer does not hold focus before the click.
  blurComposer(view.container);
  click(aboutButton(view.container, "ask00001"));
  expectPrefixed(view.container, REPLY_ASK, "");
  const ta = composer(view.container);
  const typed = ta.value + "why tonight?";
  fireEvent.change(ta, { target: { value: typed } });
  await act(async () => {
    fireEvent.keyDown(composer(view.container), { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(messagePosts().length).toBe(1));
  const post = messagePosts()[0];
  expect(post.path).toBe(`/api/agents/${AGENT.id}/messages`);
  expect((post.body as { text: string }).text).toBe(typed);
  // No ask route, and the card and its store entry are still there.
  expect(askCalls()).toEqual([]);
  expect(latest.state.asks.map((a) => a.id)).toContain("ask00001");
  expect(view.container.querySelector('[data-ask="ask00001"]')).not.toBeNull();
  view.unmount();
});

it("has the button on a secret request too, quoting its own question", async () => {
  const { view } = mount("");
  // The composer does not hold focus before the click.
  blurComposer(view.container);
  click(aboutButton(view.container, "ask00002"));
  expectPrefixed(view.container, SECRET_ASK, "");
  expect(askCalls()).toEqual([]);
  expect(view.container.querySelector('[data-ask="ask00002"]')).not.toBeNull();
  view.unmount();
});
