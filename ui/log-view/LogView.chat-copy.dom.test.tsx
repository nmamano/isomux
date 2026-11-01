// The chat bar's Copy offers what to copy (tasks c630195a, 30cd9913) and in
// which format (task 28bd5993): each choice puts its own text on the
// clipboard. What each text holds is pinned in LogEntryCard.test.ts; this file
// pins that each choice reaches it, with the agent's name and the format the
// browser remembers.

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { chatCopyText } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AppState = import("../store.tsx").AppState;
const EN = translatorFor("en");
// A protocol value: the per-browser key the format is saved under.
const FORMAT_KEY = "isomux-chat-copy-format";
const agent = {
  id: "a1",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
  capabilities: { edit: true },
} as unknown as AgentInfo;
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
let copied: string[] = [];
beforeEach(() => {
  copied = [];
  localStorage.setItem("isomux-username", "Other");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});
afterEach(() => {
  localStorage.removeItem("isomux-username");
  localStorage.removeItem(FORMAT_KEY);
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: LogEntry["metadata"],
): LogEntry {
  return { id, agentId: agent.id, timestamp: 1, kind, content, metadata };
}

// The viewer is Tester (the fixture's session); the browser's saved name is
// Other, so a view that read the wrong one copies the wrong message.
const logs: LogEntry[] = [
  entry("u1", "user_message", "First ask.", { username: "Tester" }),
  entry("c1", "tool_call", "Bash", { toolId: "t1", input: "echo one" }),
  entry("r1", "tool_result", "one", { toolUseId: "t1" }),
  entry("x1", "text", "First *reply*."),
  entry("u2", "user_message", "Second ask.", { username: "Other" }),
  entry("c2", "tool_call", "Bash", { toolId: "t2", input: "echo two" }),
  entry("r2", "tool_result", "two", { toolUseId: "t2" }),
  entry("x2", "text", "Second reply."),
];

const scopes = [
  "messages",
  "myMessages",
  "everything",
  "lastExchange",
] as const;

function mountView(over: Partial<AppState> = {}) {
  const view = render(
    onLanguage(
      null,
      createElement(LogView, { agent, logs, onBack() {}, onEditAgent() {} }),
      {
        agents: [agent],
        rooms: [
          { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
        isMobile: false,
        ...over,
      },
    ),
  );
  const triggers = view.container.querySelectorAll(
    'button[aria-haspopup="menu"]',
  );
  // Copy is the bar's one action with a menu.
  expect(triggers.length).toBe(1);
  const menuItem = (id: string) =>
    document.querySelector(
      `[data-nav-menu="copy"] [data-nav-menu-item="${id}"]`,
    );
  const open = () => {
    if (!document.querySelector('[data-nav-menu="copy"]'))
      fireEvent.click(triggers[0]);
    expect(document.querySelector('[data-nav-menu="copy"]')).not.toBeNull();
  };
  const choose = async (id: string) => {
    open();
    const item = menuItem(id);
    expect(item).not.toBeNull();
    await act(async () => {
      fireEvent.click(item!);
    });
  };
  const checked = () => {
    open();
    return ["markdown", "plain"].filter(
      (id) => menuItem(id)?.getAttribute("aria-checked") === "true",
    );
  };
  return { view, choose, checked, menuItem };
}

// Clicks each Copy choice in menu order and returns what each one copied.
async function copyEach(over: Partial<AppState>): Promise<string[]> {
  const { view, choose } = mountView(over);
  for (const scope of scopes) await choose(scope);
  view.unmount();
  return copied;
}

const opts = (self: string | null, format: "markdown" | "plain") => ({
  self,
  agentName: agent.name,
  format,
});

it("each Copy choice puts its own text on the clipboard", async () => {
  const expected = scopes.map((s) =>
    chatCopyText(EN, logs, s, opts("Tester", "markdown")),
  );
  // The fixture tells the four apart, so a swapped choice shows.
  expect(new Set(expected).size).toBe(4);
  expect(
    chatCopyText(EN, logs, "myMessages", opts("Other", "markdown")),
  ).not.toBe(expected[1]);
  // The agent's name labels its replies, so a view that passed another name
  // copies other text.
  expect(
    chatCopyText(EN, logs, "everything", {
      ...opts("Tester", "markdown"),
      agentName: "Someone",
    }),
  ).not.toBe(expected[2]);
  expect(await copyEach({})).toEqual(expected);
});

it("My messages falls back to the browser's saved name with no session", async () => {
  const mine = chatCopyText(EN, logs, "myMessages", opts("Other", "markdown"));
  expect(mine).not.toBe(
    chatCopyText(EN, logs, "myMessages", opts("Tester", "markdown")),
  );
  expect(mine).not.toBe(
    chatCopyText(EN, logs, "myMessages", opts(null, "markdown")),
  );
  expect((await copyEach({ sessionContext: null }))[1]).toBe(mine);
});

it("a format choice keeps the menu open, applies to the next copy, and is remembered", async () => {
  const markdown = chatCopyText(
    EN,
    logs,
    "everything",
    opts("Tester", "markdown"),
  );
  const plain = chatCopyText(EN, logs, "everything", opts("Tester", "plain"));
  // The fixture's reply has Markdown, so the two formats differ.
  expect(plain).not.toBe(markdown);

  const first = mountView();
  // Markdown until the browser picks another.
  expect(first.checked()).toEqual(["markdown"]);
  await first.choose("plain");
  // Picking a format copies nothing and leaves the choices open.
  expect(copied).toEqual([]);
  expect(first.menuItem("plain")).not.toBeNull();
  expect(first.checked()).toEqual(["plain"]);
  await first.choose("everything");
  expect(copied).toEqual([plain]);
  first.view.unmount();

  // A later chat in this browser starts in Plain text.
  const second = mountView();
  expect(second.checked()).toEqual(["plain"]);
  await second.choose("everything");
  await second.choose("markdown");
  expect(second.checked()).toEqual(["markdown"]);
  await second.choose("everything");
  expect(copied).toEqual([plain, plain, markdown]);
  second.view.unmount();

  const third = mountView();
  expect(third.checked()).toEqual(["markdown"]);
  third.view.unmount();
});

it("a saved format this build does not know copies Markdown", async () => {
  localStorage.setItem(FORMAT_KEY, "html");
  const { view, checked, choose } = mountView();
  expect(checked()).toEqual(["markdown"]);
  await choose("everything");
  expect(copied).toEqual([
    chatCopyText(EN, logs, "everything", opts("Tester", "markdown")),
  ]);
  view.unmount();
});
