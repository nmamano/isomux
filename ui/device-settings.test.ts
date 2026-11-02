// Unit tests for the device-scoped settings (ui/device-settings.ts).
// localStorage is stubbed on globalThis - the module reads the global
// directly.

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";

const store = new Map<string, string>();
const realLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

afterAll(() => {
  if (realLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", realLocalStorage);
  } else {
    // @ts-expect-error - removing the stub we installed
    delete globalThis.localStorage;
  }
});

const {
  getMembersChatWidth,
  setMembersChatWidth,
  getMembersChatOpen,
  setMembersChatOpen,
  getUsagePin,
  setUsagePin,
  getSettingsGroupsOpen,
  setSettingsGroupOpen,
  getAsksFilter,
  setAsksFilter,
  getAsksSeen,
  markAsksSeen,
  getAsksSort,
  setAsksSort,
  getAsksSortDir,
  setAsksSortDir,
  getAsksMember,
  setAsksMember,
  getChatCopyFormat,
  setChatCopyFormat,
} = await import("./device-settings.ts");
const { FILTER_PRIORITIES } = await import("./task-priority.ts");

// The usage pill's pinned limit (task df489513). Stored per device per agent
// AND per provider: an agent switched between engines must not stay pinned to a
// window the new provider doesn't have.
describe("usage pill pin", () => {
  beforeEach(() => store.clear());

  const weekly = { label: "Weekly", index: 0 };
  const fiveHour = { label: "5-hour", index: 1 };

  it("defaults to auto (no pin)", () => {
    expect(getUsagePin("agent-1", "claude")).toBeNull();
  });

  it("round-trips a pinned window", () => {
    setUsagePin("agent-1", "claude", fiveHour);
    expect(getUsagePin("agent-1", "claude")).toEqual(fiveHour);
  });

  it("keeps agents and providers apart", () => {
    setUsagePin("agent-1", "claude", { label: "Weekly (Opus)", index: 2 });
    setUsagePin("agent-2", "claude", fiveHour);
    // Same agent, other engine: a Claude window label means nothing to Codex.
    expect(getUsagePin("agent-1", "codex")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toEqual(fiveHour);
    expect(getUsagePin("agent-1", "claude")).toEqual({
      label: "Weekly (Opus)",
      index: 2,
    });
  });

  it("clears back to auto with null, leaving other pins alone", () => {
    setUsagePin("agent-1", "claude", fiveHour);
    setUsagePin("agent-2", "claude", weekly);
    setUsagePin("agent-1", "claude", null);
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toEqual(weekly);
  });

  it("survives a corrupt stored value instead of throwing", () => {
    store.set("isomux-usage-pin", "{not json");
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    setUsagePin("agent-1", "claude", weekly);
    expect(getUsagePin("agent-1", "claude")).toEqual(weekly);
  });

  it("rejects a stored entry of the wrong shape rather than half-trusting it", () => {
    store.set(
      "isomux-usage-pin",
      JSON.stringify({
        "claude:agent-1": "Weekly",
        "claude:agent-2": { label: "Weekly" },
        "claude:agent-3": { index: 1 },
      }),
    );
    expect(getUsagePin("agent-1", "claude")).toBeNull();
    expect(getUsagePin("agent-2", "claude")).toBeNull();
    expect(getUsagePin("agent-3", "claude")).toBeNull();
  });
});

describe("members chat width", () => {
  beforeEach(() => store.clear());
  it("defaults missing and invalid values, clamps finite values, and remembers width", () => {
    expect(getMembersChatWidth(1440)).toBe(520);
    for (const value of ["broken", "NaN", "Infinity", ""]) {
      store.set("isomux-members-chat-width", value);
      expect(getMembersChatWidth(1440)).toBe(520);
    }
    store.set("isomux-members-chat-width", "-900");
    expect(getMembersChatWidth(1440)).toBe(300);
    setMembersChatWidth(800);
    expect(getMembersChatWidth(1440)).toBe(800);
    expect(getMembersChatWidth(768)).toBe(720);
    setMembersChatWidth(90000);
    expect(getMembersChatWidth(1440)).toBe(900);
  });
});

// The store reads the lobby chat's open choice when the page loads, so a
// browser that blocks storage (a sandboxed frame throws on access) must get
// a closed chat, not a page that fails to start.
describe("members chat open", () => {
  beforeEach(() => store.clear());
  it("reads closed and saves nothing, without throwing, when storage throws", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(getMembersChatOpen()).toBe(false);
      setMembersChatOpen(true);
    } finally {
      Object.defineProperty(globalThis, "localStorage", real);
    }
    // Anchor: with storage back, the same calls save and read.
    expect(getMembersChatOpen()).toBe(false);
    setMembersChatOpen(true);
    expect(getMembersChatOpen()).toBe(true);
  });
});

// The Settings groups opened on this device (task db800fd8). A value the
// device cannot read, from an older build or a hand edit, leaves every group
// collapsed instead of breaking the Settings page.
describe("settings groups open", () => {
  beforeEach(() => store.clear());

  it("opens and closes a group by id", () => {
    expect([...getSettingsGroupsOpen()]).toEqual([]);
    setSettingsGroupOpen("rooms", true);
    setSettingsGroupOpen("members", true);
    setSettingsGroupOpen("rooms", false);
    expect([...getSettingsGroupsOpen()]).toEqual(["members"]);
  });

  it("reads a broken value as no group open, and a later open still saves", () => {
    for (const raw of ["{not json", '{"rooms":true}', '"rooms"', "[1]"]) {
      store.set("isomux-settings-groups-open", raw);
      expect([...getSettingsGroupsOpen()], raw).toEqual([]);
    }
    setSettingsGroupOpen("rooms", true);
    expect([...getSettingsGroupsOpen()]).toEqual(["rooms"]);
  });
});

// The Inbox Asks tab's room and priority filters, remembered per browser
// (task a930c9d6). All rooms and all priorities is the default, and storing
// it leaves nothing behind, as the sort does.
describe("asks filter", () => {
  beforeEach(() => store.clear());
  const ALL = { uncheckedRooms: [], priorities: [...FILTER_PRIORITIES] };

  it("starts on all, round-trips a choice, and an all choice stores nothing", () => {
    expect(getAsksFilter()).toEqual(ALL);
    setAsksFilter({ uncheckedRooms: ["r2", "r3"], priorities: ["P1", "none"] });
    expect(getAsksFilter()).toEqual({
      uncheckedRooms: ["r2", "r3"],
      priorities: ["P1", "none"],
    });
    expect(store.size).toBe(1);
    // Every priority unchecked is a choice too: the tab shows its
    // "filters hide every ask" state, not all.
    setAsksFilter({ uncheckedRooms: [], priorities: [] });
    expect(getAsksFilter()).toEqual({ uncheckedRooms: [], priorities: [] });
    setAsksFilter(ALL);
    expect(getAsksFilter()).toEqual(ALL);
    expect(store.size).toBe(0);
  });

  it("reads a broken or wrong-shaped value as all, and keeps the valid part of a mixed one", () => {
    setAsksFilter({ uncheckedRooms: ["r2"], priorities: ["P1"] });
    const [key] = [...store.keys()];
    for (const raw of [
      "{not json",
      "null",
      '"r2"',
      "[]",
      '{"uncheckedRooms":"r2","priorities":["P1"]}',
      '{"uncheckedRooms":["r2"],"priorities":"P1"}',
    ]) {
      store.set(key, raw);
      expect(getAsksFilter(), raw).toEqual(ALL);
    }
    // A level this build does not know and a room id that is not a string
    // are dropped; the rest of the choice stands.
    store.set(
      key,
      JSON.stringify({ uncheckedRooms: ["r2", 7], priorities: ["P9", "P1"] }),
    );
    expect(getAsksFilter()).toEqual({
      uncheckedRooms: ["r2"],
      priorities: ["P1"],
    });
  });
});

// The open asks this browser showed on the Asks tab (task a930c9d6): the
// Inbox badge counts the open asks not in it. A mark adds the asks shown and
// keeps only the ids still in the asks slice, so the set stays as small as
// the open asks.
describe("asks seen", () => {
  beforeEach(() => store.clear());
  const seen = () => [...getAsksSeen()].sort();

  it("adds the shown asks, keeps a seen ask while it is in the slice, and drops it when it leaves", () => {
    expect(seen()).toEqual([]);
    markAsksSeen(["a", "b"], ["a", "b", "c"]);
    expect(seen()).toEqual(["a", "b"]);
    // "b" is not shown now (its agent's room is hidden), but still open.
    markAsksSeen(["c"], ["b", "c"]);
    expect(seen()).toEqual(["b", "c"]);
  });

  it("writes nothing on an empty slice or when nothing changes", () => {
    markAsksSeen(["a", "b"], ["a", "b"]);
    const [key] = [...store.keys()];
    const stored = store.get(key);
    // Before GET /api/asks lands the slice is empty: no wipe.
    markAsksSeen([], []);
    expect(seen()).toEqual(["a", "b"]);
    const writes = spyOn(localStorage, "setItem");
    try {
      markAsksSeen(["b", "a"], ["a", "b"]);
      markAsksSeen(["a"], ["b", "a"]);
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    expect(store.get(key)).toBe(stored);
    // Anchor: a change still writes.
    markAsksSeen(["c"], ["a", "c"]);
    expect(seen()).toEqual(["a", "c"]);
  });

  it("returns the same set while the stored value is unchanged, a new one after a change", () => {
    markAsksSeen(["a"], ["a"]);
    const first = getAsksSeen();
    expect(getAsksSeen()).toBe(first);
    markAsksSeen(["b"], ["a", "b"]);
    expect(getAsksSeen()).not.toBe(first);
    expect(seen()).toEqual(["a", "b"]);
  });

  it("reads a broken value as nothing seen, and drops ids that are not strings", () => {
    markAsksSeen(["a"], ["a"]);
    const [key] = [...store.keys()];
    for (const raw of ["{not json", '"a"', '{"a":true}', "null"]) {
      store.set(key, raw);
      expect(seen(), raw).toEqual([]);
    }
    store.set(key, JSON.stringify(["a", 3, null, "b"]));
    expect(seen()).toEqual(["a", "b"]);
  });
});

// The Asks tab sort, remembered per device. The Asks page reads it at mount
// ("remembers the sort and both filters" in
// ui/components/AsksView.filters.dom.test.tsx).
describe("asks sort", () => {
  beforeEach(() => store.clear());

  it("starts as agent, round-trips each sort, and reads a value it does not know as agent", () => {
    expect(getAsksSort()).toBe("agent");
    // The stored values are a protocol: a browser keeps them across builds.
    for (const sort of ["room", "priority", "age", "agent"] as const) {
      setAsksSort(sort);
      expect(getAsksSort()).toBe(sort);
    }
    // The default leaves nothing behind.
    expect(store.size).toBe(0);
    setAsksSort("room");
    const [key] = [...store.keys()];
    store.set(key, "bogus");
    expect(getAsksSort()).toBe("agent");
  });
});

// The Asks tab sort's direction (task 452cf482), remembered per device like
// the sort itself. One shared direction, stored only when it is desc, and a
// value this build does not know reads as asc.
describe("asks sort direction", () => {
  beforeEach(() => store.clear());

  it("starts as asc, round-trips, and stores only a desc", () => {
    expect(getAsksSortDir()).toBe("asc");
    expect(store.size).toBe(0);
    setAsksSortDir("desc");
    expect(getAsksSortDir()).toBe("desc");
    // The key is a protocol value.
    expect([...store.entries()]).toEqual([["isomux-asks-sort-dir", "desc"]]);
    setAsksSortDir("asc");
    expect(getAsksSortDir()).toBe("asc");
    expect(store.size).toBe(0);
  });

  it("reads a value it does not know as asc", () => {
    store.set("isomux-asks-sort-dir", "side");
    expect(getAsksSortDir()).toBe("asc");
    setAsksSortDir("desc");
    expect([...store.keys()]).toEqual(["isomux-asks-sort-dir"]);
    expect(getAsksSortDir()).toBe("desc");
  });
});

// Whose asks an office owner's Asks tab lists (task a49856f7), remembered
// per device: their own, every member's, or one member's. A username can be
// any word, "all" and "mine" included.
describe("asks member", () => {
  beforeEach(() => store.clear());

  it("starts as mine and round-trips each choice, a member named like a choice included", () => {
    expect(getAsksMember()).toEqual({ kind: "mine" });
    for (const member of [
      { kind: "all" },
      { kind: "member", name: "pat" },
      { kind: "member", name: "all" },
      { kind: "member", name: "mine" },
      { kind: "member", name: "member:x" },
      { kind: "mine" },
    ] as const) {
      setAsksMember(member);
      expect(getAsksMember()).toEqual(member);
    }
  });

  it("reads a value it does not know as mine", () => {
    setAsksMember({ kind: "member", name: "pat" });
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    for (const raw of ["side", "", "member:", "{}"]) {
      store.set(keys[0], raw);
      expect({ raw, read: getAsksMember() }).toEqual({
        raw,
        read: { kind: "mine" },
      });
    }
  });
});

// The chat bar's Copy format (task 28bd5993), remembered per browser.
describe("chat copy format", () => {
  beforeEach(() => store.clear());

  it("starts as Markdown and round-trips each choice", () => {
    expect(getChatCopyFormat()).toBe("markdown");
    setChatCopyFormat("plain");
    expect(getChatCopyFormat()).toBe("plain");
    // The key is a protocol value.
    expect(store.get("isomux-chat-copy-format")).toBe("plain");
    setChatCopyFormat("html");
    expect(getChatCopyFormat()).toBe("html");
    expect(store.get("isomux-chat-copy-format")).toBe("html");
    setChatCopyFormat("markdown");
    expect(getChatCopyFormat()).toBe("markdown");
  });

  it("reads a value it does not know as Markdown", () => {
    store.set("isomux-chat-copy-format", "rtf");
    expect(getChatCopyFormat()).toBe("markdown");
  });

  it("reads Markdown when storage throws, and a save does not throw", () => {
    const get = spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(getChatCopyFormat()).toBe("markdown");
      // Called directly: a throw fails the test.
      setChatCopyFormat("plain");
      expect(set).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
