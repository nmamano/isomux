// The chat bar's Copy offers what to copy (tasks c630195a, 30cd9913): each
// choice puts its own text on the clipboard. What each text holds is pinned in
// LogEntryCard.test.ts; this file pins that each choice reaches it.

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
  entry("x1", "text", "First reply."),
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

// Clicks each Copy choice in menu order and returns what each one copied.
async function copyEach(over: Partial<AppState>): Promise<string[]> {
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
  for (const scope of scopes) {
    fireEvent.click(triggers[0]);
    const item = document.querySelector(
      `[data-nav-menu="copy"] [data-nav-menu-item="${scope}"]`,
    );
    expect(item).not.toBeNull();
    await act(async () => {
      fireEvent.click(item!);
    });
  }
  view.unmount();
  return copied;
}

it("each Copy choice puts its own text on the clipboard", async () => {
  const expected = scopes.map((s) => chatCopyText(EN, logs, s, "Tester"));
  // The fixture tells the four apart, so a swapped choice shows.
  expect(new Set(expected).size).toBe(4);
  expect(chatCopyText(EN, logs, "myMessages", "Other")).not.toBe(expected[1]);
  expect(await copyEach({})).toEqual(expected);
});

it("My messages falls back to the browser's saved name with no session", async () => {
  const mine = chatCopyText(EN, logs, "myMessages", "Other");
  expect(mine).not.toBe(chatCopyText(EN, logs, "myMessages", "Tester"));
  expect(mine).not.toBe(chatCopyText(EN, logs, "myMessages", null));
  expect((await copyEach({ sessionContext: null }))[1]).toBe(mine);
});
