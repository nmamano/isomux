// The members chat store against a temp directory: month files, folding,
// paging across a month boundary, edits and deletes landing in the target's
// month, the read pointer, and the attachment guards. Pure T1: real temp FS,
// no server, no LLM.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createMembersChatStore,
  monthKey,
  monthOfId,
  MembersChatError,
  MEMBERS_CHAT_MAX_CHARS,
  MEMBERS_CHAT_UNREAD_CAP,
  type MembersChatStore,
} from "./members-chat.ts";

const AUG = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08
const SEP = Date.UTC(2026, 8, 5, 9, 0, 0); // 2026-09

let dir: string;
let clock = AUG;
let store: MembersChatStore;

const nil = { userId: "u-nil", userName: "Nil" };
const pau = { userId: "u-pau", userName: "Pau", device: "Phone" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "members-chat-"));
  clock = AUG;
  store = createMembersChatStore(dir, { now: () => clock });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function postN(n: number, author = nil): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(store.post({ ...author, content: `m${ids.length}` }).id);
    clock += 1000;
  }
  return ids;
}

describe("ids and months", () => {
  it("names the month in UTC and reads it back from the id", () => {
    expect(monthKey(AUG)).toBe("2026-08");
    const m = store.post({ ...nil, content: "hi" });
    expect(m.id).toMatch(/^202608-[0-9a-f]{8}$/);
    expect(monthOfId(m.id)).toBe("2026-08");
    expect(monthOfId("garbage")).toBeNull();
    expect(monthOfId("202608-xyz")).toBeNull();
  });

  it("writes one file per month and nothing else in the stream dir", () => {
    postN(2);
    clock = SEP;
    postN(1);
    expect(readdirSync(dir).sort()).toEqual(["2026-08.jsonl", "2026-09.jsonl"]);
  });
});

describe("post and fold", () => {
  it("keeps the author snapshot, device, time and attachments", () => {
    const att = {
      filename: "a.png",
      originalName: "a.png",
      mediaType: "image/png",
      size: 3,
    };
    const m = store.post({ ...pau, content: "look", attachments: [att] });
    expect(m).toEqual({
      id: m.id,
      kind: "user",
      userId: "u-pau",
      userName: "Pau",
      device: "Phone",
      timestamp: AUG,
      content: "look",
      attachments: [att],
    });
    // A fresh store folds the same message back from disk.
    const again = createMembersChatStore(dir);
    expect(again.get(m.id)).toEqual(m);
  });

  it("rejects empty text without a file, and text over the cap", () => {
    expect(() => store.post({ ...nil, content: "   " })).toThrow(
      MembersChatError,
    );
    try {
      store.post({ ...nil, content: "x".repeat(MEMBERS_CHAT_MAX_CHARS + 1) });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as MembersChatError).code).toBe("too_long");
    }
    expect(
      store.post({ ...nil, content: "x".repeat(MEMBERS_CHAT_MAX_CHARS) })
        .content.length,
    ).toBe(MEMBERS_CHAT_MAX_CHARS);
    // A file alone is a message.
    const only = store.post({
      ...nil,
      content: "",
      attachments: [
        { filename: "f", originalName: "f", mediaType: "text/plain", size: 1 },
      ],
    });
    expect(only.content).toBe("");
  });

  it("skips a torn last line instead of losing the month", () => {
    const [a] = postN(1);
    const file = join(dir, "2026-08.jsonl");
    // Simulate a process dying mid-append.
    appendFileSync(file, '{"op":"post","id":"2026');
    const fresh = createMembersChatStore(dir);
    expect(fresh.get(a)).not.toBeNull();
    expect(fresh.page().messages.map((m) => m.id)).toEqual([a]);
  });
});

describe("edit and delete", () => {
  it("edits in place and marks editedAt", () => {
    const m = store.post({ ...nil, content: "draft" });
    clock += 5000;
    const edited = store.edit(m.id, "final");
    expect(edited?.content).toBe("final");
    expect(edited?.editedAt).toBe(AUG + 5000);
    expect(edited?.timestamp).toBe(AUG);
    // Editing to nothing is refused like posting nothing.
    expect(() => store.edit(m.id, "   ")).toThrow(MembersChatError);
    expect(store.get(m.id)?.content).toBe("final");
  });

  it("appends the edit and the delete to the month that holds the target", () => {
    const [old] = postN(1);
    clock = SEP;
    postN(1);
    store.edit(old, "changed later");
    const before = store.delete(old);
    expect(before?.content).toBe("changed later");
    const aug = readFileSync(join(dir, "2026-08.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).op);
    expect(aug).toEqual(["post", "edit", "delete"]);
    const sep = readFileSync(join(dir, "2026-09.jsonl"), "utf-8")
      .trim()
      .split("\n").length;
    expect(sep).toBe(1);
    expect(store.get(old)).toBeNull();
    // Second delete and edit-after-delete are no-ops.
    expect(store.delete(old)).toBeNull();
    expect(store.edit(old, "zombie")).toBeNull();
  });

  it("refuses a malformed id without touching the disk", () => {
    postN(1);
    const filesBefore = readdirSync(dir);
    expect(store.edit("nope", "x")).toBeNull();
    expect(store.delete("../2026-08")).toBeNull();
    expect(store.get("202608-zzzzzzzz")).toBeNull();
    expect(readdirSync(dir)).toEqual(filesBefore);
  });

  it("an edit over the cap throws and leaves the message alone", () => {
    const m = store.post({ ...nil, content: "ok" });
    expect(() =>
      store.edit(m.id, "x".repeat(MEMBERS_CHAT_MAX_CHARS + 1)),
    ).toThrow(MembersChatError);
    expect(store.get(m.id)?.content).toBe("ok");
  });
});

describe("paging", () => {
  it("returns the newest page chronologically and pages older on a cursor", () => {
    const ids = postN(7);
    const p1 = store.page({ limit: 3 });
    expect(p1.messages.map((m) => m.id)).toEqual(ids.slice(4));
    expect(p1.hasMore).toBe(true);
    const p2 = store.page({ limit: 3, before: p1.messages[0].id });
    expect(p2.messages.map((m) => m.id)).toEqual(ids.slice(1, 4));
    expect(p2.hasMore).toBe(true);
    const p3 = store.page({ limit: 3, before: p2.messages[0].id });
    expect(p3.messages.map((m) => m.id)).toEqual(ids.slice(0, 1));
    expect(p3.hasMore).toBe(false);
  });

  it("crosses a month boundary inside one page", () => {
    const aug = postN(2);
    clock = SEP;
    const sep = postN(2);
    const p = store.page({ limit: 3 });
    expect(p.messages.map((m) => m.id)).toEqual([aug[1], ...sep]);
    expect(p.hasMore).toBe(true);
    const rest = store.page({ limit: 3, before: aug[1] });
    expect(rest.messages.map((m) => m.id)).toEqual([aug[0]]);
    expect(rest.hasMore).toBe(false);
  });

  it("hasMore is false when the page ends exactly on the oldest message", () => {
    const ids = postN(3);
    const p = store.page({ limit: 3 });
    expect(p.messages.map((m) => m.id)).toEqual(ids);
    expect(p.hasMore).toBe(false);
  });

  it("skips deleted messages and still resolves a deleted cursor", () => {
    const ids = postN(5);
    store.delete(ids[2]);
    const p1 = store.page({ limit: 2 });
    expect(p1.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
    store.delete(ids[3]);
    const p2 = store.page({ limit: 2, before: ids[3] });
    expect(p2.messages.map((m) => m.id)).toEqual([ids[0], ids[1]]);
    expect(p2.hasMore).toBe(false);
  });

  it("an unknown cursor pages from the top, and an empty store pages empty", () => {
    expect(store.page()).toEqual({ messages: [], hasMore: false });
    const ids = postN(2);
    const p = store.page({ before: "202601-00000000" });
    expect(p.messages.map((m) => m.id)).toEqual(ids);
  });

  it("clamps the limit", () => {
    const ids = postN(3);
    expect(store.page({ limit: 0 }).messages).toHaveLength(1);
    expect(store.page({ limit: 10_000 }).messages.map((m) => m.id)).toEqual(
      ids,
    );
  });
});

describe("read pointer and unread count", () => {
  it("counts everything with no pointer, then only what is newer", () => {
    const ids = postN(4);
    expect(store.getReadPointer("u-pau")).toBeNull();
    expect(store.unreadCount("u-pau")).toBe(4);
    expect(store.setReadPointer("u-pau", ids[1])).toBe(ids[1]);
    expect(store.unreadCount("u-pau")).toBe(2);
    expect(store.setReadPointer("u-pau", ids[3])).toBe(ids[3]);
    expect(store.unreadCount("u-pau")).toBe(0);
    postN(1);
    expect(store.unreadCount("u-pau")).toBe(1);
  });

  it("never moves the pointer backward and ignores an unknown id", () => {
    const ids = postN(3);
    store.setReadPointer("u-pau", ids[2]);
    expect(store.setReadPointer("u-pau", ids[0])).toBe(ids[2]);
    expect(store.setReadPointer("u-pau", "202608-ffffffff")).toBe(ids[2]);
    expect(store.getReadPointer("u-pau")).toBe(ids[2]);
    // Persisted: a fresh store reads the same pointer.
    expect(createMembersChatStore(dir).getReadPointer("u-pau")).toBe(ids[2]);
  });

  it("counts across months, ignores deleted messages, and caps", () => {
    const aug = postN(2);
    clock = SEP;
    postN(3);
    store.setReadPointer("u-pau", aug[0]);
    expect(store.unreadCount("u-pau")).toBe(4);
    store.delete(aug[1]);
    expect(store.unreadCount("u-pau")).toBe(3);
    postN(MEMBERS_CHAT_UNREAD_CAP + 5);
    expect(store.unreadCount("u-pau")).toBe(MEMBERS_CHAT_UNREAD_CAP);
  });

  it("a deleted pointer target still anchors the count", () => {
    const ids = postN(3);
    store.setReadPointer("u-pau", ids[1]);
    store.delete(ids[1]);
    expect(store.unreadCount("u-pau")).toBe(1);
  });
});

describe("attachments", () => {
  it("saves under files/, dedupes identical uploads, suffixes different ones", () => {
    const a = store.saveAttachment(Buffer.from("one"), "text/plain", "n.txt");
    const same = store.saveAttachment(
      Buffer.from("one"),
      "text/plain",
      "n.txt",
    );
    const other = store.saveAttachment(
      Buffer.from("two"),
      "text/plain",
      "../n.txt",
    );
    expect(a?.filename).toBe("n.txt");
    expect(same?.filename).toBe("n.txt");
    expect(other?.filename).toBe("n_2.txt");
    expect(readdirSync(join(dir, "files")).sort()).toEqual([
      "n.txt",
      "n_2.txt",
    ]);
    expect(store.attachmentPath("n.txt")).toBe(join(dir, "files", "n.txt"));
  });

  it("refuses traversal and unknown names", () => {
    store.saveAttachment(Buffer.from("x"), "text/plain", "x.txt");
    expect(store.attachmentPath("../reads.json")).toBeNull();
    expect(store.attachmentPath("..")).toBeNull();
    expect(store.attachmentPath("missing.txt")).toBeNull();
  });
});
