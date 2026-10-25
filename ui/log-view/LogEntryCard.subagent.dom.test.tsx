// A step of a subagent that lands after a later member message: its pill
// names the job, says it runs in the background, and jumps to the card that
// started it, so it does not read as a reply to that message.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { ChatTranscript, useChatTranscript } =
  await import("./ChatTranscript.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type LogEntry = import("../../shared/types.ts").LogEntry;

const JOB = "Submit the listing";

function start(id: string, background: boolean): LogEntry {
  return {
    id,
    agentId: "a1",
    timestamp: 1,
    kind: "tool_call",
    content: "Agent",
    metadata: {
      toolId: `${id}-tool`,
      input: {
        description: JOB,
        prompt: "do it",
        run_in_background: background,
      },
    },
  };
}

function member(id: string): LogEntry {
  return {
    id,
    agentId: "a1",
    timestamp: 1,
    kind: "user_message",
    content: "go on",
    metadata: { username: "Tester" },
  };
}

const subagent = (parent: string) => ({
  parentToolUseId: `${parent}-tool`,
  type: "general-purpose",
  description: JOB,
});

function call(id: string, parent: string): LogEntry {
  return {
    id,
    agentId: "a1",
    timestamp: 1,
    kind: "tool_call",
    content: "Bash",
    metadata: {
      toolId: `${id}-tool`,
      input: { command: `echo ${id}` },
      subagent: subagent(parent),
    },
  };
}

// A result; with `parent` it is a step of that job.
function result(
  id: string,
  callId: string,
  parent?: string,
  isError = false,
): LogEntry {
  return {
    id,
    agentId: "a1",
    timestamp: 1,
    kind: "tool_result",
    content: `${callId}-out`,
    metadata: {
      toolUseId: `${callId}-tool`,
      isError,
      ...(parent && { subagent: subagent(parent) }),
    },
  };
}

function Transcript({ entries }: { entries: LogEntry[] }) {
  const view = useChatTranscript(entries, false);
  return <ChatTranscript logs={entries} view={view} isMobile={false} />;
}

// Records which rendered entries were scrolled to; restores the prototype.
function withScrollSpy(body: (scrolled: string[]) => void) {
  const scrolled: string[] = [];
  const proto = HTMLElement.prototype as unknown as {
    scrollIntoView: (this: HTMLElement) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function () {
    scrolled.push(this.dataset.logEntryId ?? "");
  };
  try {
    body(scrolled);
  } finally {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
  }
}

it("marks background steps after a member message and jumps to the card that started them", () => {
  const entries: LogEntry[] = [
    member("u0"),
    start("agent", true),
    result("agent-r", "agent"),
    call("s0", "agent"),
    result("s0-r", "s0", "agent"),
    call("s1", "agent"),
    member("u1"),
    // The incident: the result of a call made before u1 lands after it.
    result("s1-r", "s1", "agent", true),
    // Two steps that collapse into one group card.
    call("s2", "agent"),
    result("s2-r", "s2", "agent"),
    call("s3", "agent"),
    result("s3-r", "s3", "agent"),
    {
      id: "say",
      agentId: "a1",
      timestamp: 1,
      kind: "text",
      content: "Working on it.",
    },
    // A lone step: an ordinary tool card.
    call("s4", "agent"),
    result("s4-r", "s4", "agent"),
  ];
  withScrollSpy((scrolled) => {
    const view = render(onLanguage("en", <Transcript entries={entries} />));
    const card = (id: string) =>
      view.container.querySelector<HTMLElement>(`[data-log-entry-id="${id}"]`)!;
    const pills = (id: string) => [
      ...card(id).querySelectorAll<HTMLElement>("[data-subagent-pill]"),
    ];

    // Steps in the turn that started the job keep the plain pill.
    for (const id of ["s0", "s1"]) {
      expect(pills(id).map((p) => p.dataset.subagentPill)).toEqual(["plain"]);
      expect(card(id).querySelector("[data-jump-target]")).toBe(null);
    }

    // s2 is a collapsed group of s2 and s3.
    expect(view.container.querySelector('[data-log-entry-id="s3"]')).toBe(null);
    for (const id of ["s1-r", "s2", "s4"]) {
      const [pill] = pills(id);
      expect(pills(id).length).toBe(1);
      expect(pill.dataset.subagentPill).toBe("background");
      expect(pill.dataset.jumpTarget).toBe("agent");
      expect(pill.tagName).toBe("BUTTON");
      // Not nested in the card's own toggle button.
      expect(pill.parentElement!.closest("button")).toBe(null);
      expect(`${pill.textContent} ${pill.title}`).toContain(JOB);
    }

    // A click on the pill goes to the starting card and leaves the step's
    // own card closed.
    const s4Pill = pills("s4")[0];
    expect(card("s4").textContent).not.toContain("s4-out");
    fireEvent.click(s4Pill);
    expect(scrolled).toEqual(["agent"]);
    expect(card("s4").textContent).not.toContain("s4-out");
    // The toggle itself still opens it.
    const s4Toggle = [...card("s4").querySelectorAll("button")].find(
      (b) => b !== s4Pill && b.textContent.includes("Bash"),
    )!;
    fireEvent.click(s4Toggle);
    expect(card("s4").textContent).toContain("s4-out");

    // Same for the group card: the pill jumps, the group stays collapsed, and
    // once expanded each child carries the background pill.
    fireEvent.click(pills("s2")[0]);
    expect(scrolled).toEqual(["agent", "agent"]);
    expect(pills("s2").length).toBe(1);
    const groupToggle = [...card("s2").querySelectorAll("button")].find(
      (b) => b !== pills("s2")[0],
    )!;
    fireEvent.click(groupToggle);
    expect(pills("s2").map((p) => p.dataset.subagentPill)).toEqual([
      "background",
      "background",
    ]);
    view.unmount();
  });
});

it("marks a foreground job's step after a steer as detached, not background", () => {
  const entries = [start("agent", false), member("steer"), call("s1", "agent")];
  withScrollSpy((scrolled) => {
    const view = render(onLanguage("en", <Transcript entries={entries} />));
    const pill = view.container.querySelector<HTMLElement>(
      '[data-log-entry-id="s1"] [data-subagent-pill]',
    )!;
    expect(pill.dataset.subagentPill).toBe("detached");
    expect(pill.dataset.jumpTarget).toBe("agent");
    expect(`${pill.textContent} ${pill.title}`).toContain(JOB);
    fireEvent.click(pill);
    expect(scrolled).toEqual(["agent"]);
    view.unmount();
  });
});
