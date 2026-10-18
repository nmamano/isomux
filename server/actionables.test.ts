// The actionable store's load posture and the note the agent reads.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ACTIONABLE_PROMPT_EXCERPT,
  actionableReplyNote,
  createActionableFilePersistence,
  createActionableStore,
  ActionablesUnavailableError,
  type ActionablePersistence,
} from "./actionables.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fileIn(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "isomux-actionables-"));
  dirs.push(dir);
  return { dir, path: join(dir, "actionables.json") };
}

describe("loading", () => {
  it("starts empty with no file, and the next store reads what the first wrote", () => {
    const { path } = fileIn();
    const first = createActionableStore({
      persistence: createActionableFilePersistence(path),
    });
    expect(first.listForMember("u1")).toEqual([]);
    const made = first.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
    });
    if (!made.ok) throw new Error("create failed");
    const second = createActionableStore({
      persistence: createActionableFilePersistence(path),
    });
    expect(second.get(made.entry.id)).toEqual(made.entry);
  });

  it("moves a corrupt file aside and starts empty", () => {
    const { dir, path } = fileIn();
    writeFileSync(path, "{not json");
    const store = createActionableStore({
      persistence: createActionableFilePersistence(path),
    });
    expect(store.listForAgent("a1")).toEqual([]);
    expect(
      readdirSync(dir).some((f) => f.startsWith("actionables.json.corrupt-")),
    ).toBe(true);
  });

  it("refuses every operation when the file cannot be read", () => {
    const persistence: ActionablePersistence = {
      load: () => ({ kind: "unreadable" }),
      save: () => {},
      quarantine: () => true,
    };
    const store = createActionableStore({ persistence });
    expect(() => store.listForMember("u1")).toThrow(
      ActionablesUnavailableError,
    );
  });

  it("leaves memory unchanged when a write fails", () => {
    let fail = false;
    const persistence: ActionablePersistence = {
      load: () => ({ kind: "missing" }),
      save: () => {
        if (fail) throw new Error("disk full");
      },
      quarantine: () => true,
    };
    const store = createActionableStore({ persistence });
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
    });
    if (!made.ok) throw new Error("create failed");
    fail = true;
    expect(() => store.remove(made.entry.id)).toThrow();
    expect(store.get(made.entry.id)).toEqual(made.entry);
  });
});

describe("the note before the member's words", () => {
  it("names the actionable, cuts a long prompt and tells a dismiss from a reply", () => {
    const long = "word ".repeat(100);
    const note = actionableReplyNote({ id: "abcd1234", prompt: long });
    expect(note).toContain("abcd1234");
    const quoted = JSON.parse(
      note.slice(note.indexOf('"'), note.lastIndexOf('"') + 1),
    );
    expect(quoted.length).toBe(ACTIONABLE_PROMPT_EXCERPT);
    expect(
      actionableReplyNote({ id: "abcd1234", prompt: "x", dismissed: true }),
    ).not.toBe(actionableReplyNote({ id: "abcd1234", prompt: "x" }));
  });
});
