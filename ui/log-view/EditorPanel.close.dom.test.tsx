// Editor tab close asks first when it would lose content (task 4037c7f8,
// AGENTS.md "UI rules": a destructive action without Undo asks "are you
// sure?"). A close loses content when the tab has unsaved edits, or when its
// file is gone from disk (the buffer is then the only copy). Such a close arms
// the control on the first click and runs on the second; a close that loses
// nothing runs at once. The deleted-file banner's Close always asks.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { translationsFor } from "../test-support/i18n.ts";

setUpDomTestFile();

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { createElement } = await import("react");
const { EditorView } = await import("@codemirror/view");
const { EditorPanel } = await import("./EditorPanel.tsx");
const { getEditorState, setEditorState } = await import("./editor-state.ts");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { shimEmit } = await import("../ws.ts");

type SessionContext = import("../../shared/types.ts").SessionContext;

const A = "/work/a.txt";
const B = "/work/b.txt";
const CONTENT: Record<string, string> = { [A]: "alpha", [B]: "beta" };

let agentSeq = 0;
let agentId = "";

setApiShim(async (method, path) => {
  if (method === "GET" && path.startsWith(`/api/agents/${agentId}/file?`)) {
    const filePath = new URLSearchParams(path.split("?")[1]).get("path") ?? "";
    const content = CONTENT[filePath];
    if (content === undefined) throw new Error(`no fixture for ${filePath}`);
    return {
      path: filePath,
      content,
      mtime: 100,
      language: "text",
      size: content.length,
      rev: 1,
    };
  }
  if (method === "DELETE") return undefined;
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

function panel(initialPath: string, mobile: boolean) {
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

function editorView(): InstanceType<typeof EditorView> {
  const dom = document.querySelector(".cm-editor");
  if (!(dom instanceof HTMLElement)) throw new Error("no editor mounted");
  const editor = EditorView.findFromDOM(dom);
  if (!editor) throw new Error("no EditorView on the editor element");
  return editor;
}

// Opens A, then B (B is active). Both tabs are clean.
async function mount(mobile = false) {
  agentSeq += 1;
  agentId = `agent-close-${agentSeq}`;
  const view = render(panel(A, mobile));
  await flush();
  view.rerender(panel(B, mobile));
  await flush();
  expect(editorView().state.doc.toString()).toBe(CONTENT[B]!);
  expect(persisted(A)?.dirty).toBe(false);
  expect(persisted(B)?.dirty).toBe(false);
  return view;
}

const persisted = (path: string) =>
  getEditorState(agentId)?.tabs.find((t) => t.path === path);

// Types into the active tab (B), which makes it dirty.
function typeIntoActive(text: string) {
  const editor = editorView();
  act(() => {
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: text },
      userEvent: "input.type",
    });
  });
}

// The tab row is a div titled with its path, in the desktop strip and in the
// phone list alike; its one button is the close.
function tabRow(path: string) {
  return document.querySelector<HTMLElement>(`div[title="${path}"]`);
}
function closeButton(path: string): HTMLButtonElement {
  const button = tabRow(path)?.querySelector("button");
  if (!(button instanceof HTMLButtonElement))
    throw new Error(`no close button on the tab of ${path}`);
  return button;
}
// The deleted-file banner's Close is the button that reads as Close tab (the
// tab close only carries that as a title).
function bannerClose(): HTMLButtonElement | null {
  const label = translationsFor("panels.editor.closeTab").en;
  return (
    Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    ) ?? null
  );
}
const armed = (el: HTMLElement) => el.hasAttribute("data-confirm-armed");

function click(el: HTMLElement) {
  act(() => {
    fireEvent.click(el);
  });
}

// Opens the phone tab list (the switcher button is titled with the active
// tab's path).
function openPhoneList() {
  const switcher = document.querySelector<HTMLButtonElement>(
    `button[title="${B}"]`,
  );
  if (!switcher) throw new Error("no phone tab switcher");
  click(switcher);
  expect(tabRow(A)).not.toBeNull();
  expect(tabRow(B)).not.toBeNull();
}

describe("editor tab close", () => {
  it("asks before it closes a tab with unsaved edits, not a clean one", async () => {
    await mount();
    typeIntoActive(" edited");
    expect(persisted(B)?.dirty).toBe(true);

    // A clean tab loses nothing: it closes on the first click.
    click(closeButton(A));
    await flush();
    expect(tabRow(A)).toBeNull();
    expect(persisted(A)).toBeUndefined();

    click(closeButton(B));
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(persisted(B)?.content).toBe("beta edited");
    expect(armed(closeButton(B))).toBe(true);

    click(closeButton(B));
    await flush();
    expect(tabRow(B)).toBeNull();
    expect(persisted(B)).toBeUndefined();
  });

  it("ends the step on Escape, without closing the chat, and on blur", async () => {
    await mount();
    typeIntoActive(" edited");
    const seen: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => seen.push(e.key);
    // App closes the chat on an Escape that reaches its bubble listener.
    window.addEventListener("keydown", onWindowKey);
    try {
      // The enabling condition: an Escape on the close control reaches the
      // window while nothing is armed.
      act(() => {
        fireEvent.keyDown(closeButton(B), { key: "Escape" });
      });
      expect(seen).toEqual(["Escape"]);

      click(closeButton(B));
      expect(tabRow(B)).not.toBeNull();
      expect(armed(closeButton(B))).toBe(true);
      act(() => {
        fireEvent.keyDown(closeButton(B), { key: "Escape" });
      });
      expect(seen).toEqual(["Escape"]);
      expect(armed(closeButton(B))).toBe(false);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }

    // The next click arms again; it does not close.
    click(closeButton(B));
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(armed(closeButton(B))).toBe(true);

    act(() => {
      editorView().focus();
    });
    expect(armed(closeButton(B))).toBe(false);
    click(closeButton(B));
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(armed(closeButton(B))).toBe(true);
  });

  it("asks before it closes a clean tab whose file was deleted, from the tab and the banner", async () => {
    await mount();
    act(() => {
      shimEmit({ type: "editor_file_deleted", agentId, path: B });
    });
    await flush();
    expect(persisted(B)?.dirty).toBe(false);
    const close = bannerClose();
    if (!close) throw new Error("no Close in the deleted-file banner");

    click(closeButton(B));
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(armed(closeButton(B))).toBe(true);

    click(close);
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(armed(close)).toBe(true);
    // Armed, it no longer reads as Close tab.
    expect(bannerClose()).toBeNull();

    click(close);
    await flush();
    expect(tabRow(B)).toBeNull();
    expect(persisted(B)).toBeUndefined();
  });

  it("a banner Close armed for one file does not close another", async () => {
    const view = await mount();
    act(() => {
      shimEmit({ type: "editor_file_deleted", agentId, path: A });
      shimEmit({ type: "editor_file_deleted", agentId, path: B });
    });
    await flush();
    const close = bannerClose();
    if (!close) throw new Error("no Close in the deleted-file banner");
    click(close);
    expect(armed(close)).toBe(true);

    // The agent opens A (an edit request) while B's Close is armed: the
    // banner now stands for A, which has not been asked about.
    view.rerender(panel(A, false));
    await flush();
    expect(editorView().state.doc.toString()).toBe(CONTENT[A]!);
    // The banner keeps its button element across the switch.
    expect(close.isConnected).toBe(true);
    click(close);
    await flush();
    expect(tabRow(A)).not.toBeNull();
    expect(tabRow(B)).not.toBeNull();
  });
});

describe("editor tab close on a phone", () => {
  it("asks before it closes a tab with unsaved edits, not a clean one", async () => {
    await mount(true);
    typeIntoActive(" edited");
    expect(persisted(B)?.dirty).toBe(true);
    openPhoneList();

    click(closeButton(A));
    await flush();
    expect(persisted(A)).toBeUndefined();

    click(closeButton(B));
    await flush();
    expect(tabRow(B)).not.toBeNull();
    expect(armed(closeButton(B))).toBe(true);
    expect(persisted(B)?.content).toBe("beta edited");

    click(closeButton(B));
    await flush();
    expect(persisted(B)).toBeUndefined();
  });
});
