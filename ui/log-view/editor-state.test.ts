import { describe, expect, test } from "bun:test";
import {
  getEditorState,
  setEditorState,
  setEditorViewState,
} from "./editor-state.ts";

function tab(path: string) {
  return {
    path,
    content: "line one\nline two",
    mtime: 1,
    rev: 1,
    language: "text",
    size: 17,
    dirty: false,
  };
}

describe("editor state", () => {
  test("keeps view state when React refreshes an agent's tab snapshot", () => {
    const agentId = "agent-scroll-test";
    setEditorState(agentId, {
      tabs: [tab("notes.txt")],
      activePath: "notes.txt",
    });
    setEditorViewState(agentId, "notes.txt", 240, { anchor: 12, head: 8 });

    setEditorState(agentId, {
      tabs: [{ ...tab("notes.txt"), dirty: true }],
      activePath: "notes.txt",
    });

    expect(getEditorState(agentId)?.tabs[0]).toMatchObject({
      scrollTop: 240,
      selection: { anchor: 12, head: 8 },
    });
    setEditorState(agentId, null);
  });

  test("keeps view state separate for each agent", () => {
    const first = "agent-scroll-first";
    const second = "agent-scroll-second";
    setEditorState(first, { tabs: [tab("same.txt")], activePath: "same.txt" });
    setEditorState(second, { tabs: [tab("same.txt")], activePath: "same.txt" });
    setEditorViewState(first, "same.txt", 120, { anchor: 3, head: 3 });
    setEditorViewState(second, "same.txt", 480, { anchor: 9, head: 9 });

    expect(getEditorState(first)?.tabs[0]?.scrollTop).toBe(120);
    expect(getEditorState(second)?.tabs[0]?.scrollTop).toBe(480);
    setEditorState(first, null);
    setEditorState(second, null);
  });
});
