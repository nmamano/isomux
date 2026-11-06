// Editor saves and typing (task b49c07fe, internal-docs/implicit-state-machines.md
// entry 7). A save marks the tab clean only when the buffer still holds what
// it sent, so text typed while the PUT is out stays dirty and a later re-open
// keeps it. Saves on one file run one at a time: a second save waits for the
// first and is based on the revision the first returned, and when the first
// fails only a forced save (Save to recreate, Overwrite) still goes out.
//
// The fake server below holds every PUT until the test lands or fails it, and
// checks expectedRev the way the real route does.

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
const { setApiShim, ApiError } = await import("../api.ts");
const { shimEmit } = await import("../ws.ts");

type SessionContext = import("../../shared/types.ts").SessionContext;

const FILE = "/work/notes.txt";

interface PutBody {
  path: string;
  content: string;
  expectedMtime: number;
  expectedRev: number;
  force: boolean;
}
interface HeldPut {
  body: PutBody;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

let disk = { content: "base", rev: 1, mtime: 100 };
let puts: HeldPut[] = [];
let gets = 0;
let agentSeq = 0;
let agentId = "";

setApiShim(async (method, path, body) => {
  if (method === "GET" && path.startsWith(`/api/agents/${agentId}/file?`)) {
    gets += 1;
    return {
      path: FILE,
      content: disk.content,
      mtime: disk.mtime,
      language: "text",
      size: disk.content.length,
      rev: disk.rev,
    };
  }
  if (method === "DELETE") return undefined;
  if (method === "PUT" && path === `/api/agents/${agentId}/file`) {
    return new Promise((resolve, reject) =>
      puts.push({ body: body as PutBody, resolve, reject }),
    );
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

function session(connectionId: string): SessionContext {
  return {
    userId: "u1",
    username: "Tester",
    role: "owner",
    currentSessionPrefix: "00000000",
    connectionId,
  };
}

function panel(connectionId = "c1") {
  return onLanguage(
    null,
    createElement(EditorPanel, {
      agentId,
      initialPath: FILE,
      onClose: () => {},
    }),
    { sessionContext: session(connectionId) },
  );
}

async function mount() {
  agentSeq += 1;
  agentId = `agent-save-${agentSeq}`;
  disk = { content: "base", rev: 1, mtime: 100 };
  puts = [];
  const view = render(panel());
  await flush();
  const dom = view.container.querySelector(".cm-editor");
  if (!(dom instanceof HTMLElement)) throw new Error("no editor mounted");
  const editor = EditorView.findFromDOM(dom);
  if (!editor) throw new Error("no EditorView on the editor element");
  // The enabling condition: the file opened and its text is in the editor.
  expect(editor.state.doc.toString()).toBe("base");
  return { view, editor };
}

function type(editor: InstanceType<typeof EditorView>, text: string) {
  act(() => {
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: text },
      userEvent: "input.type",
    });
  });
}

function ctrlS(editor: InstanceType<typeof EditorView>) {
  act(() => {
    editor.focus();
    fireEvent.keyDown(editor.contentDOM, { key: "s", ctrlKey: true });
  });
}

// The real route: a save that is not forced must be based on the current rev.
async function land(put: HeldPut | undefined) {
  if (!put) throw new Error("no PUT to land");
  if (!put.body.force && put.body.expectedRev !== disk.rev) {
    put.reject(
      new ApiError(409, "stale", "stale", { currentMtime: disk.mtime }),
    );
  } else {
    disk = {
      content: put.body.content,
      rev: disk.rev + 1,
      mtime: disk.mtime + 1,
    };
    put.resolve({ ok: true, mtime: disk.mtime, rev: disk.rev });
  }
  await flush();
}

async function fail(put: HeldPut | undefined, code: "stale" | "deleted") {
  if (!put) throw new Error("no PUT to fail");
  put.reject(new ApiError(409, code, code, { currentMtime: disk.mtime + 50 }));
  await flush();
}

const persisted = () =>
  getEditorState(agentId)?.tabs.find((t) => t.path === FILE);

const button = (
  key: "panels.editor.overwrite" | "panels.editor.saveToRecreate",
) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === translationsFor(key).en,
  ) ?? null;

describe("editor save while typing", () => {
  it("keeps text typed during a save dirty, and a re-open keeps it", async () => {
    const { view, editor } = await mount();
    type(editor, " A");
    ctrlS(editor);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.content).toBe("base A");

    type(editor, " B");
    await land(puts[0]);
    expect(disk.content).toBe("base A");
    expect(persisted()?.dirty).toBe(true);
    expect(persisted()?.rev).toBe(disk.rev);

    // A reconnect re-opens every tab to re-arm its watch. A clean tab takes
    // the disk text; the dirty one must keep what the member typed.
    const getsBefore = gets;
    view.rerender(panel("c2"));
    await flush();
    expect(gets).toBe(getsBefore + 1);
    expect(editor.state.doc.toString()).toBe("base A B");
    expect(persisted()?.dirty).toBe(true);
  });

  it("marks the tab clean when nothing was typed during the save", async () => {
    const { editor } = await mount();
    type(editor, " A");
    ctrlS(editor);
    expect(puts).toHaveLength(1);
    expect(persisted()?.dirty).toBe(true);

    await land(puts[0]);
    expect(persisted()?.dirty).toBe(false);
    expect(persisted()?.rev).toBe(disk.rev);
  });
});

describe("editor saves on one file run one at a time", () => {
  it("sends a second save only after the first lands, on the first's rev", async () => {
    const { editor } = await mount();
    type(editor, " A");
    ctrlS(editor);
    type(editor, " B");
    ctrlS(editor);
    await flush();
    expect(puts).toHaveLength(1);

    await land(puts[0]);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body.content).toBe("base A B");
    expect(puts[1]!.body.expectedRev).toBe(disk.rev);

    await land(puts[1]);
    expect(disk.content).toBe("base A B");
    expect(persisted()?.dirty).toBe(false);
    expect(button("panels.editor.overwrite")).toBeNull();
  });

  it("drops a queued save when the save ahead of it fails", async () => {
    const { editor } = await mount();
    type(editor, " A");
    ctrlS(editor);
    type(editor, " B");
    ctrlS(editor);
    await flush();
    expect(puts).toHaveLength(1);

    await fail(puts[0], "stale");
    // The stale banner is up for the member to answer; nothing more was sent.
    expect(button("panels.editor.overwrite")).not.toBeNull();
    expect(puts).toHaveLength(1);
    expect(persisted()?.dirty).toBe(true);
  });

  it("still sends a queued Save to recreate when the save ahead fails", async () => {
    const { editor } = await mount();
    type(editor, " A");
    ctrlS(editor);
    expect(puts).toHaveLength(1);

    // The file goes away while the save is out; the member answers the
    // banner with Save to recreate, which waits for the save ahead.
    act(() => {
      shimEmit({ type: "editor_file_deleted", agentId, path: FILE });
    });
    const recreate = button("panels.editor.saveToRecreate");
    expect(recreate).not.toBeNull();
    act(() => {
      fireEvent.click(recreate!);
    });
    await flush();
    expect(puts).toHaveLength(1);

    await fail(puts[0], "deleted");
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body.force).toBe(true);
    expect(puts[1]!.body.content).toBe("base A");
  });
});
