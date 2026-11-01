// The chat bar's Copy offers what to copy (tasks c630195a, 30cd9913) and in
// which format (task 28bd5993): each choice puts its own text on the
// clipboard. What each text holds is pinned in LogEntryCard.test.ts; this file
// pins that each choice reaches it, with the agent's name and the format the
// browser remembers. With HTML file picked (task 04d675c0), each choice saves
// a file of the chat as it shows; the page rules are pinned in
// chat-export.dom.test.ts, the snapshot of the real chat here.

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { chatCopyText } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { activeContentIn, officeUrlsIn, parseExport } =
  await import("../test-support/export-html.ts");

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AppState = import("../store.tsx").AppState;
const EN = translatorFor("en");
// A protocol value: the per-browser key the format is saved under.
const FORMAT_KEY = "isomux-chat-copy-format";
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
  localStorage.removeItem(FORMAT_KEY);
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
  entry("x1", "text", "First *reply*."),
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

function mountView(
  over: Partial<AppState> = {},
  props: { agent: AgentInfo; logs: LogEntry[] } = { agent, logs },
) {
  const view = render(
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
  );
  const triggers = view.container.querySelectorAll(
    'button[aria-haspopup="menu"]',
  );
  // Copy is the bar's one action with a menu.
  expect(triggers.length).toBe(1);
  const menuItem = (id: string) =>
    document.querySelector(
      `[data-nav-menu="copy"] [data-nav-menu-item="${id}"]`,
    );
  const open = () => {
    if (!document.querySelector('[data-nav-menu="copy"]'))
      fireEvent.click(triggers[0]);
    expect(document.querySelector('[data-nav-menu="copy"]')).not.toBeNull();
  };
  const choose = async (id: string) => {
    open();
    const item = menuItem(id);
    expect(item).not.toBeNull();
    await act(async () => {
      fireEvent.click(item!);
    });
  };
  const checked = () => {
    open();
    return ["markdown", "plain", "html"].filter(
      (id) => menuItem(id)?.getAttribute("aria-checked") === "true",
    );
  };
  return { view, choose, checked, menuItem };
}

// Clicks each Copy choice in menu order and returns what each one copied.
async function copyEach(over: Partial<AppState>): Promise<string[]> {
  const { view, choose } = mountView(over);
  for (const scope of scopes) await choose(scope);
  view.unmount();
  return copied;
}

const opts = (self: string | null, format: "markdown" | "plain") => ({
  self,
  agentName: agent.name,
  format,
});

it("each Copy choice puts its own text on the clipboard", async () => {
  const expected = scopes.map((s) =>
    chatCopyText(EN, logs, s, opts("Tester", "markdown")),
  );
  // The fixture tells the four apart, so a swapped choice shows.
  expect(new Set(expected).size).toBe(4);
  expect(
    chatCopyText(EN, logs, "myMessages", opts("Other", "markdown")),
  ).not.toBe(expected[1]);
  // The agent's name labels its replies, so a view that passed another name
  // copies other text.
  expect(
    chatCopyText(EN, logs, "everything", {
      ...opts("Tester", "markdown"),
      agentName: "Someone",
    }),
  ).not.toBe(expected[2]);
  expect(await copyEach({})).toEqual(expected);
});

it("My messages falls back to the browser's saved name with no session", async () => {
  const mine = chatCopyText(EN, logs, "myMessages", opts("Other", "markdown"));
  expect(mine).not.toBe(
    chatCopyText(EN, logs, "myMessages", opts("Tester", "markdown")),
  );
  expect(mine).not.toBe(
    chatCopyText(EN, logs, "myMessages", opts(null, "markdown")),
  );
  expect((await copyEach({ sessionContext: null }))[1]).toBe(mine);
});

it("a format choice keeps the menu open, applies to the next copy, and is remembered", async () => {
  const markdown = chatCopyText(
    EN,
    logs,
    "everything",
    opts("Tester", "markdown"),
  );
  const plain = chatCopyText(EN, logs, "everything", opts("Tester", "plain"));
  // The fixture's reply has Markdown, so the two formats differ.
  expect(plain).not.toBe(markdown);

  const first = mountView();
  // Markdown until the browser picks another.
  expect(first.checked()).toEqual(["markdown"]);
  await first.choose("plain");
  // Picking a format copies nothing and leaves the choices open.
  expect(copied).toEqual([]);
  expect(first.menuItem("plain")).not.toBeNull();
  expect(first.checked()).toEqual(["plain"]);
  await first.choose("everything");
  expect(copied).toEqual([plain]);
  first.view.unmount();

  // A later chat in this browser starts in Plain text.
  const second = mountView();
  expect(second.checked()).toEqual(["plain"]);
  await second.choose("everything");
  await second.choose("markdown");
  expect(second.checked()).toEqual(["markdown"]);
  await second.choose("everything");
  expect(copied).toEqual([plain, plain, markdown]);
  second.view.unmount();

  const third = mountView();
  expect(third.checked()).toEqual(["markdown"]);
  third.view.unmount();
});

it("a saved format this build does not know copies Markdown", async () => {
  localStorage.setItem(FORMAT_KEY, "rtf");
  const { view, checked, choose } = mountView();
  expect(checked()).toEqual(["markdown"]);
  await choose("everything");
  expect(copied).toEqual([
    chatCopyText(EN, logs, "everything", opts("Tester", "markdown")),
  ]);
  view.unmount();
});

// --- HTML file ---

// An agent that waits for a reply, so a member message can be edited.
const waiting = { ...agent, state: "waiting_for_response" } as AgentInfo;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const BIG = 6 * 1024 * 1024;
const image = (filename: string, originalName: string) => ({
  filename,
  originalName,
  mediaType: "image/png",
});
const htmlLogs: LogEntry[] = [
  {
    ...entry("u1", "user_message", "First ask.", { username: "Tester" }),
    attachments: [
      image("ok.png", "small-shot.png"),
      image("gone.png", "missing-shot.png"),
      image("big.png", "huge-shot.png"),
    ],
  } as LogEntry,
  entry("c1", "tool_call", "Bash", {
    toolId: "t1",
    input: { command: "echo one" },
  }),
  entry("r1", "tool_result", "one", { toolUseId: "t1" }),
  entry(
    "x1",
    "text",
    "See [the docs](https://example.com/doc) and [the board](/tasks).\n\n```\ncode line\n```",
  ),
  // The office asks the member to pick a model under this notice.
  entry("n1", "system", "No model.", { pickModel: true }),
  // Collapsed in the chat: its lines join into one row.
  entry("p1", "user_message", "Peer line one\nPeer line two", {
    sender_agent_name: "Helper",
    sender_agent_id: "a2",
  }),
  // An app report: collapsed in the chat to a preview height.
  entry("m1", "user_message", "Report body text.", {
    sender_app_name: "Monitor",
    username: "Monitor",
  }),
  entry("u2", "user_message", "Second ask.", { username: "Tester" }),
  entry("x2", "text", "Second reply."),
];

type Download = { name: string; html: string; type: string };

// Captures the files the view saves: the Blob behind the object URL, and the
// name on the link it clicks. A click on any other link is not a download.
function captureDownloads() {
  const blobs = new Map<string, Blob>();
  const pending: Promise<Download>[] = [];
  const realCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const realRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  // The anchor's own click, if happy-dom gives it one, else the inherited one.
  const ownClick = Object.getOwnPropertyDescriptor(
    HTMLAnchorElement.prototype,
    "click",
  );
  const inheritedClick = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "click",
  );
  const realClick = (ownClick ?? inheritedClick)?.value as (
    this: HTMLElement,
  ) => void;
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:http://localhost/export-${++n}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (!blob || !this.hasAttribute("download")) return realClick.call(this);
    const name = this.getAttribute("download") ?? "";
    pending.push(blob.text().then((html) => ({ name, html, type: blob.type })));
  };
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url.includes("/ok.png"))
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (url.includes("/big.png"))
      return new Response(new Uint8Array(BIG), {
        headers: { "content-type": "image/png" },
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetched,
    count: () => pending.length,
    all: () => Promise.all(pending),
    restore() {
      for (const [name, real] of [
        ["createObjectURL", realCreate],
        ["revokeObjectURL", realRevoke],
      ] as const)
        if (real) Object.defineProperty(URL, name, real);
        else Reflect.deleteProperty(URL, name);
      if (ownClick)
        Object.defineProperty(HTMLAnchorElement.prototype, "click", ownClick);
      else Reflect.deleteProperty(HTMLAnchorElement.prototype, "click");
      globalThis.fetch = realFetch;
    },
  };
}

// The text of the element that holds `needle`, and of its ancestors up to the
// chat entry, joined: where a clamp or a style on the way shows.
function stylesAround(root: ParentNode, needle: string): string {
  const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
  const holder = all
    .filter((el) => el.textContent?.includes(needle))
    .reduce<HTMLElement | null>(
      (deepest, el) => (!deepest || deepest.contains(el) ? el : deepest),
      null,
    );
  expect(holder).not.toBeNull();
  const styles: string[] = [];
  for (let el: HTMLElement | null = holder; el; el = el.parentElement) {
    styles.push(el.getAttribute("style") ?? "");
    if (el.hasAttribute("data-log-entry-id")) break;
  }
  return styles.join(";");
}

const LINE_CLAMP = /line-clamp/i;
const MAX_HEIGHT = /max-height/i;

it("with HTML file picked, each choice saves a file of the chat as it shows, not the clipboard", async () => {
  document.documentElement.setAttribute("data-theme", "test-theme");
  document.documentElement.setAttribute("data-theme-mode", "light");
  const downloads = captureDownloads();
  try {
    const { view, choose, checked } = mountView(
      {},
      { agent: waiting, logs: htmlLogs },
    );
    const chat = view.container;
    await choose("html");
    expect(checked()).toEqual(["html"]);
    expect(localStorage.getItem(FORMAT_KEY)).toBe("html");

    // The chat as the member left it: both messages collapsed, the second
    // ask open in its editor with a draft, and the controls a file cannot use.
    expect(chat.textContent).toContain("Peer line one · Peer line two");
    expect(stylesAround(chat, "Report body text.")).toMatch(MAX_HEIGHT);
    const editButtons = chat.querySelectorAll("[data-edit-message]");
    expect(editButtons.length).toBeGreaterThan(0);
    fireEvent.click(editButtons[editButtons.length - 1]);
    const editor = chat.querySelector("textarea");
    expect(editor).not.toBeNull();
    // The composer is a textarea too: the editor is the one with the message.
    const draftBox = Array.from(chat.querySelectorAll("textarea")).find(
      (ta) => ta.value === "Second ask.",
    );
    expect(draftBox).toBeDefined();
    fireEvent.change(draftBox!, { target: { value: "Draft words" } });
    const copyTitle = EN.t("common.copy");
    expect(
      chat.querySelectorAll(`button[title="${copyTitle}"]`).length,
    ).toBeGreaterThan(0);
    expect(chat.textContent).toContain("echo one");
    // Controls of the chat: a code block's copy, the message toggle, the
    // editor's Cancel, the model picker.
    const expandTitle = EN.t("cards.userMessage.expand");
    const collapseTitle = EN.t("cards.userMessage.collapse");
    const cancel = EN.t("common.cancel");
    const buttonsLabelled = (root: ParentNode, label: string) =>
      Array.from(root.querySelectorAll("button")).filter(
        (b) => b.textContent?.trim() === label,
      ).length;
    expect(chat.querySelectorAll(".code-copy-btn").length).toBeGreaterThan(0);
    expect(
      chat.querySelectorAll(`button[title="${expandTitle}"]`).length,
    ).toBeGreaterThan(0);
    expect(buttonsLabelled(chat, cancel)).toBeGreaterThan(0);
    expect(chat.querySelectorAll("[data-pick-model]").length).toBe(1);

    for (const scope of scopes) {
      await choose(scope);
      const want = scopes.indexOf(scope) + 1;
      await waitFor(() => expect(downloads.count()).toBe(want));
    }
    const files = await downloads.all();
    expect(files).toHaveLength(4);
    // Nothing went to the clipboard.
    expect(copied).toEqual([]);

    for (const file of files) {
      expect(file.name).toMatch(/^worker-chat-\d{4}-\d{2}-\d{2}\.html$/);
      expect(file.type).toMatch(/^text\/html/);
      expect(officeUrlsIn(file.html, location.origin)).toEqual([]);
      expect(activeContentIn(file.html)).toEqual([]);
      const doc = parseExport(file.html);
      expect(doc.documentElement.getAttribute("data-theme")).toBe("test-theme");
      expect(doc.documentElement.getAttribute("data-theme-mode")).toBe("light");
      // The controls of the chat are not in the file.
      expect(doc.querySelectorAll(`button[title="${copyTitle}"]`).length).toBe(
        0,
      );
      expect(doc.querySelectorAll("[data-edit-message]").length).toBe(0);
      expect(doc.querySelectorAll(".code-copy-btn").length).toBe(0);
      expect(
        doc.querySelectorAll(
          `button[title="${expandTitle}"], button[title="${collapseTitle}"]`,
        ).length,
      ).toBe(0);
      expect(buttonsLabelled(doc, cancel)).toBe(0);
      expect(doc.querySelectorAll("[data-pick-model]").length).toBe(0);
      expect(doc.body.textContent).not.toContain("Draft words");
    }
    const [messages, mine, everything, lastExchange] = files.map(
      (f) => parseExport(f.html).body,
    );

    // Each choice holds its own entries, in chat order.
    const text = everything.textContent ?? "";
    const needles = [
      "First ask.",
      "echo one",
      "the docs",
      "code line",
      "Peer line one",
      "Report body text.",
      "Second ask.",
      "Second reply.",
    ];
    expect(needles.filter((needle) => !text.includes(needle))).toEqual([]);
    const order = needles.map((needle) => text.indexOf(needle));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(messages.textContent).toContain("Second reply.");
    expect(messages.textContent).not.toContain("echo one");
    expect(mine.textContent).toContain("First ask.");
    expect(mine.textContent).toContain("Second ask.");
    expect(mine.textContent).not.toContain("Second reply.");
    expect(mine.textContent).not.toContain("Report body text.");
    expect(lastExchange.textContent).toContain("Second reply.");
    expect(lastExchange.textContent).not.toContain("First ask.");

    // The file shows each message in full: the peer message with its lines,
    // the app report with no preview height, the edited ask as sent.
    expect(text).toContain("Peer line one\nPeer line two");
    expect(text).not.toContain("Peer line one · Peer line two");
    expect(stylesAround(everything, "Peer line two")).not.toMatch(LINE_CLAMP);
    expect(stylesAround(everything, "Report body text.")).not.toMatch(
      MAX_HEIGHT,
    );
    expect(text).toContain("Second ask.");

    // An external link stays a link; a link into the office keeps its text.
    const external = everything.querySelector(
      'a[href="https://example.com/doc"]',
    );
    expect(external?.textContent).toBe("the docs");
    expect(external?.getAttribute("rel") ?? "").toContain("noopener");
    expect(text).toContain("the board");

    // Images are in the file: inlined, or their name when the office could
    // not send one or it is too large.
    const imgs = Array.from(everything.querySelectorAll("img"));
    const shot = imgs.find(
      (img) => img.getAttribute("alt") === "small-shot.png",
    );
    expect(shot?.getAttribute("src")).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    );
    for (const name of ["missing-shot.png", "huge-shot.png"]) {
      expect(imgs.some((img) => img.getAttribute("alt") === name)).toBe(false);
      expect(text).toContain(name);
    }
    expect(downloads.fetched.some((url) => url.includes("/big.png"))).toBe(
      true,
    );

    // The chat is as the member left it, with the draft kept.
    expect(chat.textContent).toContain("Peer line one · Peer line two");
    expect(stylesAround(chat, "Report body text.")).toMatch(MAX_HEIGHT);
    expect(
      Array.from(chat.querySelectorAll("textarea")).some(
        (ta) => ta.value === "Draft words",
      ),
    ).toBe(true);
    view.unmount();
  } finally {
    downloads.restore();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-mode");
  }
});
