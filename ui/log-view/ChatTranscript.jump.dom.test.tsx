// A jump from a link in a chat (task 9ebe887d slice 3): ChatTranscript serves
// it from its own surface. A loaded target scrolls at once, in that surface
// only, even when another surface shows the same chat. In a recent chat a
// target that is not loaded loads the rest (the surface's ChatRest), and the
// surface scrolls to it once a whole load has brought it; a whole load
// without it drops the jump. Through the real App: App.chat-recent.dom.test.tsx.
// A card folded into a closed "N steps" line (task 17fb1a29): the jump opens
// that line and scrolls to the card.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act } = await import("@testing-library/react");
const { ChatTranscript, useChatTranscript } =
  await import("./ChatTranscript.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
type LogEntry = import("../../shared/types.ts").LogEntry;
type ChatRest = import("./load-rest.ts").ChatRest;
type ChatLevel = import("./load-rest.ts").ChatLevel;

const CREATE =
  "curl -s -X POST \"localhost:4000/api/agents/a1/asks\" -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nGo?\nEOF";
const call: LogEntry = {
  id: "call",
  agentId: "a1",
  timestamp: 1,
  kind: "tool_call",
  content: "Bash",
  metadata: { toolId: "t1", input: { command: CREATE } },
} as LogEntry;
const result: LogEntry = {
  id: "result",
  agentId: "a1",
  timestamp: 2,
  kind: "tool_result",
  content: '{"id":"abcd1234","agentId":"a1"}',
  metadata: { toolUseId: "t1" },
} as LogEntry;
const reply: LogEntry = {
  id: "reply",
  agentId: "a1",
  timestamp: 3,
  kind: "user_message",
  content: "yes",
  metadata: { username: "Tester", ask: { id: "abcd1234", prompt: "Go?" } },
} as LogEntry;
const later: LogEntry = {
  id: "later",
  agentId: "a1",
  timestamp: 4,
  kind: "text",
  content: "more",
} as LogEntry;

function Surface({
  entries,
  rest,
  fold = false,
}: {
  entries: LogEntry[];
  rest: ChatRest;
  fold?: boolean;
}) {
  const view = useChatTranscript(entries, false, fold, fold);
  return (
    <ChatTranscript logs={entries} view={view} isMobile={false} rest={rest} />
  );
}

// Two surfaces that show the same chat, each with its own loadRest. `fold`
// folds tool calls and agent messages, as a member's default does.
function rig(fold = false) {
  const loads = { one: 0, two: 0 };
  const rest = (name: "one" | "two", level: ChatLevel | null): ChatRest => ({
    level,
    loadRest: () => {
      loads[name] += 1;
    },
  });
  const tree = (entries: LogEntry[], level: ChatLevel | null) =>
    onLanguage(
      "en",
      <>
        <div data-surface="one">
          <Surface entries={entries} rest={rest("one", level)} fold={fold} />
        </div>
        <div data-surface="two">
          <Surface entries={entries} rest={rest("two", level)} fold={fold} />
        </div>
      </>,
    );
  return { loads, tree };
}

async function withScrolls(run: (scrolled: string[]) => Promise<void>) {
  const scrolled: string[] = [];
  const proto = HTMLElement.prototype as unknown as {
    scrollIntoView: (this: HTMLElement) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function () {
    const surface = this.closest<HTMLElement>("[data-surface]");
    scrolled.push(`${surface?.dataset.surface}:${this.dataset.logEntryId}`);
  };
  try {
    await run(scrolled);
  } finally {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
  }
}

const linkIn = (surface: string) =>
  document.querySelector<HTMLElement>(
    `[data-surface="${surface}"] [data-ask-link="abcd1234"] button`,
  );

it("a loaded card scrolls at once in the surface that asked, and loads nothing", async () => {
  await withScrolls(async (scrolled) => {
    const { loads, tree } = rig();
    const view = render(tree([call, result, reply], "recent"));
    await act(async () => fireEvent.click(linkIn("two")!));
    expect(scrolled).toEqual(["two:call"]);
    expect(loads).toEqual({ one: 0, two: 0 });
    view.unmount();
  });
});

it("a card older than the window loads the rest from the surface that asked, and that surface alone scrolls to it, once", async () => {
  await withScrolls(async (scrolled) => {
    const { loads, tree } = rig();
    const view = render(tree([reply], "recent"));
    // The card is not loaded, and the link still shows.
    expect(linkIn("two")).not.toBeNull();
    await act(async () => fireEvent.click(linkIn("two")!));
    expect(loads).toEqual({ one: 0, two: 1 });
    view.rerender(tree([reply], "loadingRest"));
    expect(scrolled).toEqual([]);
    await act(async () => {
      view.rerender(tree([call, result, reply], "complete"));
    });
    expect(scrolled).toEqual(["two:call"]);
    // A later entry does not scroll again.
    await act(async () => {
      view.rerender(tree([call, result, reply, later], "complete"));
    });
    expect(scrolled).toEqual(["two:call"]);
    view.unmount();
  });
});

it("a whole load without the card drops the jump", async () => {
  await withScrolls(async (scrolled) => {
    const { tree } = rig();
    const view = render(tree([reply], "recent"));
    expect(linkIn("one")).not.toBeNull();
    await act(async () => fireEvent.click(linkIn("one")!));
    view.rerender(tree([reply], "loadingRest"));
    await act(async () => {
      view.rerender(tree([reply], "complete"));
    });
    // The card comes later (a live entry): no scroll.
    await act(async () => {
      view.rerender(tree([reply, call, result], "complete"));
    });
    expect(
      document.querySelector('[data-surface="one"] [data-log-entry-id="call"]'),
    ).not.toBeNull();
    expect(scrolled).toEqual([]);
    view.unmount();
  });
});

it("a complete chat with no card shows the link as text, as before", () => {
  const { tree } = rig();
  const view = render(tree([reply], "complete"));
  expect(
    document.querySelector('[data-surface="one"] [data-ask-link="abcd1234"]'),
  ).not.toBeNull();
  expect(linkIn("one")).toBeNull();
  view.unmount();
});

// The ask's card is the second step of a run: closed, the run draws only its
// line, which carries the first step's id.
const step: LogEntry = {
  id: "step",
  agentId: "a1",
  timestamp: 0,
  kind: "tool_call",
  content: "Bash",
  metadata: { toolId: "t0", input: { command: "ls" } },
} as LogEntry;
const stepDone: LogEntry = {
  id: "step-done",
  agentId: "a1",
  timestamp: 0,
  kind: "tool_result",
  content: "ok",
  metadata: { toolUseId: "t0" },
} as LogEntry;
const openLines = (surface: string) =>
  document.querySelectorAll(
    `[data-surface="${surface}"] button[data-hidden-steps-open]`,
  ).length;

it("a card folded into a closed steps line: the jump opens the line, in that surface only, and scrolls to the card", async () => {
  await withScrolls(async (scrolled) => {
    const { loads, tree } = rig(true);
    const view = render(
      tree([step, stepDone, call, result, reply], "complete"),
    );
    // The condition: the card is folded, and the line is closed.
    expect(
      document.querySelector('[data-surface="two"] [data-log-entry-id="call"]'),
    ).toBeNull();
    expect(openLines("two")).toBe(0);
    await act(async () => fireEvent.click(linkIn("two")!));
    expect(openLines("two")).toBe(1);
    expect(openLines("one")).toBe(0);
    expect(scrolled).toEqual(["two:call"]);
    expect(loads).toEqual({ one: 0, two: 0 });
    view.unmount();
  });
});

it("a folded card older than the window: after the load, the jump opens its line and scrolls to it", async () => {
  await withScrolls(async (scrolled) => {
    const { loads, tree } = rig(true);
    const view = render(tree([reply], "recent"));
    await act(async () => fireEvent.click(linkIn("two")!));
    expect(loads).toEqual({ one: 0, two: 1 });
    view.rerender(tree([reply], "loadingRest"));
    await act(async () => {
      view.rerender(tree([step, stepDone, call, result, reply], "complete"));
    });
    expect(openLines("two")).toBe(1);
    expect(openLines("one")).toBe(0);
    expect(scrolled).toEqual(["two:call"]);
    view.unmount();
  });
});

it("a card that is the first step of a closed line: the jump opens the line too", async () => {
  await withScrolls(async (scrolled) => {
    const { tree } = rig(true);
    const view = render(tree([call, result, reply], "complete"));
    expect(openLines("two")).toBe(0);
    expect(
      document.querySelectorAll(
        '[data-surface="two"] button[data-hidden-steps]',
      ).length,
    ).toBe(1);
    await act(async () => fireEvent.click(linkIn("two")!));
    expect(openLines("two")).toBe(1);
    expect(openLines("one")).toBe(0);
    expect(scrolled).toEqual(["two:call"]);
    view.unmount();
  });
});
