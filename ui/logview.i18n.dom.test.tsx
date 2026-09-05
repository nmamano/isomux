// S5 of the office i18n loop (internal-docs/i18n-loop.md): the agent log view -
// its header and nav actions, the composer, the empty state, the cards, the
// API-call card's labels, the context battery and the subscription pill -
// renders in the language the signed-in user is on. The editor panel is
// mounted on its own below, through the same language context.
//
// The oracles are literal strings (ruling 14): an expectation read back through
// the translator would pass for any translation. The first describe proves each
// anchor differs in all three languages, so a match is evidence of the language
// and not of a word that never moved.
//
// LogView takes its agent and its log as props, so it mounts directly rather
// than through App. The TERMINAL panel is deliberately not mounted: it carries a
// real xterm, which ui/log-view/TerminalPanel.replay.dom.test.tsx exists to pay
// for, so the terminal's anchor here is the control that opens it.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
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
setApiShim(async (_method, path) => {
  if (path === "/api/skill-usage") return { counts: {} };
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
  entry({ id: "m1", kind: "text", content: "```mermaid\ngraph TD;A-->B;\n```" }),
];

const logView = (language: Language, logs: LogEntry[]) =>
  onLanguage(
    language,
    createElement(LogView, {
      agent: AGENT,
      logs,
      onBack: () => {},
      onEditAgent: () => {},
    }),
    {
      agents: [AGENT],
      rooms: [{ id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true }],
      hasReceivedInitialState: true,
      // The empty state says "send a message" only when the socket is up;
      // offline it says the view is still loading.
      connected: true,
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
  empty: {
    ca: "Envia un missatge per començar una conversa.",
    es: "Envía un mensaje para empezar una conversación.",
    en: "Send a message to start a conversation.",
  },
  // The composer's placeholder on a desktop viewport with an idle agent.
  composer: {
    ca: "Escriu un missatge o / per a les ordres...",
    es: "Escribe un mensaje o / para los comandos...",
    en: "Type a message or / for commands...",
  },
  // The header's agent button.
  editAgent: {
    ca: "Edita l'agent",
    es: "Editar el agente",
    en: "Edit agent",
  },
  // An agent parked on a permission prompt, which is the header label that
  // ui/pending-prompt.ts now supplies as a key.
  pendingPrompt: {
    ca: "Esperant un permís",
    es: "Esperando un permiso",
    en: "Waiting for permission",
  },
  // The control that opens the terminal panel, which stands in for the panel
  // itself (see the file header).
  openTerminal: {
    ca: "Obre la terminal (Ctrl+`)",
    es: "Abrir la terminal (Ctrl+`)",
    en: "Open terminal (Ctrl+`)",
  },
  // The context battery with no reading, by its accessible name.
  battery: {
    ca: "L'ús del context encara no s'ha mesurat. Toca per veure'n els detalls.",
    es: "El uso del contexto todavía no se ha medido. Toca para ver los detalles.",
    en: "Context usage not measured yet. Tap for details.",
  },
  // The subscription pill with no reading, by its accessible name.
  pill: {
    ca: "L'ús del pla encara no s'ha informat. Toca per veure'n els detalls.",
    es: "El uso del plan todavía no se ha informado. Toca para ver los detalles.",
    en: "Plan usage not reported yet. Tap for details.",
  },
  // The API-call card's label, which proves the catalog path AND the curl
  // parser at once: the key is chosen from the request's scope parameter.
  apiCall: {
    ca: "Llegir les memòries d'aquest agent",
    es: "Leer las memorias de este agente",
    en: "Read memories for this agent",
  },
  // A card's own chrome.
  terminalCard: {
    ca: "Copia a la terminal",
    es: "Copiar en la terminal",
    en: "Copy to terminal",
  },
  // The shared copy button the card renders, which is in common.* because more
  // than one surface uses it.
  copy: { ca: "Copia", es: "Copiar", en: "Copy" },
  // The editor panel's own chrome, on the empty editor.
  editorEmpty: {
    ca: "Cap fitxer obert",
    es: "Ningún archivo abierto",
    en: "No file open",
  },
  editorClose: {
    ca: "Tanca l'editor",
    es: "Cerrar el editor",
    en: "Close editor",
  },
  // A queued message's chip: the prefix, and the sender shape it shares with a
  // delivered message.
  queueChip: {
    ca: 'en cua · Isomuxer3 · agent · Sala "Sala Nord"',
    es: 'en cola · Isomuxer3 · agente · Sala "Sala Nord"',
    en: 'queued · Isomuxer3 · agent · Room "Sala Nord"',
  },
  // Its attachment count, through tn(). The clip is a sibling in the same text
  // node, so the anchor is the line as a reader sees it.
  queueAttachments: {
    ca: "📎 2 adjunts",
    es: "📎 2 adjuntos",
    en: "📎 2 attachments",
  },
  // The diagram placeholder, which is a CSS ::before fed by a data attribute
  // because a stylesheet cannot read the catalog.
  mermaidLoading: {
    ca: "Dibuixant el diagrama…",
    es: "Dibujando el diagrama…",
    en: "Rendering diagram…",
  },
} as const;

const shows = (view: View, text: string) =>
  expect(view.queryAllByText(text).length, text).toBeGreaterThan(0);
const labelled = (view: View, text: string) =>
  expect(view.queryAllByLabelText(text).length, text).toBeGreaterThan(0);
// Some rows put the literal next to a glyph in one text node ("▼ 2 tool
// calls"), so the oracle is the literal inside the rendered text - still a
// literal, never a string read back through the translator (ruling 14).
const containsText = (view: View, text: string) =>
  expect(view.container.textContent ?? "", text).toContain(text);
const loadingLabel = (view: View) =>
  view.container.querySelector<HTMLElement>(".mermaid")?.dataset.loading;
const titled = (view: View, text: string) =>
  expect(view.container.querySelectorAll(`[title="${text}"]`).length, text)
    .toBeGreaterThan(0);

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    for (const [name, anchor] of Object.entries(ANCHOR))
      expect(new Set(Object.values(anchor)).size, name).toBe(3);
  });
});

describe("the log view chrome", () => {
  it("reads Catalan on ca, then Spanish, then the English of a user who never chose", () => {
    const view = render(logView("ca", []));
    shows(view, ANCHOR.empty.ca);
    shows(view, ANCHOR.pendingPrompt.ca);
    shows(view, ANCHOR.queueChip.ca);
    shows(view, ANCHOR.queueAttachments.ca);
    titled(view, ANCHOR.editAgent.ca);
    titled(view, ANCHOR.openTerminal.ca);
    labelled(view, ANCHOR.battery.ca);
    labelled(view, ANCHOR.pill.ca);
    expect(
      view.queryByPlaceholderText(ANCHOR.composer.ca),
      "composer",
    ).not.toBeNull();
    expect(view.queryByText(ANCHOR.empty.en)).toBeNull();

    view.rerender(logView("es", []));
    shows(view, ANCHOR.empty.es);
    shows(view, ANCHOR.pendingPrompt.es);
    shows(view, ANCHOR.queueChip.es);
    shows(view, ANCHOR.queueAttachments.es);
    titled(view, ANCHOR.editAgent.es);
    labelled(view, ANCHOR.battery.es);
    labelled(view, ANCHOR.pill.es);
    expect(view.queryByPlaceholderText(ANCHOR.composer.es)).not.toBeNull();
    expect(view.queryByText(ANCHOR.empty.ca)).toBeNull();

    view.rerender(logView(null, []));
    shows(view, ANCHOR.empty.en);
    shows(view, ANCHOR.pendingPrompt.en);
    shows(view, ANCHOR.queueChip.en);
    shows(view, ANCHOR.queueAttachments.en);
    titled(view, ANCHOR.editAgent.en);
    titled(view, ANCHOR.openTerminal.en);
    labelled(view, ANCHOR.battery.en);
    labelled(view, ANCHOR.pill.en);
    expect(view.queryByPlaceholderText(ANCHOR.composer.en)).not.toBeNull();
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
    { filename: "a1.png", originalName: "a.png", mediaType: "image/png", size: 1 },
    { filename: "b1.png", originalName: "b.png", mediaType: "image/png", size: 2 },
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
      const toggle = view.container.querySelector("button") as HTMLButtonElement;
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
    shows(view, "Ha vist 2 imatges adjuntes (fes clic per mostrar-les)");

    view.rerender(attachmentEcho("es"));
    shows(view, "Ha visto 2 imágenes adjuntas (haz clic para mostrarlas)");

    view.rerender(attachmentEcho(null));
    shows(view, "Viewed 2 attached images (click to show)");
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
