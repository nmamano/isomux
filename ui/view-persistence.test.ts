// Unit tests for refresh persistence (ui/view-persistence.ts). Everything
// read back from localStorage flows through the strict view parser and the
// owner-namespaced draft keys: malformed / hand-edited / stale / other-user
// values must degrade to "nothing saved" rather than throw or leak a bad
// shape (or another user's draft) into the store. Storage is injected as a
// minimal fake so mismatch and exception paths run without a DOM. The
// removed-room / removed-agent fallbacks live in App.tsx (saved ids are
// checked against the first full_state) and are covered by the headless
// browser walkthrough, not here.

import { describe, it, expect } from "bun:test";
import {
  parseSavedView,
  loadSavedView,
  saveView,
  loadUserDrafts,
  saveDraft,
  pruneUserDrafts,
  loadFoldedAsks,
  saveFoldedAsks,
  pruneUserFoldedAsks,
  saveDraftAttachments,
  loadUserDraftAttachments,
  pruneUserDraftAttachments,
  type StorageLike,
} from "./view-persistence.ts";
import type { Attachment } from "../shared/types.ts";
import type { DraftAttachment } from "./log-view/draft-attachments.ts";

function fakeStorage(init: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    keys: () => Object.keys(data),
  };
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
  keys: () => {
    throw new Error("SecurityError");
  },
};

describe("parseSavedView (strict)", () => {
  it("round-trips a full saved view", () => {
    const raw = JSON.stringify({
      user: "nil",
      roomId: "room-1",
      agentId: "agent-abc",
      panel: "tasks",
    });
    expect(parseSavedView(raw)).toEqual({
      user: "nil",
      roomId: "room-1",
      agentId: "agent-abc",
      panel: "tasks",
      lobby: false,
    });
  });

  it("accepts the office-view shape (null or missing ids mean null)", () => {
    expect(
      parseSavedView(
        JSON.stringify({
          user: "nil",
          roomId: null,
          agentId: null,
          panel: null,
        }),
      ),
    ).toEqual({
      user: "nil",
      roomId: null,
      agentId: null,
      panel: null,
      lobby: false,
    });
    // Missing fields are the same legitimate null (forward-compatible).
    expect(parseSavedView(JSON.stringify({ user: "nil" }))).toEqual({
      user: "nil",
      roomId: null,
      agentId: null,
      panel: null,
      lobby: false,
    });
  });

  it("returns null for absent / corrupted input", () => {
    expect(parseSavedView(null)).toBeNull();
    expect(parseSavedView("")).toBeNull();
    expect(parseSavedView("not json {")).toBeNull();
    expect(parseSavedView('"a string"')).toBeNull();
    expect(parseSavedView("[1,2]")).toBeNull();
    expect(parseSavedView("42")).toBeNull();
  });

  it("rejects a payload without an owner (incl. pre-ownership legacy shape)", () => {
    expect(
      parseSavedView(
        JSON.stringify({ roomId: "r", agentId: "a", panel: null }),
      ),
    ).toBeNull();
    expect(
      parseSavedView(JSON.stringify({ user: "", roomId: "r" })),
    ).toBeNull();
    expect(parseSavedView(JSON.stringify({ user: 7, roomId: "r" }))).toBeNull();
  });

  it("rejects wholesale on any wrong-typed or unknown-valued field", () => {
    expect(parseSavedView(JSON.stringify({ user: "u", roomId: 7 }))).toBeNull();
    expect(
      parseSavedView(JSON.stringify({ user: "u", agentId: {} })),
    ).toBeNull();
    expect(
      parseSavedView(JSON.stringify({ user: "u", roomId: "" })),
    ).toBeNull();
    expect(
      parseSavedView(JSON.stringify({ user: "u", panel: "bogus" })),
    ).toBeNull();
    expect(
      parseSavedView(JSON.stringify({ user: "u", panel: "TASKS" })),
    ).toBeNull();
  });

  it("accepts exactly the known panel values", () => {
    for (const panel of [
      "tasks",
      "cronjobs",
      "apps",
      "skills",
      "integrations",
      "settings",
      "users",
      "pager",
      "asks",
    ] as const) {
      expect(parseSavedView(JSON.stringify({ user: "u", panel }))?.panel).toBe(
        panel,
      );
    }
  });
});

describe("saved view: owner-checked load/save", () => {
  it("round-trips for the same user, case-insensitively", () => {
    const s = fakeStorage();
    saveView(
      "Nil",
      { roomId: "r1", agentId: "a1", panel: null, lobby: false },
      s,
    );
    expect(loadSavedView("nil", s)).toEqual({
      user: "nil",
      roomId: "r1",
      agentId: "a1",
      panel: null,
      lobby: false,
    });
    expect(loadSavedView("NIL", s)).not.toBeNull();
  });

  it("rejects another user's saved view", () => {
    const s = fakeStorage();
    saveView(
      "alice",
      { roomId: "r1", agentId: "a1", panel: "tasks", lobby: false },
      s,
    );
    expect(loadSavedView("bob", s)).toBeNull();
  });

  it("matches a mixed-case saved owner (both sides normalized)", () => {
    // save* always lowercases, but a hand-edited payload with a mixed-case
    // owner must still match its own user - and still not match others.
    const s = fakeStorage({
      "isomux-view": JSON.stringify({
        user: "Nil",
        roomId: "r1",
        agentId: null,
        panel: null,
      }),
    });
    expect(loadSavedView("nil", s)).not.toBeNull();
    expect(loadSavedView("bob", s)).toBeNull();
  });

  it("survives storage exceptions and unavailable storage", () => {
    expect(loadSavedView("nil", throwingStorage)).toBeNull();
    saveView(
      "nil",
      { roomId: null, agentId: null, panel: null, lobby: false },
      throwingStorage,
    );
    expect(loadSavedView("nil", null)).toBeNull();
    saveView(
      "nil",
      { roomId: null, agentId: null, panel: null, lobby: false },
      null,
    );
  });
});

describe("drafts: per-composer owner-namespaced keys", () => {
  it("round-trips per agent, case-insensitively on the user", () => {
    const s = fakeStorage();
    saveDraft("Nil", "agent-1", "typed text", s);
    saveDraft("nil", "agent-2", "other draft", s);
    expect(loadUserDrafts("NIL", s)).toEqual({
      "agent-1": "typed text",
      "agent-2": "other draft",
    });
  });

  it("empty text removes the composer's key (sent/cleared draft)", () => {
    const s = fakeStorage();
    saveDraft("nil", "agent-1", "typed text", s);
    saveDraft("nil", "agent-1", "", s);
    expect(loadUserDrafts("nil", s)).toEqual({});
    expect(Object.keys(s.data)).toEqual([]);
  });

  it("two users' drafts for the SAME agent don't collide", () => {
    const s = fakeStorage();
    saveDraft("alice", "agent-1", "alice text", s);
    saveDraft("bob", "agent-1", "bob text", s);
    expect(loadUserDrafts("alice", s)).toEqual({ "agent-1": "alice text" });
    expect(loadUserDrafts("bob", s)).toEqual({ "agent-1": "bob text" });
  });

  it("usernames with delimiter-ish characters can't cross namespaces", () => {
    const s = fakeStorage();
    // "a:b" must not read/write into user "a"'s namespace even though the
    // key layout is ":"-delimited (the username is URI-encoded).
    saveDraft("a:b", "agent-1", "weird user draft", s);
    saveDraft("a", "b:agent-1", "plain user draft", s);
    expect(loadUserDrafts("a:b", s)).toEqual({ "agent-1": "weird user draft" });
    expect(loadUserDrafts("a", s)).toEqual({ "b:agent-1": "plain user draft" });
  });

  it("prunes only the caller's own dead-agent keys", () => {
    const s = fakeStorage();
    saveDraft("nil", "agent-live", "keep me", s);
    saveDraft("nil", "agent-dead", "drop me", s);
    saveDraft("alice", "agent-dead", "not mine to judge", s);
    pruneUserDrafts("nil", new Set(["agent-live"]), s);
    expect(loadUserDrafts("nil", s)).toEqual({ "agent-live": "keep me" });
    expect(loadUserDrafts("alice", s)).toEqual({
      "agent-dead": "not mine to judge",
    });
  });

  it("ignores foreign keys sharing the storage", () => {
    const s = fakeStorage({
      "isomux-theme": "nord",
      "isomux-view": "{}",
      unrelated: "x",
    });
    saveDraft("nil", "agent-1", "text", s);
    expect(loadUserDrafts("nil", s)).toEqual({ "agent-1": "text" });
    pruneUserDrafts("nil", new Set(), s);
    expect(s.data["isomux-theme"]).toBe("nord");
    expect(s.data["unrelated"]).toBe("x");
  });

  it("survives storage exceptions and unavailable storage", () => {
    expect(loadUserDrafts("nil", throwingStorage)).toEqual({});
    saveDraft("nil", "a", "b", throwingStorage);
    saveDraft("nil", "a", "", throwingStorage);
    pruneUserDrafts("nil", new Set(), throwingStorage);
    expect(loadUserDrafts("nil", null)).toEqual({});
    saveDraft("nil", "a", "b", null);
    pruneUserDrafts("nil", new Set(), null);
  });
});

// The settings page was called "users" before it grew the office, room and
// device rows. Renaming the saved panel value is the one migration in this
// task that can silently cost a reader more than it fixes: the parser rejects
// a WHOLE payload on an unknown panel value (pinned in "rejects wholesale"
// above), so a value the running build does not recognise takes roomId and
// agentId down with the panel.
describe("saved view: the settings panel rename", () => {
  const owner = "morgan";

  it("still parses a payload written under the old 'users' name", () => {
    // An older build's saved spot, read by this one. The room and the agent
    // must survive, not only the panel.
    const raw = JSON.stringify({
      user: owner,
      roomId: "room-1",
      agentId: "agent-1",
      panel: "users",
    });
    expect(parseSavedView(raw)).toEqual({
      user: owner,
      roomId: "room-1",
      agentId: "agent-1",
      panel: "users",
      lobby: false,
    });
  });

  it("ignores an unknown extra field instead of rejecting the payload", () => {
    // A NEWER build may write a section alongside the panel. This build has to
    // read such a payload without losing the room and the agent with it.
    const raw = JSON.stringify({
      user: owner,
      roomId: "room-1",
      agentId: "agent-1",
      panel: "settings",
      section: "theme",
    });
    const parsed = parseSavedView(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.roomId).toBe("room-1");
    expect(parsed?.agentId).toBe("agent-1");
  });
});

describe("saved view: the lobby flag", () => {
  it("round-trips, reads absent as false, and rejects a non-boolean", () => {
    const storage = fakeStorage();
    saveView(
      "nil",
      { roomId: "r1", agentId: null, panel: null, lobby: true },
      storage,
    );
    expect(loadSavedView("nil", storage)?.lobby).toBe(true);
    expect(
      parseSavedView(
        JSON.stringify({
          user: "nil",
          roomId: null,
          agentId: null,
          panel: null,
        }),
      )?.lobby,
    ).toBe(false);
    expect(
      parseSavedView(
        JSON.stringify({
          user: "nil",
          roomId: null,
          agentId: null,
          panel: null,
          lobby: "yes",
        }),
      ),
    ).toBeNull();
  });
});

// The chat's ask stack remembers a fold per member and agent (task 107e0eee):
// the ask ids that were open when the member folded it.
describe("folded asks: per member and agent", () => {
  it("round-trips per agent, case-insensitively on the user, and null removes the key", () => {
    const s = fakeStorage();
    saveFoldedAsks("Nil", "agent-1", ["ask-a", "ask-b"], s);
    saveFoldedAsks("nil", "agent-2", ["ask-c"], s);
    expect(loadFoldedAsks("NIL", "agent-1", s)).toEqual(["ask-a", "ask-b"]);
    expect(loadFoldedAsks("nil", "agent-2", s)).toEqual(["ask-c"]);
    expect(loadFoldedAsks("nil", "agent-3", s)).toBe(null);
    saveFoldedAsks("nil", "agent-1", null, s);
    saveFoldedAsks("nil", "agent-2", null, s);
    expect(loadFoldedAsks("nil", "agent-1", s)).toBe(null);
    expect(Object.keys(s.data)).toEqual([]);
  });

  it("keeps two users apart, also when a delimiter is in a name", () => {
    const s = fakeStorage();
    saveFoldedAsks("alice", "agent-1", ["ask-a"], s);
    saveFoldedAsks("a:b", "agent-1", ["ask-b"], s);
    saveFoldedAsks("a", "b:agent-1", ["ask-c"], s);
    expect(loadFoldedAsks("bob", "agent-1", s)).toBe(null);
    expect(loadFoldedAsks("alice", "agent-1", s)).toEqual(["ask-a"]);
    expect(loadFoldedAsks("a:b", "agent-1", s)).toEqual(["ask-b"]);
    expect(loadFoldedAsks("a", "b:agent-1", s)).toEqual(["ask-c"]);
  });

  it("reads a payload that is not an array of strings as no fold", () => {
    for (const raw of [
      "not json",
      "null",
      "{}",
      '"ask-a"',
      "[1]",
      '["ask-a", 2]',
    ]) {
      const s = fakeStorage();
      saveFoldedAsks("nil", "agent-1", ["ask-a"], s);
      const keys = Object.keys(s.data);
      expect(keys.length).toBe(1);
      s.data[keys[0]] = raw;
      expect(loadFoldedAsks("nil", "agent-1", s)).toBe(null);
    }
  });

  it("prunes only the caller's folds for agents that are gone", () => {
    const s = fakeStorage({ "isomux-theme": "nord" });
    saveFoldedAsks("nil", "agent-live", ["ask-a"], s);
    saveFoldedAsks("nil", "agent-dead", ["ask-b"], s);
    saveFoldedAsks("alice", "agent-dead", ["ask-c"], s);
    saveDraft("nil", "agent-dead", "a draft", s);
    pruneUserFoldedAsks("nil", new Set(["agent-live"]), s);
    expect(loadFoldedAsks("nil", "agent-live", s)).toEqual(["ask-a"]);
    expect(loadFoldedAsks("nil", "agent-dead", s)).toBe(null);
    expect(loadFoldedAsks("alice", "agent-dead", s)).toEqual(["ask-c"]);
    // The drafts' prune and the folds' prune do not reach each other's keys.
    expect(loadUserDrafts("nil", s)).toEqual({ "agent-dead": "a draft" });
    pruneUserDrafts("nil", new Set(), s);
    expect(loadFoldedAsks("nil", "agent-live", s)).toEqual(["ask-a"]);
    expect(s.data["isomux-theme"]).toBe("nord");
  });

  it("survives storage exceptions and unavailable storage", () => {
    expect(loadFoldedAsks("nil", "a", throwingStorage)).toBe(null);
    saveFoldedAsks("nil", "a", ["x"], throwingStorage);
    saveFoldedAsks("nil", "a", null, throwingStorage);
    pruneUserFoldedAsks("nil", new Set(), throwingStorage);
    expect(loadFoldedAsks("nil", "a", null)).toBe(null);
    saveFoldedAsks("nil", "a", ["x"], null);
    pruneUserFoldedAsks("nil", new Set(), null);
  });
});

// The attachments of a draft survive a reload as the text does, one key per
// composer (task bd4caaa2). Only references are kept: an item still
// uploading or failed has nothing the server could find.
describe("draft attachments: per-composer owner-namespaced keys", () => {
  const uploaded = (name: string): DraftAttachment => ({
    id: `id-${name}`,
    filename: `stored-${name}`,
    originalName: name,
    mediaType: "image/png",
    size: 42,
    uploading: false,
  });
  const reference = (name: string): Attachment => ({
    filename: `stored-${name}`,
    originalName: name,
    mediaType: "image/png",
    size: 42,
  });
  const inFlight: DraftAttachment = {
    id: "id-busy",
    filename: "",
    originalName: "busy.png",
    mediaType: "image/png",
    size: 42,
    uploading: true,
  };
  const failed: DraftAttachment = {
    ...uploaded("bad.png"),
    error: { kind: "status", status: 500 },
  };

  it("round-trips the uploaded references per agent, case-insensitively on the user", () => {
    const s = fakeStorage();
    saveDraftAttachments("Nil", "agent-1", [uploaded("a.png")], s);
    saveDraftAttachments(
      "nil",
      "agent-2",
      [uploaded("b.png"), uploaded("c.png")],
      s,
    );
    expect(loadUserDraftAttachments("NIL", s)).toEqual({
      "agent-1": [reference("a.png")],
      "agent-2": [reference("b.png"), reference("c.png")],
    });
  });

  it("keeps neither in-flight nor failed items, and a draft with none left removes its key", () => {
    const s = fakeStorage();
    saveDraftAttachments(
      "nil",
      "agent-1",
      [inFlight, uploaded("a.png"), failed],
      s,
    );
    expect(loadUserDraftAttachments("nil", s)).toEqual({
      "agent-1": [reference("a.png")],
    });
    expect(Object.keys(s.data)).toHaveLength(1);
    saveDraftAttachments("nil", "agent-1", [inFlight, failed], s);
    expect(Object.keys(s.data)).toEqual([]);
    saveDraftAttachments("nil", "agent-1", [uploaded("a.png")], s);
    saveDraftAttachments("nil", "agent-1", [], s);
    expect(Object.keys(s.data)).toEqual([]);
  });

  it("keeps two users' attachments for the same agent apart, and apart from the draft text", () => {
    const s = fakeStorage();
    saveDraftAttachments("alice", "agent-1", [uploaded("a.png")], s);
    saveDraftAttachments("bob", "agent-1", [uploaded("b.png")], s);
    saveDraft("alice", "agent-1", "alice text", s);
    expect(loadUserDraftAttachments("alice", s)).toEqual({
      "agent-1": [reference("a.png")],
    });
    expect(loadUserDraftAttachments("bob", s)).toEqual({
      "agent-1": [reference("b.png")],
    });
    expect(loadUserDrafts("alice", s)).toEqual({ "agent-1": "alice text" });
    // Sending the text removes only the text's key.
    saveDraft("alice", "agent-1", "", s);
    expect(loadUserDraftAttachments("alice", s)).toEqual({
      "agent-1": [reference("a.png")],
    });
  });

  it("skips a key whose value is not a list of attachments, and keeps the good ones", () => {
    const s = fakeStorage();
    saveDraftAttachments("nil", "agent-good", [uploaded("a.png")], s);
    const goodKey = Object.keys(s.data)[0];
    const keyFor = (agentId: string) =>
      goodKey.slice(0, goodKey.length - "agent-good".length) + agentId;
    s.data[keyFor("agent-json")] = "{not json";
    s.data[keyFor("agent-object")] = JSON.stringify(reference("a.png"));
    s.data[keyFor("agent-item")] = JSON.stringify([
      reference("a.png"),
      { originalName: "no-filename.png", mediaType: "image/png", size: 1 },
    ]);
    s.data[keyFor("agent-size")] = JSON.stringify([
      { ...reference("a.png"), size: "42" },
    ]);
    expect(loadUserDraftAttachments("nil", s)).toEqual({
      "agent-good": [reference("a.png")],
    });
  });

  it("prunes only the caller's own dead-agent keys", () => {
    const s = fakeStorage({ "isomux-theme": "nord" });
    saveDraftAttachments("nil", "agent-live", [uploaded("a.png")], s);
    saveDraftAttachments("nil", "agent-dead", [uploaded("b.png")], s);
    saveDraftAttachments("alice", "agent-dead", [uploaded("c.png")], s);
    saveDraft("nil", "agent-dead", "text", s);
    pruneUserDraftAttachments("nil", new Set(["agent-live"]), s);
    expect(loadUserDraftAttachments("nil", s)).toEqual({
      "agent-live": [reference("a.png")],
    });
    expect(loadUserDraftAttachments("alice", s)).toEqual({
      "agent-dead": [reference("c.png")],
    });
    expect(loadUserDrafts("nil", s)).toEqual({ "agent-dead": "text" });
    expect(s.data["isomux-theme"]).toBe("nord");
  });

  it("survives storage exceptions and unavailable storage", () => {
    expect(loadUserDraftAttachments("nil", throwingStorage)).toEqual({});
    saveDraftAttachments("nil", "a", [uploaded("a.png")], throwingStorage);
    saveDraftAttachments("nil", "a", [], throwingStorage);
    pruneUserDraftAttachments("nil", new Set(), throwingStorage);
    expect(loadUserDraftAttachments("nil", null)).toEqual({});
    saveDraftAttachments("nil", "a", [uploaded("a.png")], null);
  });
});
