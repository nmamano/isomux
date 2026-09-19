// The chrome cases share one LogView tree and rerender it through each state,
// keeping the file below half of the DOM per-file budget under load. LogView's
// local state, refs, and effect history now survive between the former test
// boundaries. That is safe here because the language tour does not interact
// with or mutate those controls before the busy and command assertions.
// ActivityIndicator's Abort label is translated and selected on every render;
// its retained `now` value can drift only by the sub-second language tour,
// while stateChangedAt is fixed three minutes back across a two-minute gate.
// S5 of the office i18n loop (internal-docs/i18n-loop.md): the agent log view -
// its header and nav actions, the composer, the empty state, the cards, the
// API-call card's labels, the context battery and the subscription pill -
// renders in the language the signed-in user is on. The editor panel is
// mounted on its own below, through the same language context.
//
// LogView takes its agent and its log as props, so it mounts directly rather
// than through App. The TERMINAL panel is deliberately not mounted: it carries a
// real xterm, which ui/log-view/TerminalPanel.replay.dom.test.tsx exists to pay
// for, so the terminal's anchor here is the control that opens it.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFrom,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { LogView } = await import("./log-view/LogView.tsx");
const { LogEntryCard, RawToolCallGroupCard } =
  await import("./log-view/LogEntryCard.tsx");
const { EditorPanel } = await import("./log-view/EditorPanel.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;
type Language = "ca" | "es" | null;
type AgentInfo = import("../shared/types.ts").AgentInfo;
type LogEntry = import("../shared/types.ts").LogEntry;

// The skills popover fetches its counters on open, and the editor fetches the
// file it is told to open. Nothing else here reaches the API: an unlisted path
// rejects, so a surface that lost its own copy fails its anchor rather than
// passing quietly.
const commandCalls: Array<{ method: string; path: string; body: unknown }> = [];
setApiShim(async (method, path, body) => {
  if (path === "/api/skill-usage") return { counts: {} };
  if (path === "/api/agents/a1/messages") {
    commandCalls.push({ method, path, body });
    return { messageId: "" };
  }
  throw new Error(`no shim for ${path}`);
});
afterAll(() => setApiShim(null));

const AGENT = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  userId: "u1",
  username: "Tester",
  queue: [
    {
      id: "q1",
      sender: {
        kind: "agent",
        agentId: "a2",
        agentName: "Isomuxer3",
        roomName: "Sala Nord",
      },
      text: "Hola.",
      attachments: [
        { originalName: "a.png", mediaType: "image/png" },
        { originalName: "b.png", mediaType: "image/png" },
      ],
      queuedAt: 1,
    },
  ],
  pendingPrompt: "permission",
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
} as unknown as AgentInfo;

function entry(over: Partial<LogEntry>): LogEntry {
  return {
    id: "e1",
    agentId: AGENT.id,
    timestamp: 1,
    kind: "text",
    content: "",
    ...over,
  };
}

// One user message, one isomux API call (a Bash tool call the card parses), and
// one terminal-command card, which is also what renders a copy button.
const SEEDED: LogEntry[] = [
  entry({ id: "u1", kind: "user_message", content: "Hola." }),
  entry({
    id: "t1",
    kind: "tool_call",
    content: "Bash",
    metadata: {
      toolId: "tool-1",
      input: { command: "curl -s 'localhost:4000/api/memory?scope=agent'" },
    },
  }),
  entry({
    id: "c1",
    kind: "terminal-command",
    content: "",
    terminal: { command: "bun test" },
  }),
  entry({
    id: "m1",
    kind: "text",
    content: "```mermaid\ngraph TD;A-->B;\n```",
  }),
];

const logView = (
  language: Language,
  logs: LogEntry[],
  agent: AgentInfo = AGENT,
  stateOver: Record<string, unknown> = {},
) =>
  onLanguage(
    language,
    createElement(LogView, {
      agent,
      logs,
      onBack: () => {},
      onEditAgent: () => {},
    }),
    {
      agents: [agent],
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
      ],
      hasReceivedInitialState: true,
      // The empty state says "send a message" only when the socket is up;
      // offline it says the view is still loading.
      connected: true,
      office: {
        prompt: null,
        envFile: null,
        name: null,
      },
      ...stateOver,
    },
  );

const editorPanel = (language: Language) =>
  onLanguage(
    language,
    createElement(EditorPanel, {
      agentId: AGENT.id,
      initialPath: null,
      onClose: () => {},
    }),
    { hasReceivedInitialState: true },
  );

// One anchor per surface, each a string only that surface shows.
const ANCHOR = {
  // The empty conversation.
  emptyStart: translationsFor("logView.emptyStart"),
  emptyResume: translationsFor("logView.emptyResume"),
  // The composer's placeholder on a desktop viewport with an idle agent.
  composer: translationsFor("logView.composer.type"),
  // The header's agent button.
  editAgent: translationsFor("logView.editAgent"),
  // An agent parked on a permission prompt, which is the header label that
  // ui/pending-prompt.ts now supplies as a key.
  pendingPrompt: translationsFor("logView.pendingPrompt.permission"),
  // The control that opens the terminal panel, which stands in for the panel
  // itself (see the file header).
  openTerminal: translationsFor("logView.nav.terminalTitle"),
  abort: translationsFor("logView.abortTitle"),
  abortButton: translationsFor("logView.abort"),
  sendNow: translationsFor("logView.queue.flushHint"),
  // The context battery with no reading, by its accessible name.
  battery: translationsFor("contextBattery.ariaUnknown"),
  // The subscription pill with no reading, by its accessible name.
  pill: translationsFor("subscription.ariaUnknown"),
  // The API-call card's label, which proves the catalog path AND the curl
  // parser at once: the key is chosen from the request's scope parameter.
  apiCall: translationsFor("apiCall.memory.readAgent"),
  // A card's own chrome.
  terminalCard: translationsFor("cards.terminalCommand.copy"),
  // The shared copy button the card renders, which is in common.* because more
  // than one surface uses it.
  copy: translationsFor("common.copy"),
  // The editor panel's own chrome, on the empty editor.
  editorEmpty: translationsFor("panels.editor.noFileOpen"),
  editorClose: translationsFor("panels.editor.close"),
  endConversation: translationsFor("logView.nav.endConversationTitle"),
  // A queued message's chip: the prefix, and the sender shape it shares with a
  // delivered message.
  queueChip: translationsFrom(({ t }) =>
    t("logView.queue.chip", {
      label: t("common.sender.agentInRoom", {
        name: "Isomuxer3",
        room: "Sala Nord",
      }),
    }),
  ),
  // Its attachment count, through tn(). The clip is a sibling in the same text
  // node, so the anchor is the line as a reader sees it.
  queueAttachments: translationsFrom(
    ({ tn }) => `📎 ${tn("logView.queue.attachments", 2)}`,
  ),
  viewedImages: translationsFor("cards.fileView.viewedImages", { count: 2 }),
  // The diagram placeholder, which is a CSS ::before fed by a data attribute
  // because a stylesheet cannot read the catalog.
  mermaidLoading: translationsFor("cards.markdown.rendering"),
} as const;

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);
const labelled = (view: View, text: string) =>
  expect(view.queryAllByLabelText(text).length, text).toBeGreaterThan(0);
const containsText = (view: View, text: string) =>
  expect(view.container.textContent ?? "", text).toContain(text);
const loadingLabel = (view: View) =>
  view.container.querySelector<HTMLElement>(".mermaid")?.dataset.loading;
const titled = (view: View, text: string) =>
  expect(
    view.container.querySelectorAll(`[title="${text}"]`).length,
    text,
  ).toBeGreaterThan(0);

describe("the anchors", () => {
  it("resolves each catalog anchor in every shipped language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR)) {
      expect(Object.keys(anchor).sort(), name).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size, name).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });
});

describe("the log view chrome", () => {
  // This one shared-tree case retains the assertions formerly named:
  // "keeps the escalated Abort label short and shows its shortcut in a tooltip"
  // and "opens resume from the empty state and ends a populated conversation
  // through slash commands". Those states are rerenders now, not fresh mounts.
  it("reads the languages and keeps the conversation controls working", () => {
    const view = render(logView("ca", []));
    containsText(view, ANCHOR.emptyStart.ca);
    shows(view, ANCHOR.emptyResume.ca);
    shows(view, ANCHOR.pendingPrompt.ca);
    shows(view, ANCHOR.queueChip.ca);
    shows(view, ANCHOR.queueAttachments.ca);
    titled(view, ANCHOR.editAgent.ca);
    titled(view, ANCHOR.openTerminal.ca);
    titled(view, ANCHOR.sendNow.ca);
    labelled(view, ANCHOR.battery.ca);
    labelled(view, ANCHOR.pill.ca);
    expect(
      view.queryByPlaceholderText(ANCHOR.composer.ca),
      "composer",
    ).not.toBeNull();
    expect(view.queryByText(ANCHOR.emptyResume.en)).toBeNull();

    view.rerender(logView("es", []));
    containsText(view, ANCHOR.emptyStart.es);
    shows(view, ANCHOR.emptyResume.es);
    shows(view, ANCHOR.pendingPrompt.es);
    shows(view, ANCHOR.queueChip.es);
    shows(view, ANCHOR.queueAttachments.es);
    titled(view, ANCHOR.editAgent.es);
    titled(view, ANCHOR.sendNow.es);
    labelled(view, ANCHOR.battery.es);
    labelled(view, ANCHOR.pill.es);
    expect(view.queryByPlaceholderText(ANCHOR.composer.es)).not.toBeNull();
    expect(view.queryByText(ANCHOR.emptyResume.ca)).toBeNull();

    view.rerender(logView(null, []));
    containsText(view, ANCHOR.emptyStart.en);
    shows(view, ANCHOR.emptyResume.en);
    shows(view, ANCHOR.pendingPrompt.en);
    shows(view, ANCHOR.queueChip.en);
    shows(view, ANCHOR.queueAttachments.en);
    titled(view, ANCHOR.editAgent.en);
    titled(view, ANCHOR.openTerminal.en);
    titled(view, ANCHOR.sendNow.en);
    labelled(view, ANCHOR.battery.en);
    labelled(view, ANCHOR.pill.en);
    expect(view.queryByPlaceholderText(ANCHOR.composer.en)).not.toBeNull();
    const busyAgent = { ...AGENT, state: "thinking", queue: [] } as AgentInfo;
    const stateOver = {
      stateChangedAt: new Map([[busyAgent.id, Date.now() - 3 * 60 * 1000]]),
    };
    view.rerender(logView("ca", [], busyAgent, stateOver));
    titled(view, ANCHOR.abort.ca);
    expect(
      view.getByRole("button", { name: ANCHOR.abortButton.ca }),
    ).not.toBeNull();

    view.rerender(logView("es", [], busyAgent, stateOver));
    titled(view, ANCHOR.abort.es);
    expect(
      view.getByRole("button", { name: ANCHOR.abortButton.es }),
    ).not.toBeNull();

    view.rerender(logView(null, [], busyAgent, stateOver));
    titled(view, ANCHOR.abort.en);
    expect(
      view.getByRole("button", { name: ANCHOR.abortButton.en }),
    ).not.toBeNull();
    commandCalls.length = 0;
    view.rerender(logView(null, []));
    fireEvent.click(view.getByRole("button", { name: ANCHOR.emptyResume.en }));
    expect(commandCalls.at(-1)).toEqual({
      method: "POST",
      path: "/api/agents/a1/messages",
      body: { text: "/resume" },
    });

    view.rerender(logView(null, SEEDED));
    fireEvent.click(view.getByTitle(ANCHOR.endConversation.en));
    expect(commandCalls.at(-1)).toEqual({
      method: "POST",
      path: "/api/agents/a1/messages",
      body: { text: "/clear" },
    });
  });
});

describe("the cards", () => {
  it("read the language too, including the API-call card's parsed label", () => {
    const view = render(logView("ca", SEEDED));
    shows(view, ANCHOR.apiCall.ca);
    shows(view, ANCHOR.terminalCard.ca);
    titled(view, ANCHOR.copy.ca);
    expect(loadingLabel(view), "mermaid").toBe(ANCHOR.mermaidLoading.ca);

    view.rerender(logView("es", SEEDED));
    shows(view, ANCHOR.apiCall.es);
    shows(view, ANCHOR.terminalCard.es);
    titled(view, ANCHOR.copy.es);
    expect(loadingLabel(view), "mermaid").toBe(ANCHOR.mermaidLoading.es);
    expect(view.queryByText(ANCHOR.apiCall.ca)).toBeNull();

    view.rerender(logView(null, SEEDED));
    shows(view, ANCHOR.apiCall.en);
    shows(view, ANCHOR.terminalCard.en);
    titled(view, ANCHOR.copy.en);
    expect(loadingLabel(view), "mermaid").toBe(ANCHOR.mermaidLoading.en);
  });
});

// A raw tool-call group carrying a subagent origin, and the attachment echo a
// tool_result collapses to. Both are card states the log view reaches on its
// own; they mount directly here because driving LogView into them would need a
// grouped turn and a paired file read for no extra evidence.
const GROUP: LogEntry[] = [
  entry({
    id: "g1",
    kind: "tool_call",
    content: "Read",
    metadata: {
      toolId: "g-tool-1",
      input: { file_path: "/tmp/a.ts" },
      subagent: { parentToolUseId: "p1", type: "Explore" },
    },
  }),
  entry({
    id: "g2",
    kind: "tool_call",
    content: "Grep",
    metadata: { toolId: "g-tool-2", input: { pattern: "x" } },
  }),
];

const ECHO_CALL = entry({
  id: "ec1",
  kind: "tool_call",
  content: "Read",
  metadata: {
    toolId: "echo-1",
    input: { file_path: `/home/x/.isomux/logs/${AGENT.id}/files/a.png` },
  },
});
const ECHO_RESULT = entry({
  id: "ec2",
  kind: "tool_result",
  content: "read 2 images",
  metadata: { toolUseId: "echo-1" },
  attachments: [
    {
      filename: "a1.png",
      originalName: "a.png",
      mediaType: "image/png",
      size: 1,
    },
    {
      filename: "b1.png",
      originalName: "b.png",
      mediaType: "image/png",
      size: 2,
    },
  ],
});

const toolGroup = (language: Language) =>
  onLanguage(
    language,
    createElement(RawToolCallGroupCard, { entries: GROUP }),
    { hasReceivedInitialState: true },
  );

const attachmentEcho = (language: Language) =>
  onLanguage(
    language,
    createElement(LogEntryCard, {
      entry: ECHO_RESULT,
      turnEntries: [ECHO_CALL, ECHO_RESULT],
    }),
    { hasReceivedInitialState: true },
  );

describe("a raw tool-call group", () => {
  it("counts its calls in the reader's language in BOTH the collapsed and the expanded state", () => {
    for (const [language, count, subagentTitle] of [
      ["ca", "2 crides a eines", null],
      ["es", "2 llamadas a herramientas", "Subagente (Explore)"],
      [null, "2 tool calls", "Subagent (Explore)"],
    ] as const) {
      const view = render(toolGroup(language));
      containsText(view, count);
      // The pill's own words are the same in English and Catalan - "subagent"
      // IS the Catalan word - so Spanish is what proves the language here, and
      // the count above is what proves it for Catalan.
      if (subagentTitle)
        expect(
          view.container.querySelectorAll(`[title="${subagentTitle}"]`).length,
          subagentTitle,
        ).toBeGreaterThan(0);

      // Expanding replaces the header, so this asserts the OTHER branch.
      const toggle = view.container.querySelector(
        "button",
      ) as HTMLButtonElement;
      act(() => toggle.click());
      containsText(view, count);
      expect(view.container.querySelectorAll("button").length).toBeGreaterThan(
        1,
      );
      view.unmount();
    }
  });
});

describe("the attachment echo", () => {
  it("is one whole frame per branch, with the count as data", () => {
    const view = render(attachmentEcho("ca"));
    shows(view, ANCHOR.viewedImages.ca);

    view.rerender(attachmentEcho("es"));
    shows(view, ANCHOR.viewedImages.es);

    view.rerender(attachmentEcho(null));
    shows(view, ANCHOR.viewedImages.en);
  });
});

describe("the editor panel", () => {
  it("reads the language on its own mount", () => {
    const view = render(editorPanel("ca"));
    shows(view, ANCHOR.editorEmpty.ca);
    titled(view, ANCHOR.editorClose.ca);

    view.rerender(editorPanel("es"));
    shows(view, ANCHOR.editorEmpty.es);
    titled(view, ANCHOR.editorClose.es);

    view.rerender(editorPanel(null));
    shows(view, ANCHOR.editorEmpty.en);
    titled(view, ANCHOR.editorClose.en);
  });
});
