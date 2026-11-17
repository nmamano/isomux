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
  getUsagePin,
  setUsagePin,
  getSettingsGroupsOpen,
  setSettingsGroupOpen,
  getAsksFilter,
  setAsksFilter,
  getAsksSort,
  setAsksSort,
  getAsksSortDir,
  setAsksSortDir,
  getAsksMember,
  setAsksMember,
  getChatCopyFormat,
  setChatCopyFormat,
  getChatSidebarPages,
  getChatSidebarSections,
  getChatSidebarShape,
  getChatSidebarWidth,
  setChatSidebarPages,
  setChatSidebarSections,
  setChatSidebarShape,
  setChatSidebarWidth,
  getWhatsAppLayout,
  setWhatsAppLayout,
  getGithubLayout,
  setGithubLayout,
  WHATSAPP_HELD_ROWS_MAX,
  getDiscordLayout,
  setDiscordLayout,
  DISCORD_HELD_MAX,
  getWebhooksLayout,
  setWebhooksLayout,
  WEBHOOKS_HELD_ROWS_MAX,
  getAppsLayout,
  setAppsLayout,
  APPS_HELD_ROWS_MAX,
  getSkillsLayout,
  setSkillsLayout,
  SKILLS_HELD_ROWS_MAX,
  SKILLS_LAYOUT_FALLBACK,
  getProviderLayout,
  setProviderLayout,
} = await import("./device-settings.ts");
const { FILTER_PRIORITIES } = await import("./task-priority.ts");
type PriorityFilterValue = import("./task-priority.ts").PriorityFilterValue;

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

// The chat sidebar's open sections on this device (task c23f23d0). A value
// the device cannot read, from an older build or a hand edit, reads as none,
// and the sidebar starts as on a first visit.
describe("chat sidebar sections", () => {
  beforeEach(() => store.clear());
  const sections = {
    rooms: ["r1", "r2"],
    back: ["r2"],
    more: true,
    lobby: false,
    pinned: false,
    recent: true,
    anchor: "a1|r1|0",
  };

  it("reads back what it saved, and none when nothing is saved", () => {
    expect(getChatSidebarSections()).toBeNull();
    setChatSidebarSections(sections);
    expect(getChatSidebarSections()).toEqual(sections);
    setChatSidebarSections({ ...sections, anchor: null });
    expect(getChatSidebarSections()).toEqual({ ...sections, anchor: null });
  });

  it("reads a broken value as none", () => {
    const bad = [
      "{not json",
      "null",
      '["r1"]',
      JSON.stringify({ ...sections, rooms: "r1" }),
      JSON.stringify({ ...sections, rooms: ["r1", 2] }),
      JSON.stringify({ ...sections, back: [null] }),
      JSON.stringify({ ...sections, more: "true" }),
      JSON.stringify({ ...sections, lobby: undefined }),
      JSON.stringify({ ...sections, anchor: 1 }),
    ];
    for (const raw of bad) {
      store.set("isomux-chat-sidebar-sections", raw);
      expect(getChatSidebarSections(), raw).toBeNull();
    }
  });
  // Saved before task 5dac6b9b: Pinned and Recent start open.
  it("reads a value saved without the Pinned and Recent flags with both open", () => {
    const { pinned: _p, recent: _r, ...older } = sections;
    store.set("isomux-chat-sidebar-sections", JSON.stringify(older));
    expect(getChatSidebarSections()).toEqual({
      ...older,
      pinned: true,
      recent: true,
    });
  });
});

// The shape of the sidebar's lists as last drawn (task 4dcad6bf).
describe("chat sidebar shape", () => {
  beforeEach(() => store.clear());
  const shape = {
    lists: { H: 26, items: [{ kind: "header" as const, top: 0, h: 26 }] },
    head: { name: 90, working: 40, inbox: 18 },
  };

  it("reads back what it saved, and none when nothing is saved", () => {
    expect(getChatSidebarShape()).toBeNull();
    setChatSidebarShape(shape);
    expect(getChatSidebarShape()).toEqual(shape);
  });

  it("reads a broken or insane value as none", () => {
    for (const raw of [
      "{not json",
      "null",
      JSON.stringify({
        ...shape,
        lists: { H: 26, items: [{ kind: "x", top: 0, h: 1 }] },
      }),
    ]) {
      store.set("isomux-chat-sidebar-shape", raw);
      expect(getChatSidebarShape(), raw).toBeNull();
    }
  });

  it("does not throw when the browser refuses storage", () => {
    const get = spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(getChatSidebarShape()).toBeNull();
      setChatSidebarShape(shape);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// The page rows a permission pack can hide, as last drawn (task f66e07e3).
describe("chat sidebar pages", () => {
  beforeEach(() => store.clear());

  it("reads back what it saved, an empty list included, and none when nothing is saved", () => {
    expect(getChatSidebarPages()).toBeNull();
    setChatSidebarPages(["tasks", "skills"]);
    expect([...getChatSidebarPages()!].sort()).toEqual(["skills", "tasks"]);
    setChatSidebarPages([]);
    expect(getChatSidebarPages()).toEqual([]);
  });

  it("reads a stored value through the parse, and broken JSON as none", () => {
    store.set("isomux-chat-sidebar-pages", "{not json");
    expect(getChatSidebarPages()).toBeNull();
    store.set("isomux-chat-sidebar-pages", '["apps","office","x"]');
    expect(getChatSidebarPages()).toEqual(["apps"]);
  });

  it("does not throw when the browser refuses storage", () => {
    const get = spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(getChatSidebarPages()).toBeNull();
      setChatSidebarPages(["tasks"]);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// The sidebar width on this device (task 5dac6b9b).
describe("chat sidebar width", () => {
  beforeEach(() => store.clear());

  it("reads back what it saved, clamped, and none when nothing valid is saved", () => {
    expect(getChatSidebarWidth()).toBeNull();
    setChatSidebarWidth(320);
    expect(getChatSidebarWidth()).toBe(320);
    setChatSidebarWidth(9999);
    expect(getChatSidebarWidth()).toBe(440);
    for (const raw of ["{not json", '"wide"', "null", "[300]"]) {
      store.set("isomux-chat-sidebar-width", raw);
      expect(getChatSidebarWidth(), raw).toBeNull();
    }
    // A stored number out of range (a hand edit) reads clamped.
    store.set("isomux-chat-sidebar-width", "120");
    expect(getChatSidebarWidth()).toBe(200);
  });
});

// The Inbox Asks tab's room, priority and agent filters, remembered per
// browser (tasks a930c9d6, b3cb0a41). All rooms, all priorities and all agents
// is the default, and storing it leaves nothing behind, as the sort does.
describe("asks filter", () => {
  beforeEach(() => store.clear());
  const ALL = {
    uncheckedRooms: [],
    uncheckedAgents: [],
    priorities: [...FILTER_PRIORITIES],
  };

  it("starts on all, round-trips a choice, and an all choice stores nothing", () => {
    expect(getAsksFilter()).toEqual(ALL);
    const choice = {
      uncheckedRooms: ["r2", "r3"],
      uncheckedAgents: ["a2", "a7"],
      priorities: ["P1", "none"] as PriorityFilterValue[],
    };
    setAsksFilter(choice);
    expect(getAsksFilter()).toEqual(choice);
    expect(store.size).toBe(1);
    // Every priority unchecked is a choice too: the tab shows its
    // "filters hide every ask" state, not all.
    setAsksFilter({ ...ALL, priorities: [] });
    expect(getAsksFilter()).toEqual({ ...ALL, priorities: [] });
    // One agent unchecked, with every room and priority: a choice to keep.
    setAsksFilter({ ...ALL, uncheckedAgents: ["a2"] });
    expect(getAsksFilter()).toEqual({ ...ALL, uncheckedAgents: ["a2"] });
    expect(store.size).toBe(1);
    setAsksFilter(ALL);
    expect(getAsksFilter()).toEqual(ALL);
    expect(store.size).toBe(0);
  });

  it("reads a broken or wrong-shaped value as all, and keeps the valid part of a mixed one", () => {
    setAsksFilter({ ...ALL, uncheckedRooms: ["r2"], priorities: ["P1"] });
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
    // A level this build does not know, and a room or agent id that is not a
    // string, are dropped; the rest of the choice stands.
    store.set(
      key,
      JSON.stringify({
        uncheckedRooms: ["r2", 7],
        uncheckedAgents: [8, "a2"],
        priorities: ["P9", "P1"],
      }),
    );
    expect(getAsksFilter()).toEqual({
      uncheckedRooms: ["r2"],
      uncheckedAgents: ["a2"],
      priorities: ["P1"],
    });
  });

  // A filter stored before the agent filter existed keeps its rooms and
  // priorities, with no agent unchecked; so does one whose agents are not a
  // list.
  it("reads a value without agents, or with agents that are not a list, as no agent unchecked", () => {
    setAsksFilter({ ...ALL, uncheckedRooms: ["r2"], priorities: ["P1"] });
    const [key] = [...store.keys()];
    for (const raw of [
      '{"uncheckedRooms":["r2"],"priorities":["P1"]}',
      '{"uncheckedRooms":["r2"],"priorities":["P1"],"uncheckedAgents":"a2"}',
      '{"uncheckedRooms":["r2"],"priorities":["P1"],"uncheckedAgents":null}',
    ]) {
      store.set(key, raw);
      expect(getAsksFilter(), raw).toEqual({
        uncheckedRooms: ["r2"],
        uncheckedAgents: [],
        priorities: ["P1"],
      });
    }
  });
});

// The Asks tab sort, remembered per device. The Asks page reads it at mount
// ("remembers the sort and both filters" in
// ui/components/AsksView.filter-memory.dom.test.tsx).
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

// The layouts the Messaging and GitHub issues tabs hold while they load (task
// eeec205a). A first visit holds the unlinked card, and GitHub's form with no
// secret allowed yet.
describe("integrations held layouts", () => {
  beforeEach(() => {
    store.delete("isomux-whatsapp-layout");
    store.delete("isomux-github-layout");
    store.delete("isomux-discord-layout");
  });

  it("keeps what was saved, and holds the unlinked card before a first save", () => {
    expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 0 });
    setWhatsAppLayout({ linked: true, rows: 3 });
    expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 3 });
    setWhatsAppLayout({ linked: true, rows: WHATSAPP_HELD_ROWS_MAX });
    expect(getWhatsAppLayout().rows).toBe(WHATSAPP_HELD_ROWS_MAX);

    expect(getGithubLayout()).toEqual({ linked: false, secret: false });
    setGithubLayout({ linked: true, secret: true });
    expect(getGithubLayout()).toEqual({ linked: true, secret: true });
    setGithubLayout({ linked: false, secret: true });
    expect(getGithubLayout()).toEqual({ linked: false, secret: true });
  });

  it.each([
    "junk",
    "[]",
    "null",
    '{"linked":"yes","rows":1}',
    '{"linked":true}',
    '{"linked":true,"rows":-1}',
    '{"linked":true,"rows":1.5}',
    '{"linked":true,"rows":"2"}',
    `{"linked":true,"rows":${WHATSAPP_HELD_ROWS_MAX + 1}}`,
  ])("reads the stored WhatsApp value %s as the unlinked card", (raw) => {
    store.set("isomux-whatsapp-layout", raw);
    expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 0 });
  });

  it.each([
    "junk",
    "[]",
    "{}",
    '{"linked":1,"secret":true}',
    '{"linked":true}',
    '{"linked":true,"secret":"yes"}',
  ])("reads the stored GitHub value %s as no link and no secret", (raw) => {
    store.set("isomux-github-layout", raw);
    expect(getGithubLayout()).toEqual({ linked: false, secret: false });
  });

  it("keeps the Discord bot and route counts, each capped, and holds no bot before a first save", () => {
    expect(getDiscordLayout()).toEqual({ bots: 0, rows: 0 });
    setDiscordLayout({ bots: 2, rows: 3 });
    expect(getDiscordLayout()).toEqual({ bots: 2, rows: 3 });
    setDiscordLayout({
      bots: DISCORD_HELD_MAX + 5,
      rows: DISCORD_HELD_MAX + 1,
    });
    expect(getDiscordLayout()).toEqual({
      bots: DISCORD_HELD_MAX,
      rows: DISCORD_HELD_MAX,
    });
  });

  it.each([
    "junk",
    "[]",
    "null",
    "{}",
    '{"bots":1}',
    '{"bots":-1,"rows":0}',
    '{"bots":1.5,"rows":0}',
    '{"bots":"2","rows":0}',
    `{"bots":0,"rows":${DISCORD_HELD_MAX + 1}}`,
  ])("reads the stored Discord value %s as no bot", (raw) => {
    store.set("isomux-discord-layout", raw);
    expect(getDiscordLayout()).toEqual({ bots: 0, rows: 0 });
  });
});

// The row each Codex and Claude sign-in card drew under its status (task
// da868bd9). A first visit holds an office that is signed in and a viewer who
// is not.
describe("provider held layout", () => {
  const FIRST = {
    office: { codex: "signOut", claude: "signOut" },
    personal: { codex: "signIn", claude: "signIn" },
  } as const;
  beforeEach(() => store.delete("isomux-provider-layout"));

  it("keeps each card's row, and holds the first-visit rows before a first save", () => {
    expect(getProviderLayout()).toEqual(FIRST);
    const saved = {
      office: { codex: "none", claude: "signIn" },
      personal: { codex: "signOut", claude: "none" },
    } as const;
    setProviderLayout(saved);
    expect(getProviderLayout()).toEqual(saved);
  });

  it.each([
    "junk",
    "[]",
    "null",
    "{}",
    '{"office":{"codex":"signIn","claude":"signIn"}}',
    '{"office":{"codex":"signIn","claude":"signIn"},"personal":{"codex":"signIn"}}',
    '{"office":{"codex":"maybe","claude":"signIn"},"personal":{"codex":"signIn","claude":"signIn"}}',
    '{"office":{"codex":true,"claude":"signIn"},"personal":{"codex":"signIn","claude":"signIn"}}',
    '{"office":[],"personal":{"codex":"signIn","claude":"signIn"}}',
  ])("reads the stored value %s as the first-visit rows", (raw) => {
    store.set("isomux-provider-layout", raw);
    expect(getProviderLayout()).toEqual(FIRST);
  });
});

// The row count the Webhooks list holds while it loads (task 8caa3022).
describe("webhooks held layout", () => {
  beforeEach(() => store.delete("isomux-webhooks-layout"));

  it("keeps the count, at most the cap, and holds one row before a first save", () => {
    expect(getWebhooksLayout()).toEqual({ rows: 1 });
    setWebhooksLayout({ rows: 0 });
    expect(getWebhooksLayout()).toEqual({ rows: 0 });
    setWebhooksLayout({ rows: WEBHOOKS_HELD_ROWS_MAX + 5 });
    expect(getWebhooksLayout()).toEqual({ rows: WEBHOOKS_HELD_ROWS_MAX });
  });

  it.each([
    "junk",
    "[]",
    "{}",
    '{"rows":-1}',
    '{"rows":1.5}',
    '{"rows":"2"}',
    `{"rows":${WEBHOOKS_HELD_ROWS_MAX + 1}}`,
  ])("reads the stored value %s as one row", (raw) => {
    store.set("isomux-webhooks-layout", raw);
    expect(getWebhooksLayout()).toEqual({ rows: 1 });
  });
});

// What the Apps page holds while its list loads (task 29594d38).
describe("apps held layout", () => {
  beforeEach(() => store.delete("isomux-apps-layout"));
  const fallback = { filters: true, running: 1, stopped: 0, archived: 0 };

  it("keeps each count, at most the cap, and holds the bar and one row before a first save", () => {
    expect(getAppsLayout()).toEqual(fallback);
    const none = { filters: false, running: 0, stopped: 0, archived: 0 };
    setAppsLayout(none);
    expect(getAppsLayout()).toEqual(none);
    const some = { filters: true, running: 4, stopped: 2, archived: 7 };
    setAppsLayout(some);
    expect(getAppsLayout()).toEqual(some);
    const over = APPS_HELD_ROWS_MAX + 5;
    for (const section of ["running", "stopped", "archived"] as const) {
      setAppsLayout({ ...none, filters: true, [section]: over });
      expect(getAppsLayout()).toEqual({
        ...none,
        filters: true,
        [section]: APPS_HELD_ROWS_MAX,
      });
    }
  });

  const ok = { filters: false, running: 2, stopped: 3, archived: 4 };
  it.each([
    "junk",
    "[]",
    "{}",
    JSON.stringify({ ...ok, filters: "true" }),
    JSON.stringify({ running: 2, stopped: 3, archived: 4 }),
    ...(["running", "stopped", "archived"] as const).flatMap((k) => [
      JSON.stringify({ ...ok, [k]: -1 }),
      JSON.stringify({ ...ok, [k]: 1.5 }),
      JSON.stringify({ ...ok, [k]: "2" }),
      JSON.stringify({ ...ok, [k]: APPS_HELD_ROWS_MAX + 1 }),
      JSON.stringify({
        filters: false,
        ...Object.fromEntries(
          Object.entries(ok).filter(([key]) => key !== k && key !== "filters"),
        ),
      }),
    ]),
  ])("reads the stored value %s as the fallback", (raw) => {
    store.set("isomux-apps-layout", raw);
    expect(getAppsLayout()).toEqual(fallback);
  });

  it("reads a valid stored value as stored", () => {
    store.set("isomux-apps-layout", JSON.stringify(ok));
    expect(getAppsLayout()).toEqual(ok);
  });
});

// What the Skills page holds while its catalog loads (task 299d7b03): the tab
// counts, one tab's groups with each row's height, and the desktop detail's
// header and controls heights.
describe("skills held layout", () => {
  const KEY = "isomux-skills-layout";
  beforeEach(() => store.delete(KEY));
  type SkillsLayout = import("./device-settings.ts").SkillsLayout;
  const saved: SkillsLayout = {
    counts: { all: 12, claude: 0, codex: 3, opencode: 99999 },
    tab: "codex",
    groups: [
      { source: "user", rows: [61, 44] },
      { source: "project", rows: [1] },
      { source: "plugin", rows: [400] },
      { source: "isomux", rows: [44, 44, 44] },
    ],
    detail: { head: 90, controls: 30 },
  };

  it("keeps what it stored, with or without a detail, and holds the fallback before a first save", () => {
    expect(getSkillsLayout()).toEqual(SKILLS_LAYOUT_FALLBACK);
    setSkillsLayout(saved);
    expect(getSkillsLayout()).toEqual(saved);
    setSkillsLayout({ ...saved, detail: null });
    expect(getSkillsLayout()).toEqual({ ...saved, detail: null });
  });

  it("stores at most the cap of rows in all, dropping the rows after it", () => {
    const over = SKILLS_HELD_ROWS_MAX - 3;
    setSkillsLayout({
      ...saved,
      groups: [
        { source: "user", rows: Array.from({ length: over }, () => 50) },
        { source: "isomux", rows: [40, 41, 42, 43, 44, 45] },
        { source: "plugin", rows: [60] },
      ],
    });
    const back = getSkillsLayout();
    expect(back.counts).toEqual(saved.counts);
    expect(back.groups.flatMap((g) => g.rows)).toHaveLength(
      SKILLS_HELD_ROWS_MAX,
    );
    expect(back.groups.map((g) => g.source)).toEqual(["user", "isomux"]);
    expect(back.groups[1]!.rows).toEqual([40, 41, 42]);
  });

  // Each one breaks one field of a good value; the read falls back whole.
  const good = JSON.stringify(saved);
  const bad: [string, (l: Record<string, unknown>) => void][] = [
    ["no counts", (l) => delete l.counts],
    [
      "a count missing",
      (l) => delete (l.counts as Record<string, unknown>).opencode,
    ],
    [
      "a negative count",
      (l) => ((l.counts as Record<string, unknown>).all = -1),
    ],
    [
      "a fractional count",
      (l) => ((l.counts as Record<string, unknown>).all = 1.5),
    ],
    [
      "a count as text",
      (l) => ((l.counts as Record<string, unknown>).all = "4"),
    ],
    [
      "a count past the cap",
      (l) => ((l.counts as Record<string, unknown>).all = 100000),
    ],
    ["an unknown tab", (l) => (l.tab = "commands")],
    ["groups not a list", (l) => (l.groups = {})],
    [
      "an unknown source",
      (l) => ((l.groups as { source: string }[])[0]!.source = "shell"),
    ],
    [
      "a source twice",
      (l) => ((l.groups as { source: string }[])[1]!.source = "user"),
    ],
    [
      "a group with no rows",
      (l) => ((l.groups as { rows: unknown }[])[1]!.rows = []),
    ],
    [
      "a zero height",
      (l) => ((l.groups as { rows: unknown[] }[])[0]!.rows[0] = 0),
    ],
    [
      "a height past 400",
      (l) => ((l.groups as { rows: unknown[] }[])[0]!.rows[0] = 401),
    ],
    [
      "a fractional height",
      (l) => ((l.groups as { rows: unknown[] }[])[0]!.rows[0] = 44.5),
    ],
    [
      "rows past the cap",
      (l) =>
        ((l.groups as { rows: unknown[] }[])[3]!.rows = Array.from(
          { length: SKILLS_HELD_ROWS_MAX },
          () => 44,
        )),
    ],
    [
      "a detail with no head",
      (l) => delete (l.detail as Record<string, unknown>).head,
    ],
    [
      "a zero detail height",
      (l) => ((l.detail as Record<string, unknown>).controls = 0),
    ],
    [
      "a detail height past 400",
      (l) => ((l.detail as Record<string, unknown>).head = 401),
    ],
  ];
  it.each(bad)(
    "reads a stored value with %s as the fallback",
    (_name, breakIt) => {
      const l = JSON.parse(good) as Record<string, unknown>;
      breakIt(l);
      store.set(KEY, JSON.stringify(l));
      expect(getSkillsLayout()).toEqual(SKILLS_LAYOUT_FALLBACK);
    },
  );

  it.each(["junk", "[]", "null", "{}"])(
    "reads the stored value %s as the fallback",
    (raw) => {
      store.set(KEY, raw);
      expect(getSkillsLayout()).toEqual(SKILLS_LAYOUT_FALLBACK);
    },
  );
});
