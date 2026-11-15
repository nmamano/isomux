// Tool calls in the chat (task e7579473, Nil 2026-11-15: "for non-technical
// folks who would get overwhelmed by anything that looks like terminal
// commands"). A member's chat folds every tool step that is not an office
// action into one "N steps" line, unless their record says showToolCalls.
// The default is folded, so a record that has not arrived yet folds too: a
// page load never flashes the commands. Which entries a run holds is pinned
// in tool-call-groups.test.ts; this file pins the chat that LogView draws
// from the member's record. The export shows everything:
// LogView.chat-copy.dom.test.tsx.

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
const shellCall = (id: string, command: string, name = "Bash") =>
  entry(id, "tool_call", name, { toolId: `${id}-t`, input: { command } });
const done = (id: string, callId: string, content = "ok") =>
  entry(id, "tool_result", content, { toolUseId: `${callId}-t` });

const OFFICE = "curl -s localhost:4000/api/tasks";
// Each command shows on its card, so a marker in the page means a card shows.
const logs: LogEntry[] = [
  entry("u1", "user_message", "Tidy up.", { username: "Tester" }),
  shellCall("c1", "echo HIDE-ONE"),
  done("r1", "c1"),
  entry("x1", "text", "First part done."),
  shellCall("c2", "echo HIDE-TWO"),
  done("r2", "c2"),
  shellCall("o1", OFFICE),
  done("o1r", "o1", "[]"),
  entry("x2", "text", "All done."),
];
const MARKERS = ["HIDE-ONE", "HIDE-TWO"];

const self = selfUserRecord(null);
const showing = { ...self, showToolCalls: true as const };
const usersWith = (record: typeof self) =>
  new Map([[record.name.toLowerCase(), record]]);

function mount(over: Partial<AppState>, props = { agent, logs }) {
  const tree = (p: typeof props, o: Partial<AppState>) =>
    onLanguage(
      null,
      createElement(LogView, { ...p, onBack() {}, onEditAgent() {} }),
      {
        agents: [p.agent],
        rooms: [
          { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
        isMobile: false,
        ...o,
      },
    );
  const view = render(tree(props, over));
  return {
    view,
    rerender: (p: typeof props, o: Partial<AppState> = over) =>
      view.rerender(tree(p, o)),
  };
}

const runLines = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>("button[data-hidden-steps]"));
// The chat entries drawn at the top level, in order. A result paired with a
// call in the chat folds into that call's card (it draws nothing), so it is
// left out whichever way the chat holds it.
const drawn = (root: ParentNode, entries: LogEntry[] = logs) => {
  const callIds = new Set(
    entries
      .filter((e) => e.kind === "tool_call")
      .map((e) => e.metadata?.toolId),
  );
  const folded = new Set(
    entries
      .filter(
        (e) =>
          e.kind === "tool_result" &&
          !e.attachments?.length &&
          callIds.has(e.metadata?.toolUseId),
      )
      .map((e) => e.id),
  );
  return Array.from(root.querySelectorAll("[data-log-entry-id]"))
    .map((el) => el.getAttribute("data-log-entry-id"))
    .filter((id) => !folded.has(id!));
};
const shown = (root: ParentNode) =>
  MARKERS.filter((m) => root.textContent?.includes(m));

it("folds the tool calls by default: one line per run, office actions and replies stay", () => {
  const { view } = mount({});
  const chat = view.container;
  expect(shown(chat)).toEqual([]);
  expect(runLines(chat).length).toBe(2);
  // The runs sit where their first call was; the office card and the
  // replies are drawn on their own.
  expect(drawn(chat)).toEqual(["u1", "c1", "x1", "c2", "o1", "x2"]);
  for (const id of ["c1", "c2"])
    expect(
      chat.querySelector(
        `[data-log-entry-id="${id}"] button[data-hidden-steps]`,
      ),
    ).not.toBeNull();
  expect(
    chat.querySelector(`[data-log-entry-id="o1"] button[data-hidden-steps]`),
  ).toBeNull();
  expect(chat.textContent).toContain("All done.");
  view.unmount();
});

it("a tap on a run's line opens its cards", () => {
  const { view } = mount({});
  const chat = view.container;
  fireEvent.click(runLines(chat)[0]);
  expect(shown(chat)).toEqual(["HIDE-ONE"]);
  view.unmount();
});

it("shows every tool call to a member whose record says showToolCalls", () => {
  const { view } = mount({ users: usersWith(showing) });
  expect(runLines(view.container).length).toBe(0);
  expect(shown(view.container)).toEqual(MARKERS);
  view.unmount();
});

it("folds while the member's record has not arrived, and with no session", () => {
  for (const over of [
    { users: new Map() },
    { users: new Map(), sessionContext: null },
  ] as Partial<AppState>[]) {
    const { view } = mount(over);
    expect(runLines(view.container).length).toBe(2);
    expect(shown(view.container)).toEqual([]);
    view.unmount();
  }
});

it("a record that arrives with showToolCalls opens the chat in place", () => {
  const { view, rerender } = mount({ users: new Map() });
  expect(runLines(view.container).length).toBe(2);
  rerender({ agent, logs }, { users: usersWith(showing) });
  expect(runLines(view.container).length).toBe(0);
  expect(shown(view.container)).toEqual(MARKERS);
  view.unmount();
});

// OpenCode names its shell tool "shell": its office calls stay office
// cards, its other commands fold.
it("an OpenCode office call stays on its own while its other shell commands fold", () => {
  const opencode = [
    entry("u1", "user_message", "Go.", { username: "Tester" }),
    shellCall("s1", "echo HIDE-ONE", "shell"),
    done("s1r", "s1"),
    shellCall("o1", OFFICE, "shell"),
    done("o1r", "o1", "[]"),
    entry("x1", "text", "Done."),
  ];
  const { view } = mount({}, { agent, logs: opencode });
  const chat = view.container;
  expect(shown(chat)).toEqual([]);
  expect(runLines(chat).length).toBe(1);
  expect(drawn(chat, opencode)).toEqual(["u1", "s1", "o1", "x1"]);
  expect(
    chat.querySelector(`[data-log-entry-id="o1"] button[data-hidden-steps]`),
  ).toBeNull();
  view.unmount();
});

// An image a tool returned (a screenshot) is no terminal text: it shows,
// and the call that made it folds.
it("a tool result with an image shows on its own", () => {
  const withImage = [
    entry("u1", "user_message", "Look.", { username: "Tester" }),
    shellCall("c1", "echo HIDE-ONE"),
    {
      ...done("r1", "c1"),
      attachments: [
        {
          filename: "hash.png",
          originalName: "shot.png",
          mediaType: "image/png",
          size: 10,
        },
      ],
    } as LogEntry,
    entry("x1", "text", "Here."),
  ];
  const { view } = mount({}, { agent, logs: withImage });
  const chat = view.container;
  expect(shown(chat)).toEqual([]);
  expect(drawn(chat, withImage)).toEqual(["u1", "c1", "r1", "x1"]);
  expect(chat.querySelector(`[data-log-entry-id="r1"] img`)).not.toBeNull();
  view.unmount();
});

// While the agent works, the run it adds to stays one line however long it
// grows (no live tail of open cards), and a member who opened it keeps it
// open as steps arrive.
it("a live run stays one line past the live tail cap, and stays open as it grows", () => {
  const busy = { ...agent, state: "tool_executing" } as AgentInfo;
  const STEPS = 120;
  const live = [entry("u1", "user_message", "Go.", { username: "Tester" })];
  for (let i = 0; i < STEPS; i++)
    live.push(shellCall(`c${i}`, `echo STEP-${i}`), done(`r${i}`, `c${i}`));
  const { view, rerender } = mount({}, { agent: busy, logs: live });
  const chat = view.container;
  expect(runLines(chat).length).toBe(1);
  expect(runLines(chat)[0].textContent).toContain(String(STEPS));
  expect(chat.textContent).not.toContain("STEP-");
  expect(drawn(chat, live)).toEqual(["u1", "c0"]);
  // The activity line says the agent works, not that it runs a tool.
  expect(chat.textContent).toContain(en["logView.state.working"]);
  expect(chat.textContent).not.toContain(en["logView.state.toolExecuting"]);

  fireEvent.click(runLines(chat)[0]);
  expect(chat.textContent).toContain(`STEP-${STEPS - 1}`);
  act(() => {
    rerender({
      agent: busy,
      logs: [...live, shellCall("c-new", "echo STEP-NEW")],
    });
  });
  // Still open, and the new step joined it rather than a new line.
  expect(chat.textContent).toContain("STEP-0");
  expect(chat.textContent).toContain("STEP-NEW");
  view.unmount();
});
