// Messages between agents in the chat (task d5c0f33d, Nil 2026-11-15: "just
// like we minimized function calls, we should also have a setting for
// minimizing agent messages"). A message from another agent and a card that
// sends one fold by default, into the same line as the steps around them;
// the line shows the avatars of the agents the run talked with.
// showAgentMessages on the member's record shows them. Which entries a run
// holds: tool-call-groups.test.ts. The tool fold alone:
// LogView.hide-tool-calls.dom.test.tsx. The export shows everything:
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
const shellCall = (id: string, command: string) =>
  entry(id, "tool_call", "Bash", { toolId: `${id}-t`, input: { command } });
const done = (id: string, callId: string, content = "ok") =>
  entry(id, "tool_result", content, { toolUseId: `${callId}-t` });

const self = selfUserRecord(null);
const showing = { ...self, showToolCalls: true as const };
const usersWith = (record: typeof self) =>
  new Map([[record.name.toLowerCase(), record]]);

function mount(
  over: Partial<AppState>,
  props: { agent: AgentInfo; logs: LogEntry[] },
) {
  return {
    view: render(
      onLanguage(
        null,
        createElement(LogView, { ...props, onBack() {}, onEditAgent() {} }),
        {
          agents: [props.agent],
          rooms: [
            { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
          ],
          hasReceivedInitialState: true,
          connected: true,
          isMobile: false,
          ...over,
        },
      ),
    ),
  };
}

const runLines = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>("button[data-hidden-steps]"));
// The chat entries drawn at the top level, in order, without the results
// that fold into their call's card (they draw nothing).
const drawn = (root: ParentNode, entries: LogEntry[]) => {
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

const peerAgent = (id: string, name: string) =>
  ({ ...agent, id, name }) as AgentInfo;
const PEERS = [peerAgent("a2", "Helper"), peerAgent("a3", "Scout")];
const withPeers = { agents: [agent, ...PEERS] } as Partial<AppState>;
const AUTH = `-H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`;
const send = (id: string, to: string, query = "") =>
  shellCall(
    id,
    `curl -s -X POST "localhost:4000/api/agents/${to}/messages${query}" ${AUTH} -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nSEND-${id}\nEOF`,
  );
const peerMessage = (id: string, from: string) =>
  entry(id, "user_message", `PEER-${id}\nits second line`, {
    sender_agent_id: from,
    sender_agent_name: from === "a2" ? "Helper" : "Scout",
    sender_agent_room: "Room",
  });
const showsMessages = { ...self, showAgentMessages: true as const };
const peerCards = (root: ParentNode) =>
  root.querySelectorAll("[data-peer-message]").length;
const lineAt = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(
    `[data-log-entry-id="${id}"] button[data-hidden-steps]`,
  );

// The agent asks Helper, Helper answers (a new turn), the agent works on
// it, tells Scout, and tries an agent the member's office does not hold.
const talk: LogEntry[] = [
  entry("u1", "user_message", "Ask around.", { username: "Tester" }),
  entry("x1", "text", "Asking Helper."),
  send("s1", "a2"),
  done("s1r", "s1", '{"messageId":"m1"}'),
  peerMessage("p1", "a2"),
  shellCall("c1", "echo HIDE-ONE"),
  done("r1", "c1"),
  send("s2", "a3", "?steer=1"),
  done("s2r", "s2", '{"messageId":"m2"}'),
  send("s3", "agent-gone"),
  done("s3r", "s3", '{"error":"not found"}'),
  entry("x2", "text", "All done."),
];

it("folds agent messages by default, with the steps around them, into one line with the peers' avatars", () => {
  const { view } = mount(withPeers, { agent, logs: talk });
  const chat = view.container;
  expect(drawn(chat, talk)).toEqual(["u1", "x1", "s1", "x2"]);
  expect(runLines(chat).length).toBe(1);
  const line = lineAt(chat, "s1");
  expect(line).not.toBeNull();
  expect(peerCards(chat)).toBe(0);
  for (const marker of ["PEER-p1", "SEND-s1", "SEND-s2", "HIDE-ONE"])
    expect({ marker, shown: chat.textContent!.includes(marker) }).toEqual({
      marker,
      shown: false,
    });
  // Helper's and Scout's avatars; the agent the office does not hold draws
  // nothing and is not named.
  const wrap = chat.querySelector('[data-log-entry-id="s1"]')!;
  expect(wrap.querySelectorAll("[data-chat-avatar]").length).toBe(2);
  expect(wrap.textContent).not.toContain("agent-gone");
  expect(chat.textContent).toContain("All done.");
  view.unmount();
});

// Inside the open line, a message from another agent is the compact card it
// is in the chat, and its toggle shows the whole text.
it("a tap on the line opens the messages and steps it holds, and a message in it opens in full", () => {
  const { view } = mount(withPeers, { agent, logs: talk });
  const chat = view.container;
  fireEvent.click(lineAt(chat, "s1")!);
  expect(peerCards(chat)).toBe(1);
  expect(chat.textContent).toContain("PEER-p1");
  expect(chat.textContent).toContain("HIDE-ONE");
  const card = chat.querySelector("[data-peer-message]")!;
  const toggle = card.querySelector<HTMLElement>("button[aria-expanded]");
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle!);
  expect(
    chat
      .querySelector("[data-peer-message] button[aria-expanded]")!
      .getAttribute("aria-expanded"),
  ).toBe("true");
  view.unmount();
});

it("shows every agent message to a member whose record says showAgentMessages; the steps still fold", () => {
  const { view } = mount(
    { ...withPeers, users: usersWith(showsMessages) },
    { agent, logs: talk },
  );
  const chat = view.container;
  expect(peerCards(chat)).toBe(1);
  expect(chat.textContent).toContain("PEER-p1");
  // The send cards are office cards again; the shell step is its own line.
  expect(drawn(chat, talk)).toEqual([
    "u1",
    "x1",
    "s1",
    "p1",
    "c1",
    "s2",
    "s3",
    "x2",
  ]);
  expect(runLines(chat).length).toBe(1);
  expect(lineAt(chat, "c1")).not.toBeNull();
  expect(chat.textContent).not.toContain("HIDE-ONE");
  view.unmount();
});

it("a record that shows both folds nothing", () => {
  const { view } = mount(
    {
      ...withPeers,
      users: usersWith({ ...showsMessages, showToolCalls: true }),
    },
    { agent, logs: talk },
  );
  const chat = view.container;
  expect(runLines(chat).length).toBe(0);
  expect(peerCards(chat)).toBe(1);
  expect(chat.textContent).toContain("HIDE-ONE");
  view.unmount();
});

// A member who shows tool calls keeps today's tool view: consecutive calls
// group as "N tool calls", and while the agent works its newest calls stay
// open as they arrive. Only the messages fold, on top of that.
it("with tool calls shown, the tool groups and the live calls stay as they were, and only the messages fold", () => {
  const showing2 = usersWith(showing);
  const mixed: LogEntry[] = [
    entry("u1", "user_message", "Go.", { username: "Tester" }),
    shellCall("c1", "echo HIDE-ONE"),
    done("r1", "c1"),
    shellCall("c2", "echo HIDE-TWO"),
    done("r2", "c2"),
    send("s1", "a2"),
    done("s1r", "s1"),
    peerMessage("p1", "a2"),
    shellCall("c3", "echo LIVE-THREE"),
    done("r3", "c3"),
    shellCall("c4", "echo LIVE-FOUR"),
  ];
  // Settled: c1-c2 one tool group, s1-p1 one message line, c3-c4 a group.
  const { view: settled } = mount(
    { ...withPeers, users: showing2 },
    {
      agent,
      logs: [...mixed, done("r4", "c4"), entry("x1", "text", "Done.")],
    },
  );
  let chat = settled.container;
  expect(drawn(chat, [...mixed, done("r4", "c4")])).toEqual([
    "u1",
    "c1",
    "s1",
    "c3",
    "x1",
  ]);
  expect(runLines(chat).length).toBe(1);
  expect(lineAt(chat, "s1")).not.toBeNull();
  expect(peerCards(chat)).toBe(0);
  // The tool groups are closed "N tool calls" rows, not steps lines.
  for (const marker of ["HIDE-ONE", "HIDE-TWO", "LIVE-THREE", "LIVE-FOUR"])
    expect({ marker, shown: chat.textContent!.includes(marker) }).toEqual({
      marker,
      shown: false,
    });
  settled.unmount();

  // Busy: the newest calls are the live tail and stay open cards.
  const busy = { ...agent, state: "tool_executing" } as AgentInfo;
  const { view: live } = mount(
    { ...withPeers, users: showing2 },
    { agent: busy, logs: mixed },
  );
  chat = live.container;
  expect(drawn(chat, mixed)).toEqual(["u1", "c1", "s1", "c3", "c4"]);
  expect(chat.textContent).toContain("LIVE-THREE");
  expect(chat.textContent).toContain("LIVE-FOUR");
  expect(chat.textContent).not.toContain("HIDE-ONE");
  expect(runLines(chat).length).toBe(1);
  live.unmount();
});

// A message from another agent starts a turn of its own, so a run that
// begins with the agent's send and goes on past the answer reaches two
// agent turns. The line carries the copy button of the last agent turn it
// ends (Nil at sign-off, task 59aca671), and it copies that turn.
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
const copyButtons = (root: ParentNode) =>
  root.querySelectorAll<HTMLElement>(`button[title="${en["common.copy"]}"]`);

it("a line that ends the chat after an agent's answer has the copy button, and it copies the agent's turn after the answer", async () => {
  await withClipboard(async (copied) => {
    const endsInRun = talk.slice(0, -1);
    const { view } = mount(withPeers, { agent, logs: endsInRun });
    const chat = view.container;
    const wrap = chat.querySelector('[data-log-entry-id="s1"]')!;
    expect(lineAt(chat, "s1")).not.toBeNull();
    expect(copyButtons(wrap).length).toBe(1);
    // The text before the run ends no turn.
    expect(
      copyButtons(chat.querySelector('[data-log-entry-id="x1"]')!).length,
    ).toBe(0);
    await act(async () => {
      fireEvent.click(copyButtons(wrap)[0]);
    });
    expect(copied.length).toBe(1);
    // The turn after Helper's answer, not the one before it.
    expect(copied[0]).toContain("HIDE-ONE");
    expect(copied[0]).not.toContain("Asking Helper.");
    view.unmount();
  });
});

it("a line that ends with an agent's answer carries the copy button of the turn the send ended", async () => {
  await withClipboard(async (copied) => {
    const logs = [...talk.slice(0, 5), entry("x2", "text", "Helper says yes.")];
    const { view } = mount(withPeers, { agent, logs });
    const chat = view.container;
    const wrap = chat.querySelector('[data-log-entry-id="s1"]')!;
    expect(drawn(chat, logs)).toEqual(["u1", "x1", "s1", "x2"]);
    expect(copyButtons(wrap).length).toBe(1);
    await act(async () => {
      fireEvent.click(copyButtons(wrap)[0]);
    });
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain("Asking Helper.");
    expect(copied[0]).not.toContain("Helper says yes.");
    view.unmount();
  });
});

it("a line in the middle of a turn has no copy button", () => {
  const { view } = mount(withPeers, { agent, logs: talk });
  const wrap = view.container.querySelector('[data-log-entry-id="s1"]')!;
  expect(lineAt(view.container, "s1")).not.toBeNull();
  expect(copyButtons(wrap).length).toBe(0);
  view.unmount();
});
