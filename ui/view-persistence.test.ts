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
  type StorageLike,
} from "./view-persistence.ts";

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
    ).toEqual({ user: "nil", roomId: null, agentId: null, panel: null });
    // Missing fields are the same legitimate null (forward-compatible).
    expect(parseSavedView(JSON.stringify({ user: "nil" }))).toEqual({
      user: "nil",
      roomId: null,
      agentId: null,
      panel: null,
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
    for (const panel of ["tasks", "cronjobs", "users"] as const) {
      expect(parseSavedView(JSON.stringify({ user: "u", panel }))?.panel).toBe(
        panel,
      );
    }
  });
});

describe("saved view: owner-checked load/save", () => {
  it("round-trips for the same user, case-insensitively", () => {
    const s = fakeStorage();
    saveView("Nil", { roomId: "r1", agentId: "a1", panel: null }, s);
    expect(loadSavedView("nil", s)).toEqual({
      user: "nil",
      roomId: "r1",
      agentId: "a1",
      panel: null,
    });
    expect(loadSavedView("NIL", s)).not.toBeNull();
  });

  it("rejects another user's saved view", () => {
    const s = fakeStorage();
    saveView("alice", { roomId: "r1", agentId: "a1", panel: "tasks" }, s);
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
    expect(() =>
      saveView(
        "nil",
        { roomId: null, agentId: null, panel: null },
        throwingStorage,
      ),
    ).not.toThrow();
    expect(loadSavedView("nil", null)).toBeNull();
    expect(() =>
      saveView("nil", { roomId: null, agentId: null, panel: null }, null),
    ).not.toThrow();
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

  it("refuses to hand user A's drafts to user B", () => {
    const s = fakeStorage();
    saveDraft("alice", "agent-1", "alice's secret draft", s);
    expect(loadUserDrafts("bob", s)).toEqual({});
    expect(loadUserDrafts("alice", s)).toEqual({
      "agent-1": "alice's secret draft",
    });
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
    expect(() => saveDraft("nil", "a", "b", throwingStorage)).not.toThrow();
    expect(() => saveDraft("nil", "a", "", throwingStorage)).not.toThrow();
    expect(() =>
      pruneUserDrafts("nil", new Set(), throwingStorage),
    ).not.toThrow();
    expect(loadUserDrafts("nil", null)).toEqual({});
    expect(() => saveDraft("nil", "a", "b", null)).not.toThrow();
    expect(() => pruneUserDrafts("nil", new Set(), null)).not.toThrow();
  });
});

// The settings page was called "users" before it grew the office, room and
// device rows. Renaming the saved panel value is the one migration in this
// task that can silently cost a reader more than it fixes: the parser rejects
// a WHOLE payload on an unknown panel value, so a value the running build does
// not recognise takes roomId and agentId down with the panel.
describe("saved view: the settings panel rename", () => {
  const owner = "boss";

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
    });
  });

  it("parses the new 'settings' name", () => {
    const raw = JSON.stringify({
      user: owner,
      roomId: "room-1",
      agentId: null,
      panel: "settings",
    });
    expect(parseSavedView(raw)?.panel).toBe("settings");
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

  it("still rejects the whole payload for a panel value nobody knows", () => {
    // The strictness itself is deliberate and must not regress: this is why
    // "users" has to stay accepted rather than be dropped.
    const raw = JSON.stringify({
      user: owner,
      roomId: "room-1",
      agentId: "agent-1",
      panel: "wardrobe",
    });
    expect(parseSavedView(raw)).toBeNull();
  });
});
