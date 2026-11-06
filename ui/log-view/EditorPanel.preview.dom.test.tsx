// Editor Markdown preview (task 1c824235). A .md tab has a Preview toggle that
// shows the buffer rendered as the chat renders Markdown, in place of the
// editor. Each .md tab keeps its own mode while the panel is open; closing the
// tab forgets it. Ctrl+S still saves from the preview.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { translationsFor } from "../test-support/i18n.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { EditorView } = await import("@codemirror/view");
const { EditorPanel } = await import("./EditorPanel.tsx");
const { setEditorState } = await import("./editor-state.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");

type SessionContext = import("../../shared/types.ts").SessionContext;

const DOC = "/work/doc.md";
const OTHER_DOC = "/work/other.md";
const CODE = "/work/main.ts";

const FILES: Record<string, { content: string; language: string }> = {
  [DOC]: { content: "# Title\n\nbody", language: "markdown" },
  [OTHER_DOC]: { content: "# Other", language: "markdown" },
  [CODE]: { content: "const x = 1;", language: "typescript" },
};

let puts: { path: string; content: string }[] = [];
let agentSeq = 0;
let agentId = "";

setApiShim(async (method, path, body) => {
  if (method === "GET" && path.startsWith(`/api/agents/${agentId}/file?`)) {
    const filePath = new URLSearchParams(path.split("?")[1]).get("path") ?? "";
    const file = FILES[filePath];
    if (!file) throw new Error(`no fixture for ${filePath}`);
    return {
      path: filePath,
      content: file.content,
      mtime: 100,
      language: file.language,
      size: file.content.length,
      rev: 1,
    };
  }
  if (method === "DELETE") return undefined;
  if (method === "PUT" && path === `/api/agents/${agentId}/file`) {
    puts.push(body as { path: string; content: string });
    return { ok: true, mtime: 101, rev: 2 };
  }
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

afterEach(() => {
  cleanup();
  setEditorState(agentId, null);
  localStorage.clear();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function session(): SessionContext {
  return {
    userId: "u1",
    username: "Tester",
    role: "owner",
    currentSessionPrefix: "00000000",
    connectionId: "c1",
  };
}

function panel(initialPath: string | null, mobile = false) {
  return onLanguage(
    null,
    createElement(EditorPanel, {
      agentId,
      initialPath,
      onClose: () => {},
      mobile,
    }),
    { sessionContext: session() },
  );
}

async function mount(path: string, mobile = false) {
  agentSeq += 1;
  agentId = `agent-preview-${agentSeq}`;
  puts = [];
  const view = render(panel(path, mobile));
  await flush();
  const dom = view.container.querySelector(".cm-editor");
  if (!(dom instanceof HTMLElement)) throw new Error("no editor mounted");
  const editor = EditorView.findFromDOM(dom);
  if (!editor) throw new Error("no EditorView on the editor element");
  // The enabling condition: the file opened and its text is in the editor.
  expect(editor.state.doc.toString()).toBe(FILES[path]!.content);
  return { view, editor };
}

async function open(
  view: Awaited<ReturnType<typeof mount>>["view"],
  path: string,
  mobile = false,
) {
  view.rerender(panel(path, mobile));
  await flush();
}

const toggle = () =>
  document.querySelector<HTMLButtonElement>("[data-editor-preview-toggle]");
const pane = () => document.querySelector<HTMLElement>("[data-editor-preview]");
// CodeMirror's content element has role textbox; the default query skips an
// element that display:none or visibility:hidden takes out of view. Not
// `screen`: it keeps the body of the first file that loaded it.
const editorShown = () => within(document.body).queryByRole("textbox") !== null;

function click(el: HTMLElement | null) {
  if (!el) throw new Error("nothing to click");
  act(() => {
    fireEvent.click(el);
  });
}

// The desktop tab is a div titled with its path; the empty panel's recent
// files are buttons with the same title.
function tabFor(path: string) {
  return document.querySelector<HTMLElement>(`div[title="${path}"]`);
}

describe("editor Markdown preview", () => {
  it("offers the toggle on a Markdown tab only", async () => {
    const { view } = await mount(DOC);
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    await open(view, CODE);
    expect(editorShown()).toBe(true);
    expect(toggle()).toBeNull();
  });

  it("offers the toggle in the mobile header", async () => {
    await mount(DOC, true);
    click(toggle());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(pane()?.querySelector("h1")?.textContent).toBe("Title");
    expect(editorShown()).toBe(false);
  });

  it("renders the buffer, unsaved edits included, in place of the editor", async () => {
    const { editor } = await mount(DOC);
    act(() => {
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: "\n\n## Unsaved" },
        userEvent: "input.type",
      });
    });
    expect(editorShown()).toBe(true);
    expect(pane()).toBeNull();

    click(toggle());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(pane()?.querySelector("h1")?.textContent).toBe("Title");
    expect(pane()?.querySelector("h2")?.textContent).toBe("Unsaved");
    expect(editorShown()).toBe(false);
    // The edit is still unsaved: nothing went to the server.
    expect(puts).toHaveLength(0);

    click(toggle());
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(pane()).toBeNull();
    expect(editorShown()).toBe(true);
    expect(editor.state.doc.toString()).toBe("# Title\n\nbody\n\n## Unsaved");
  });

  it("keeps each Markdown tab's mode across tab switches", async () => {
    const { view } = await mount(DOC);
    click(toggle());
    expect(pane()).not.toBeNull();

    await open(view, CODE);
    expect(pane()).toBeNull();
    expect(editorShown()).toBe(true);

    // A second Markdown tab opens in the editor: the mode is per tab.
    await open(view, OTHER_DOC);
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(pane()).toBeNull();
    expect(editorShown()).toBe(true);

    click(tabFor(DOC));
    await flush();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    expect(pane()?.querySelector("h1")?.textContent).toBe("Title");
    expect(editorShown()).toBe(false);
  });

  it("saves with Ctrl+S right after the toggle", async () => {
    const { editor } = await mount(DOC);
    act(() => {
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: " more" },
        userEvent: "input.type",
      });
    });
    click(toggle());
    // The toggle moves the focus into the preview, so the shortcut has a
    // target there.
    const focused = document.activeElement;
    expect(pane()?.contains(focused)).toBe(true);
    act(() => {
      fireEvent.keyDown(focused!, { key: "s", ctrlKey: true });
    });
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe(DOC);
    expect(puts[0]!.content).toBe("# Title\n\nbody more");
  });

  it("opens a closed and reopened Markdown tab in the editor", async () => {
    const { view } = await mount(DOC);
    click(toggle());
    expect(pane()).not.toBeNull();

    const tab = tabFor(DOC);
    const close = Array.from(tab?.querySelectorAll("button") ?? []).find(
      (b) => b.title === translationsFor("panels.editor.closeTab").en,
    );
    click(close ?? null);
    await flush();
    expect(tabFor(DOC)).toBeNull();

    await open(view, CODE);
    await open(view, DOC);
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(pane()).toBeNull();
    expect(editorShown()).toBe(true);
  });
});
