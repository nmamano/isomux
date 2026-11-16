// A reply that is only the no-update keyword (task 51c187f4; Nil
// 2026-11-16: "let's designate a special keyword"). The chat draws no card
// for it: it folds into the line of the agent traffic around it, which says
// that nothing is for the member, and the keyword never shows as text. The
// phrase of older logs folds the same. Which entries a run holds:
// tool-call-groups.test.ts; what a copy holds: LogEntryCard.test.ts.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { NO_UPDATE } = await import("../../shared/no-update.ts");
const { logTextFields, msg } = await import("../../shared/i18n/log-message.ts");

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AppState = import("../store.tsx").AppState;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

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

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: LogEntry["metadata"],
): LogEntry {
  return { id, agentId: agent.id, timestamp: 1, kind, content, metadata };
}
const shellCall = (id: string, command: string) =>
  entry(id, "tool_call", "Bash", { toolId: `${id}-t`, input: { command } });
const done = (id: string, callId: string, content = "ok") =>
  entry(id, "tool_result", content, { toolUseId: `${callId}-t` });
const AUTH = `-H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`;
const send = (id: string, to: string) =>
  shellCall(
    id,
    `curl -s -X POST "localhost:4000/api/agents/${to}/messages" ${AUTH} -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nSEND-${id}\nEOF`,
  );
const peerMessage = (id: string) =>
  entry(id, "user_message", `PEER-${id}`, {
    sender_agent_id: "a2",
    sender_agent_name: "Helper",
    sender_agent_room: "Room",
  });
const member = (id: string, text: string) =>
  entry(id, "user_message", text, { username: "Tester" });
const quiet = (id: string) => entry(id, "text", NO_UPDATE);
const LEGACY_WORDS = "nothing to bring to the members";
const legacy = (id: string) =>
  entry(id, "text", "_(nothing to bring to the members' attention)_");

const self = selfUserRecord(null);
const usersWith = (record: typeof self) =>
  new Map([[record.name.toLowerCase(), record]]);
const showsBoth = usersWith({
  ...self,
  showToolCalls: true as const,
  showAgentMessages: true as const,
});
const showsTools = usersWith({ ...self, showToolCalls: true as const });
const withPeer = {
  agents: [agent, { ...agent, id: "a2", name: "Helper" } as AgentInfo],
} as Partial<AppState>;

function mount(over: Partial<AppState>, logs: LogEntry[]) {
  return render(
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
}

// The words the line adds for a run with the keyword: after the counts, or
// alone (capitalised by its own key).
const EN = translatorFor("en");
// The keys come with the change, so they are looked up untyped.
const word = EN.t.bind(EN) as unknown as (key: string) => string;
const QUIET = word("cards.toolCall.hiddenQuiet");
const QUIET_ONLY = word("cards.toolCall.hiddenQuietOnly");
// Two messages in and one send out.
const MESSAGES_3 = EN.tn("cards.toolCall.hiddenMessages", 3);

// The chat entries drawn at the top level, without the results that fold
// into their call's card.
const drawn = (root: ParentNode, entries: LogEntry[]) => {
  const callIds = new Set(
    entries
      .filter((e) => e.kind === "tool_call")
      .map((e) => e.metadata?.toolId),
  );
  return Array.from(root.querySelectorAll("[data-log-entry-id]"))
    .map((el) => el.getAttribute("data-log-entry-id")!)
    .filter((id) => {
      const e = entries.find((x) => x.id === id);
      return !(e?.kind === "tool_result" && callIds.has(e.metadata?.toolUseId));
    });
};
const wrapOf = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-log-entry-id="${id}"]`)!;
const toggles = (root: ParentNode) =>
  root.querySelectorAll<HTMLElement>("button[data-hidden-steps]");
const copyButtons = (root: ParentNode) =>
  root.querySelectorAll<HTMLElement>(`button[title="${en["common.copy"]}"]`);
const keywordShown = (root: ParentNode) => ({
  keyword: root.textContent!.includes(NO_UPDATE),
  legacy: root.textContent!.includes(LEGACY_WORDS),
});
const HIDDEN = { keyword: false, legacy: false };

async function withClipboard(body: (copied: string[]) => Promise<void>) {
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  try {
    await body(copied);
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
}

// Helper writes twice; each time the agent works, and has nothing for the
// member. The second turn ends with the phrase of older logs.
const traffic: LogEntry[] = [
  member("u1", "Keep an eye on Helper."),
  entry("x1", "text", "Watching."),
  peerMessage("p1"),
  shellCall("c1", "echo STEP-ONE"),
  done("r1", "c1"),
  quiet("q1"),
  peerMessage("p2"),
  send("s1", "a2"),
  done("s1r", "s1", '{"messageId":"m1"}'),
  legacy("q2"),
];

it("back-to-back turns that end with the keyword are one closed line that says nothing is for the member", () => {
  const view = mount(withPeer, traffic);
  const chat = view.container;
  expect(drawn(chat, traffic)).toEqual(["u1", "x1", "p1"]);
  expect(toggles(chat).length).toBe(1);
  const line = toggles(wrapOf(chat, "p1"))[0];
  expect(line.textContent).toContain(MESSAGES_3);
  expect(line.textContent).toContain(QUIET);
  expect(keywordShown(chat)).toEqual(HIDDEN);
  // The words come from the catalog.
  expect(QUIET).not.toBe("cards.toolCall.hiddenQuiet");
  view.unmount();
});

// What the copy buttons in `root` copy, without the button each message
// from another agent carries for its own text ("PEER-<id>"): what is left is
// the turn's copy.
async function turnCopies(root: ParentNode): Promise<string[]> {
  let texts: string[] = [];
  // A clicked button changes its title for a moment, so take them first.
  const buttons = Array.from(copyButtons(root));
  await withClipboard(async (copied) => {
    for (const button of buttons)
      await act(async () => {
        fireEvent.click(button);
      });
    texts = copied;
  });
  expect(texts.length).toBe(buttons.length);
  return texts.filter((text) => !/^PEER-[\w-]+$/.test(text));
}

// A turn that ends with nothing for the member has nothing to copy (sign-off
// of task 51c187f4, Nil 2026-11-16: "no copy button beside it").
it("the open line shows the traffic and still no keyword, and a line that ends with the keyword has no copy button", async () => {
  const view = mount(withPeer, traffic);
  const chat = view.container;
  const wrap = wrapOf(chat, "p1");
  expect(copyButtons(wrap).length).toBe(0);
  fireEvent.click(toggles(wrap)[0]);
  expect(wrap.querySelector("button[data-hidden-steps-open]")).not.toBeNull();
  expect(chat.textContent).toContain("PEER-p2");
  expect(chat.textContent).toContain("SEND-s1");
  expect(keywordShown(chat)).toEqual(HIDDEN);
  expect(await turnCopies(wrap)).toEqual([]);
  view.unmount();
  // The same line without the closing keyword ends the turn with a step:
  // closed and open, it carries the turn's copy button, which copies the turn.
  const without = traffic.filter((e) => e.id !== "q2");
  const control = mount(withPeer, without);
  const controlWrap = wrapOf(control.container, "p1");
  expect(drawn(control.container, without)).toEqual(["u1", "x1", "p1"]);
  expect(copyButtons(controlWrap).length).toBe(1);
  const closed = await turnCopies(controlWrap);
  expect(closed.length).toBe(1);
  expect(closed[0]).toContain("SEND-s1");
  fireEvent.click(toggles(controlWrap)[0]);
  const open = await turnCopies(controlWrap);
  expect(open.length).toBe(1);
  expect(open[0]).toContain("SEND-s1");
  control.unmount();
});

it("a turn that is only the keyword is a still line: nothing to open, nothing to copy or speak", () => {
  const logs = [member("u1", "Thanks."), quiet("q1")];
  for (const over of [withPeer, { ...withPeer, users: showsBoth }]) {
    const view = mount(over, logs);
    const chat = view.container;
    expect(drawn(chat, logs)).toEqual(["u1", "q1"]);
    const wrap = wrapOf(chat, "q1");
    expect(wrap.querySelectorAll("button").length).toBe(0);
    expect(QUIET_ONLY).not.toBe("cards.toolCall.hiddenQuietOnly");
    expect(wrap.textContent).toContain(QUIET_ONLY);
    expect(keywordShown(chat)).toEqual(HIDDEN);
    view.unmount();
  }
});

it("a member who shows tool calls and agent messages sees them, and the keyword is a line of its own", () => {
  const logs = traffic.slice(0, 6);
  const view = mount({ ...withPeer, users: showsBoth }, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "x1", "p1", "c1", "q1"]);
  expect(chat.textContent).toContain("PEER-p1");
  const wrap = wrapOf(chat, "q1");
  expect(wrap.textContent).toContain(QUIET_ONLY);
  expect(wrap.querySelectorAll("button[aria-expanded]").length).toBe(0);
  expect(keywordShown(chat)).toEqual(HIDDEN);
  view.unmount();
});

it("a reply with other words is a reply card, keyword and all", () => {
  const logs = [
    member("u1", "Status?"),
    entry("x1", "text", `All green.\n\n${NO_UPDATE}`),
    member("u2", "And before?"),
    entry(
      "x2",
      "text",
      "Approved.\n\n_(nothing to bring to the members' attention)_",
    ),
  ];
  const view = mount(withPeer, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "x1", "u2", "x2"]);
  expect(toggles(chat).length).toBe(0);
  expect(wrapOf(chat, "x1").textContent).toContain("All green.");
  expect(wrapOf(chat, "x1").textContent).toContain(NO_UPDATE);
  expect(wrapOf(chat, "x2").textContent).toContain(LEGACY_WORDS);
  view.unmount();
});

// The keyword's still line ends a turn that has cards the member sees: the
// turn ended with nothing for the member, so it has no copy button. The same
// chat without the keyword has one on the turn's last card.
it("a still line after shown cards takes the turn's copy button away", () => {
  const cases: [string, Partial<AppState>, LogEntry[], string][] = [
    [
      "shows both",
      { ...withPeer, users: showsBoth },
      [member("u1", "Go."), shellCall("c1", "echo STEP-ONE"), done("r1", "c1")],
      "c1",
    ],
    [
      "shows tool calls",
      { ...withPeer, users: showsTools },
      [
        member("u1", "Go."),
        peerMessage("p1"),
        shellCall("c1", "echo STEP-ONE"),
        done("r1", "c1"),
      ],
      "c1",
    ],
  ];
  for (const [label, over, logs, lastCard] of cases) {
    const without = mount(over, logs);
    expect({
      label,
      without: copyButtons(wrapOf(without.container, lastCard)).length,
    }).toEqual({ label, without: 1 });
    without.unmount();
    const withQuiet = [...logs, quiet("q1")];
    const view = mount(over, withQuiet);
    const chat = view.container;
    expect({ label, drawn: drawn(chat, withQuiet).at(-1) }).toEqual({
      label,
      drawn: "q1",
    });
    expect(wrapOf(chat, "q1").textContent).toContain(QUIET_ONLY);
    for (const id of [lastCard, "q1"])
      expect({
        label,
        id,
        copies: copyButtons(wrapOf(chat, id)).length,
      }).toEqual({ label, id, copies: 0 });
    view.unmount();
  }
});

// The line the office writes when it resumes an agent after a restart (Nil
// 2026-11-16, sign-off of task 51c187f4: "After a restart, fold the next
// quiet turn into the same line: one \"nothing for you\", and no copy button
// beside it"). Which entries a run holds: tool-call-groups.test.ts.
const restart = (id: string) => ({
  ...entry(id, "system", ""),
  ...logTextFields(msg("systemEntries.restartWake.resumed")),
});
const RESTARTED = EN.t("systemEntries.restartWake.resumed");

it("a restart between quiet turns of agent traffic is one line, one nothing new for you, no copy button", async () => {
  // Nil's sign-off image: three turns, the server restarted in the third.
  const logs = [
    member("u1", "Restart the server when Main asks."),
    entry("x1", "text", "OK."),
    peerMessage("p1"),
    shellCall("c1", "echo STEP-ONE"),
    done("r1", "c1"),
    quiet("q1"),
    peerMessage("p2"),
    shellCall("c2", "echo STEP-TWO"),
    done("r2", "c2"),
    quiet("q2"),
    peerMessage("p3"),
    shellCall("c3", "echo STEP-THREE"),
    restart("R"),
    quiet("q3"),
  ];
  const view = mount(withPeer, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "x1", "p1"]);
  expect(toggles(chat).length).toBe(1);
  expect(chat.querySelectorAll("[data-hidden-quiet]").length).toBe(0);
  const wrap = wrapOf(chat, "p1");
  expect(toggles(wrap)[0].textContent).toContain(QUIET);
  expect(chat.textContent!.split(QUIET).length - 1).toBe(1);
  expect(chat.textContent).not.toContain(RESTARTED);
  expect(copyButtons(wrap).length).toBe(0);
  // Open, it shows the restart line among the cards, and still no copy.
  fireEvent.click(toggles(wrap)[0]);
  expect(wrap.textContent).toContain("STEP-THREE");
  expect(wrap.textContent).toContain(RESTARTED);
  expect(await turnCopies(wrap)).toEqual([]);
  expect(keywordShown(chat)).toEqual(HIDDEN);
  view.unmount();
});

it("a restart folded between replies that are only the keyword is a line that opens to show it", () => {
  // A member who shows everything: the run is only the keyword and the
  // restart line. A still line would hide the restart line for good.
  const logs = [
    member("u1", "Watch."),
    entry("x1", "text", "Watching."),
    quiet("q1"),
    restart("R"),
    quiet("q2"),
  ];
  const view = mount({ ...withPeer, users: showsBoth }, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "x1", "q1"]);
  expect(chat.querySelectorAll("[data-hidden-quiet]").length).toBe(0);
  expect(chat.textContent).not.toContain(RESTARTED);
  const wrap = wrapOf(chat, "q1");
  expect(toggles(wrap).length).toBe(1);
  expect(toggles(wrap)[0].textContent).toContain(QUIET);
  fireEvent.click(toggles(wrap)[0]);
  expect(wrap.textContent).toContain(RESTARTED);
  expect(keywordShown(chat)).toEqual(HIDDEN);
  expect(copyButtons(wrap).length).toBe(0);
  view.unmount();
});

// A result that comes after the keyword folds into its call's card, so a
// run of the keyword and such a result has nothing to show either.
it("a run of the keyword and a folded result is still a still line", () => {
  const logs = [
    member("u1", "Go."),
    shellCall("c1", "echo STEP-ONE"),
    quiet("q1"),
    done("r1", "c1"),
  ];
  const view = mount({ ...withPeer, users: showsBoth }, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "c1", "q1"]);
  const wrap = wrapOf(chat, "q1");
  expect(wrap.querySelectorAll("[data-hidden-quiet]").length).toBe(1);
  expect(wrap.querySelectorAll("button[aria-expanded]").length).toBe(0);
  expect(wrap.textContent).toContain(QUIET_ONLY);
  view.unmount();
});

it("a restart before a reply card stays a line of its own", () => {
  const logs = [
    member("u1", "Status?"),
    peerMessage("p1"),
    shellCall("c1", "echo STEP-ONE"),
    restart("R"),
    entry("x1", "text", "All green."),
  ];
  const view = mount(withPeer, logs);
  const chat = view.container;
  expect(drawn(chat, logs)).toEqual(["u1", "p1", "R", "x1"]);
  expect(wrapOf(chat, "R").textContent).toContain(RESTARTED);
  view.unmount();
});
