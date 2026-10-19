// An answer to an ask in the agent's chat: a one-line link above the
// member's message that jumps to the agent's "Create ask" card, and a
// dismiss shown in the viewer's language, also while the answer waits in the
// queue. Also the count dot on the desk.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { ChatTranscript, useChatTranscript } =
  await import("./ChatTranscript.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { DeskUnit } = await import("../office/DeskUnit.tsx");
const { LogView } = await import("./LogView.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;

const CREATE =
  "curl -s -X POST \"localhost:4000/api/agents/a1/asks\" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nGo?\nEOF";

function logs(withCard: boolean): LogEntry[] {
  const card: LogEntry[] = [
    {
      id: "call",
      agentId: "a1",
      timestamp: 1,
      kind: "tool_call",
      content: "Bash",
      metadata: { toolId: "t1", input: { command: CREATE } },
    },
    {
      id: "result",
      agentId: "a1",
      timestamp: 2,
      kind: "tool_result",
      content: '{"id":"abcd1234","agentId":"a1"}',
      metadata: { toolUseId: "t1" },
    },
  ];
  return [
    ...(withCard ? card : []),
    {
      id: "reply",
      agentId: "a1",
      timestamp: 3,
      kind: "user_message",
      content: "yes",
      metadata: {
        username: "Tester",
        ask: { id: "abcd1234", prompt: "Go?" },
      },
    },
    {
      id: "dismiss",
      agentId: "a1",
      timestamp: 4,
      kind: "user_message",
      content: "Dismissed",
      metadata: {
        username: "Tester",
        ask: { id: "abcd1234", prompt: "Go?", dismissed: true },
      },
    },
    // A dismiss with the reason the member typed.
    {
      id: "dismiss-reason",
      agentId: "a1",
      timestamp: 5,
      kind: "user_message",
      content: "wrong room",
      metadata: {
        username: "Tester",
        ask: { id: "abcd1234", prompt: "Go?", dismissed: true },
      },
    },
  ];
}

function Transcript({ entries }: { entries: LogEntry[] }) {
  const view = useChatTranscript(entries, false);
  return <ChatTranscript logs={entries} view={view} isMobile={false} />;
}

it("links an answer to the card that created its ask, and the click scrolls there", () => {
  const scrolled: string[] = [];
  const proto = HTMLElement.prototype as unknown as {
    scrollIntoView: (this: HTMLElement) => void;
  };
  // Restore the exact prototype state: an own property left behind on
  // HTMLElement.prototype would shadow other files' stubs on Element.prototype
  // when the DOM suites share one process.
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function () {
    scrolled.push(this.dataset.logEntryId ?? "");
  };
  try {
    const view = render(onLanguage("en", <Transcript entries={logs(true)} />));
    const link = view.container.querySelector<HTMLElement>(
      '[data-log-entry-id="reply"] [data-ask-link="abcd1234"]',
    )!;
    expect(link.textContent).toContain("Go?");
    fireEvent.click(link.querySelector("button")!);
    expect(scrolled).toEqual(["call"]);
    view.unmount();
  } finally {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it("shows the link as text when the create card is not in the chat", () => {
  const view = render(onLanguage("en", <Transcript entries={logs(false)} />));
  const link = view.container.querySelector(
    '[data-log-entry-id="reply"] [data-ask-link="abcd1234"]',
  )!;
  expect(link).not.toBe(null);
  expect(link.querySelector("button")).toBe(null);
  view.unmount();
});

it("shows a dismiss in the viewer's language, not the English word the agent reads", () => {
  const view = render(onLanguage("ca", <Transcript entries={logs(true)} />));
  const dismiss = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="dismiss"]',
  )!;
  expect(dismiss.textContent).toContain("Descartada");
  expect(dismiss.textContent).not.toContain("Dismissed");
  // A reply keeps the member's own words.
  expect(
    view.container.querySelector('[data-log-entry-id="reply"]')!.textContent,
  ).toContain("yes");
  // A typed reason shows under the translated dismiss.
  const reason = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="dismiss-reason"]',
  )!.textContent;
  expect(reason).toContain("Descartada");
  expect(reason).toContain("wrong room");
  view.unmount();
});

it("shows a queued answer as an answer to its ask, as the sent message will be", () => {
  setApiShim(async () => undefined);
  const queued = {
    ...agent,
    state: "thinking",
    queue: [
      {
        id: "q1",
        sender: { kind: "user", username: "Tester", device: "Windows" },
        text: "Approve copy, hold the push",
        ask: { id: "abcd1234", prompt: "Go?" },
        queuedAt: 1,
      },
      {
        id: "q2",
        sender: { kind: "user", username: "Tester" },
        text: "wrong room",
        ask: { id: "abcd1234", prompt: "Go?", dismissed: true },
        queuedAt: 2,
      },
    ],
  } as unknown as AgentInfo;
  try {
    const view = render(
      onLanguage(
        "ca",
        createElement(LogView, {
          agent: queued,
          logs: [],
          onBack: () => {},
          onEditAgent: () => {},
        }),
        {
          agents: [queued],
          hasReceivedInitialState: true,
          connected: true,
        },
      ),
    );
    // No transcript entries: every ask line is a queue chip's.
    const lines = [
      ...view.container.querySelectorAll<HTMLElement>(
        '[data-ask-link="abcd1234"]',
      ),
    ];
    expect(lines.map((l) => l.textContent?.includes("Go?"))).toEqual([
      true,
      true,
    ]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Approve copy, hold the push");
    // Only the dismiss with a reason can say dismissed here.
    expect(text).toContain("Descartada");
    expect(text).toContain("wrong room");
    view.unmount();
  } finally {
    setApiShim(null);
  }
});

const agent = {
  id: "a1",
  name: "Asker",
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
} as unknown as AgentInfo;

it("puts the count of open asks on the desk's nameplate, and nothing at zero", () => {
  const desk = (count: number) =>
    render(
      onLanguage(
        "en",
        <DeskUnit
          agent={agent}
          onClick={() => {}}
          onContextMenu={() => {}}
          askCount={count}
        />,
      ),
    );
  const two = desk(2);
  const dot = two.container.querySelector("[data-ask-dot]")!;
  expect(dot.textContent).toBe("2");
  expect(dot.getAttribute("aria-label")).toContain("2");
  two.unmount();
  const none = desk(0);
  expect(none.container.querySelector("[data-ask-dot]")).toBe(null);
  none.unmount();
});
