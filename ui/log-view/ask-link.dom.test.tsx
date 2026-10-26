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
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { ASK_FILED_TEXT } = await import("../../shared/types.ts");
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
    // The ask filed as a task, bare and with the member's note.
    {
      id: "filed",
      agentId: "a1",
      timestamp: 6,
      kind: "user_message",
      content: ASK_FILED_TEXT,
      metadata: {
        username: "Tester",
        ask: { id: "abcd1234", prompt: "Go?", taskId: "feed0001" },
      },
    },
    {
      id: "filed-note",
      agentId: "a1",
      timestamp: 7,
      kind: "user_message",
      content: "after the launch",
      metadata: {
        username: "Tester",
        ask: { id: "abcd1234", prompt: "Go?", taskId: "feed0001" },
      },
    },
  ];
}

// The viewer reads Catalan; the agent reads the stored English.
const ca = translatorFor("ca");
const en = translatorFor("en");
const DISMISSED = ca.t("asks.dismissed");
const WITH_REASON = ca.t("asks.dismissedReason", { reason: "wrong room" });

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
  expect(DISMISSED).not.toBe("Dismissed");
  expect(dismiss.textContent).toContain(DISMISSED);
  expect(dismiss.textContent).not.toContain("Dismissed");
  // A reply keeps the member's own words.
  expect(
    view.container.querySelector('[data-log-entry-id="reply"]')!.textContent,
  ).toContain("yes");
  // A typed reason shows under the translated dismiss.
  const reason = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="dismiss-reason"]',
  )!.textContent;
  expect(reason).toContain(WITH_REASON);
  view.unmount();
});

it("shows an ask filed as a task in the viewer's language, naming the task", () => {
  const view = render(onLanguage("ca", <Transcript entries={logs(true)} />));
  const text = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-log-entry-id="${id}"]`)!
      .textContent ?? "";
  const bare = ca.t("asks.filedAsTask", { task: "feed0001" });
  const noted = ca.t("asks.filedAsTaskNote", {
    task: "feed0001",
    note: "after the launch",
  });
  expect(bare).not.toBe(en.t("asks.filedAsTask", { task: "feed0001" }));
  expect(text("filed")).toContain(bare);
  expect(text("filed")).not.toContain(ASK_FILED_TEXT);
  expect(text("filed-note")).toContain(noted);
  // Neither reads as a dismiss.
  expect(text("filed")).not.toContain(DISMISSED);
  expect(text("filed-note")).not.toContain(DISMISSED);
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
    expect(text).toContain(WITH_REASON);
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

// An answered ask can be read in full: the one-line link expands to the whole
// prompt and its options, and folds again.
const { askRefOf } = await import("./ask-link.tsx");
const { act } = await import("@testing-library/react");

function answerTo(id: string, ask: Record<string, unknown>): LogEntry {
  return {
    id,
    agentId: "a1",
    timestamp: 10,
    kind: "user_message",
    content: "yes",
    metadata: { username: "Tester", ask },
  };
}

// happy-dom has no layout: the one-line prompt is cut when its text is
// wider than the line.
function withWidths<T>(run: () => T, lineWidth: () => number = () => 300): T {
  const proto = HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get() {
      return (this.textContent?.length ?? 0) * 7;
    },
  });
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get: lineWidth,
  });
  try {
    return run();
  } finally {
    if (scroll) Object.defineProperty(proto, "scrollWidth", scroll);
    else Reflect.deleteProperty(proto, "scrollWidth");
    if (client) Object.defineProperty(proto, "clientWidth", client);
    else Reflect.deleteProperty(proto, "clientWidth");
  }
}

const SECOND_LINE = "The tag is cut; the notes are not.";

it("expands an answered ask to its whole prompt and options, and a second click folds it", () => {
  const scrolled: string[] = [];
  const proto = HTMLElement.prototype as unknown as {
    scrollIntoView: (this: HTMLElement) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function () {
    scrolled.push(this.dataset.logEntryId ?? "");
  };
  try {
    const entries = [
      ...logs(true),
      answerTo("long", {
        id: "abcd1234",
        prompt: `Ship the **release** tonight?\n${SECOND_LINE}`,
        options: ["Tonight", "Tomorrow", "Hold"],
        recommended: "Tomorrow",
      }),
    ];
    const view = render(onLanguage("en", <Transcript entries={entries} />));
    const line = view.container.querySelector<HTMLElement>(
      '[data-log-entry-id="long"] [data-ask-link="abcd1234"]',
    )!;
    const toggle = () =>
      line.querySelector<HTMLElement>("[data-ask-link-toggle]")!;
    const full = () => line.querySelector<HTMLElement>("[data-ask-link-full]");
    const options = () => [
      ...line.querySelectorAll<HTMLElement>("[data-ask-link-option]"),
    ];
    // Collapsed: the toggle is named by the one-line prompt.
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe(null);
    expect(toggle().textContent).toContain(SECOND_LINE);
    expect(full()).toBe(null);
    expect(options()).toEqual([]);

    // The jump keeps its own click and does not expand.
    const jump = [...line.querySelectorAll("button")].find(
      (b) => !b.hasAttribute("data-ask-link-toggle"),
    )!;
    fireEvent.click(jump);
    expect(scrolled).toEqual(["call"]);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(full()).toBe(null);

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const shown = full()!;
    // The whole prompt as the open card draws it: markdown, line breaks kept,
    // outside the toggle, and the line shows it once.
    expect(shown.textContent).toContain(`tonight?\n${SECOND_LINE}`);
    expect(shown.querySelector("strong")?.textContent).toBe("release");
    expect(toggle().contains(shown)).toBe(false);
    expect(line.textContent.split(SECOND_LINE).length - 1).toBe(1);
    expect(toggle().getAttribute("aria-label")).toBeTruthy();
    // The options in order, the recommended one marked; none is a control.
    const recommended = en.t("asks.recommended");
    expect(options().map((o) => o.textContent?.split(" ")[0])).toEqual([
      "Tonight",
      "Tomorrow",
      "Hold",
    ]);
    const marked = [
      ...line.querySelectorAll<HTMLElement>(
        "[data-ask-link-option-recommended]",
      ),
    ];
    expect(marked.map((o) => o.textContent?.split(" ")[0])).toEqual([
      "Tomorrow",
    ]);
    expect(options().map((o) => o.textContent?.includes(recommended))).toEqual([
      false,
      true,
      false,
    ]);
    expect(line.querySelectorAll("button").length).toBe(2);

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(full()).toBe(null);
    expect(options()).toEqual([]);
    expect(toggle().textContent).toContain(SECOND_LINE);
    view.unmount();
  } finally {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete (proto as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it("expands a one-line prompt only when the line cuts it", () => {
  withWidths(() => {
    const cut =
      "Move the nightly backup to the second disk and drop the copies older than a month?";
    const entries = [
      answerTo("short", { id: "abcd1234", prompt: "Go?" }),
      answerTo("cut", { id: "abcd1235", prompt: cut }),
    ];
    const view = render(onLanguage("en", <Transcript entries={entries} />));
    const line = (id: string) =>
      view.container.querySelector<HTMLElement>(
        `[data-log-entry-id="${id}"] [data-ask-link]`,
      )!;
    // Fits on the line: plain text, nothing to expand.
    expect(line("short").textContent).toContain("Go?");
    expect(line("short").querySelector("[data-ask-link-toggle]")).toBe(null);
    expect(line("short").querySelector("button")).toBe(null);

    const toggle = line("cut").querySelector<HTMLElement>(
      "[data-ask-link-toggle]",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(
      line("cut").querySelector("[data-ask-link-full]")?.textContent,
    ).toContain(cut);
    expect(line("cut").querySelector("[data-ask-link-option]")).toBe(null);
    view.unmount();
  });
});

it("reads an answer's options from its metadata, and drops malformed ones but keeps the ask", () => {
  const ref = (ask: Record<string, unknown>) =>
    askRefOf(answerTo("x", { id: "abcd1234", prompt: "Go?", ...ask }));
  const good = ref({ options: ["Yes", "No"], recommended: "No" });
  expect([good?.options, good?.recommended]).toEqual([["Yes", "No"], "No"]);
  for (const options of ["Yes", [], ["Yes", 2], null, { 0: "Yes" }]) {
    const r = ref({ options });
    expect(`${JSON.stringify(options)} ${r?.id} ${r?.prompt}`).toBe(
      `${JSON.stringify(options)} abcd1234 Go?`,
    );
    expect(r?.options).toBe(undefined);
  }
  const badMark = ref({ options: ["Yes", "No"], recommended: 1 });
  expect([badMark?.options, badMark?.recommended]).toEqual([
    ["Yes", "No"],
    undefined,
  ]);
  // An answer from before options were stored has neither.
  const old = ref({});
  expect([old?.options, old?.recommended]).toEqual([undefined, undefined]);
});

it("measures the line again when its width changes", () => {
  // Only an element still in the document gets resize events, as in a browser.
  const OriginalObserver = globalThis.ResizeObserver;
  const observed = new Map<Element, () => void>();
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(element: Element) {
      observed.set(element, this.callback);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      for (const [element, callback] of observed)
        if (callback === this.callback) observed.delete(element);
    }
  } as unknown as typeof ResizeObserver;
  let width = 1000;
  const resize = (to: number) => {
    width = to;
    act(() => {
      for (const [element, callback] of observed)
        if (element.isConnected) callback();
    });
  };
  try {
    withWidths(
      () => {
        const prompt =
          "Move the nightly backup to the second disk and drop the copies older than a month?";
        const view = render(
          onLanguage(
            "en",
            <Transcript
              entries={[answerTo("resized", { id: "abcd1234", prompt })]}
            />,
          ),
        );
        const toggle = () =>
          view.container.querySelector<HTMLElement>("[data-ask-link-toggle]");
        // Wide enough at first: plain text.
        expect(toggle()).toBe(null);
        // A narrower chat (a side panel opens, a phone turns) cuts it.
        resize(300);
        expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
        // Open and fold, then widen: the folded line is measured again.
        fireEvent.click(toggle()!);
        expect(
          view.container.querySelector("[data-ask-link-full]")?.textContent,
        ).toContain(prompt);
        fireEvent.click(toggle()!);
        expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
        resize(1000);
        expect(toggle()).toBe(null);
        expect(
          view.container.querySelector("[data-ask-link]")?.textContent,
        ).toContain(prompt);
        view.unmount();
      },
      () => width,
    );
  } finally {
    globalThis.ResizeObserver = OriginalObserver;
  }
});

// Nil's sign-off notes on the ask screenshots: the collapsed line drew the raw
// ** markers, and inline code drew its backticks; the open prompt keeps code
// rendered and its links live.
const MARKDOWN_PROMPT =
  "Ship the **release** tonight, then run `bun test`. See [route](https://example.com).";

function markdownEntry(
  id: string,
  extra: Record<string, unknown> = {},
): LogEntry {
  return answerTo(id, {
    id: "abcd1234",
    prompt: MARKDOWN_PROMPT,
    options: ["Tonight", "Tomorrow"],
    ...extra,
  });
}

it("formats the collapsed line and keeps no anchor inside the toggle", () => {
  const view = render(
    onLanguage("en", <Transcript entries={[markdownEntry("formatted")]} />),
  );
  const line = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="formatted"] [data-ask-link="abcd1234"]',
  )!;
  const toggle = line.querySelector<HTMLElement>("[data-ask-link-toggle]")!;
  expect(toggle.querySelector("a")).toBe(null);
  expect(toggle.querySelector("strong")?.textContent).toBe("release");
  const code = toggle.querySelector("code");
  expect(code).not.toBe(null);
  expect(code!.textContent).toBe("bun test");
  const text = toggle.textContent ?? "";
  expect(text).not.toContain("**");
  expect(text).not.toContain("`");
  expect(text).not.toContain("[route]");
  expect(text).toContain("route");
  // The cut measure needs one line: the inline span cannot wrap.
  expect(code!.parentElement!.style.whiteSpace).toBe("nowrap");
  view.unmount();
});

it("renders the expanded prompt as code and keeps its links live", () => {
  const view = render(
    onLanguage("en", <Transcript entries={[markdownEntry("expanded")]} />),
  );
  const line = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="expanded"] [data-ask-link="abcd1234"]',
  )!;
  fireEvent.click(line.querySelector("[data-ask-link-toggle]")!);
  const full = line.querySelector<HTMLElement>("[data-ask-link-full]")!;
  expect(full.querySelector("code")?.textContent).toBe("bun test");
  expect(full.querySelector("strong")?.textContent).toBe("release");
  expect(full.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com",
  );
  view.unmount();
});
