// The ask store's load posture, the three shapes of an entry, who sees an
// ask, and the note the agent reads.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AskCommandRun, AskEntry } from "../shared/types.ts";
import { API_CAPABILITIES, type Identity } from "./identity/index.ts";
import {
  ASK_TASK_TITLE_MAX,
  askAgentWire,
  askAudienceFor,
  askMemberIds,
  askReplyNote,
  askShownToOwnerAsOther,
  askTaskFields,
  askVisibleTo,
  checkOptions,
  type AskAudienceDeps,
  type AskChange,
  createAskFilePersistence,
  createAskStore,
  type AskPersistence,
} from "./asks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fileIn(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "isomux-asks-"));
  dirs.push(dir);
  return { dir, path: join(dir, "asks.json") };
}

describe("loading", () => {
  it("starts empty with no file, and the next store reads what the first wrote", () => {
    const { path } = fileIn();
    const first = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(first.listAll()).toEqual([]);
    const made = first.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
    });
    if (!made.ok) throw new Error("create failed");
    const second = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(second.get(made.entry.id)).toEqual(made.entry);
  });

  it("moves a corrupt file aside and starts empty", () => {
    const { dir, path } = fileIn();
    writeFileSync(path, "{not json");
    const store = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(store.listForAgent("a1")).toEqual([]);
    expect(
      readdirSync(dir).some((f) => f.startsWith("asks.json.corrupt-")),
    ).toBe(true);
  });

  it("leaves memory unchanged when a write fails", () => {
    let fail = false;
    const persistence: AskPersistence = {
      load: () => ({ kind: "missing" }),
      save: () => {
        if (fail) throw new Error("disk full");
      },
      quarantine: () => true,
    };
    const store = createAskStore({ persistence });
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
    });
    if (!made.ok) throw new Error("create failed");
    fail = true;
    expect(() =>
      store.remove(made.entry.id, { outcome: "withdrawn" }),
    ).toThrow();
    expect(store.get(made.entry.id)).toEqual(made.entry);
  });
});

const SECRET = {
  requestId: "req-1",
  name: "GH_TOKEN",
  hosts: ["api.github.com"],
  form: { kind: "authorization" as const },
  reason: "To open the pull request.",
};
const DRAFT = { app: "whatsapp", routeId: "r1", text: "*hi*\nsee you at 5" };
const BASE = {
  id: "abcd1234",
  agentId: "a1",
  prompt: "Go?",
  createdAt: 1,
  updatedAt: 1,
};

// One of each chat affordance, in the stored form.
const AFFORDANCES = {
  commands: ["bun test"],
  editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
  readFiles: [
    {
      filename: "ab12.png",
      originalName: "plot.png",
      mediaType: "image/png",
      size: 7,
    },
  ],
};

// A video referenced where it is (task 37a660e8).
const REFERENCE = {
  filename: "9f3c.mp4",
  originalName: "clip.mp4",
  mediaType: "video/mp4",
  size: 9,
  path: "/w/out/clip.mp4",
};

describe("the three shapes", () => {
  // Plain and personal secret asks name one member; an office secret ask
  // names none. Any other mix is a corrupt file.
  const shapes: [string, unknown, boolean][] = [
    ["plain", { ...BASE, memberUserId: "u1" }, true],
    [
      "personal secret",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal" },
      },
      true,
    ],
    [
      "office secret",
      { ...BASE, secret: { ...SECRET, scope: "office" } },
      true,
    ],
    ["plain with no member", BASE, false],
    // A simplify request and the prompt before its rewrite (task 30915188).
    [
      "simplify request and original prompt",
      {
        ...BASE,
        memberUserId: "u1",
        simplifyRequestedAt: 5,
        originalPrompt: "Old?",
      },
      true,
    ],
    [
      "simplify request time that is not a number",
      { ...BASE, memberUserId: "u1", simplifyRequestedAt: "5" },
      false,
    ],
    [
      "original prompt that is not a string",
      { ...BASE, memberUserId: "u1", originalPrompt: 5 },
      false,
    ],
    [
      "personal secret with no member",
      { ...BASE, secret: { ...SECRET, scope: "personal" } },
      false,
    ],
    [
      "office secret naming a member",
      { ...BASE, memberUserId: "u1", secret: { ...SECRET, scope: "office" } },
      false,
    ],
    [
      "secret with no request id",
      { ...BASE, secret: { ...SECRET, requestId: "", scope: "office" } },
      false,
    ],
    // A link is checked on write only: one this release does not know (a
    // page a later release dropped) loads, so it cannot cost every ask.
    [
      "link to a page this release does not know",
      { ...BASE, memberUserId: "u1", link: "/gone" },
      true,
    ],
    [
      "link that is not a string",
      { ...BASE, memberUserId: "u1", link: 1 },
      false,
    ],
    ["empty link", { ...BASE, memberUserId: "u1", link: "" }, false],
    [
      "secret with a link",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal" },
        link: "/integrations/secrets",
      },
      false,
    ],
    // Options too are bounded on write only.
    [
      "eleven options",
      { ...BASE, memberUserId: "u1", options: "abcdefghijk".split("") },
      true,
    ],
    ["empty options", { ...BASE, memberUserId: "u1", options: [] }, false],
    [
      "an empty option",
      { ...BASE, memberUserId: "u1", options: ["a", ""] },
      false,
    ],
    [
      "options not a list",
      { ...BASE, memberUserId: "u1", options: "a" },
      false,
    ],
    [
      "secret with options",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal" },
        options: ["Save", "Decline"],
      },
      false,
    ],
    // A recommendation needs options; that it is one of them is checked on
    // write only.
    [
      "recommendation that is not one of the options",
      { ...BASE, memberUserId: "u1", options: ["a", "b"], recommended: "c" },
      true,
    ],
    [
      "recommendation without options",
      { ...BASE, memberUserId: "u1", recommended: "a" },
      false,
    ],
    [
      "empty recommendation",
      { ...BASE, memberUserId: "u1", options: ["a", "b"], recommended: "" },
      false,
    ],
    [
      "recommendation that is not a string",
      { ...BASE, memberUserId: "u1", options: ["a", "b"], recommended: 1 },
      false,
    ],
    // Chat affordances: the shape is checked on load, the bounds on write.
    [
      "commands, editor files and read files",
      { ...BASE, memberUserId: "u1", ...AFFORDANCES },
      true,
    ],
    [
      "more affordances than a write takes",
      {
        ...BASE,
        memberUserId: "u1",
        commands: Array.from({ length: 11 }, (_, i) => `echo ${i}`),
      },
      true,
    ],
    ["empty commands", { ...BASE, memberUserId: "u1", commands: [] }, false],
    [
      "commands not a list",
      { ...BASE, memberUserId: "u1", commands: "ls" },
      false,
    ],
    [
      "an editor file with no path",
      { ...BASE, memberUserId: "u1", editFiles: [{ cwd: "/w" }] },
      false,
    ],
    [
      "a read file with no filename",
      {
        ...BASE,
        memberUserId: "u1",
        readFiles: [{ originalName: "a.png", mediaType: "image/png", size: 1 }],
      },
      false,
    ],
    // Task 37a660e8: a referenced read file carries the absolute path it is
    // served from.
    [
      "a read file referenced by an absolute path",
      { ...BASE, memberUserId: "u1", readFiles: [REFERENCE] },
      true,
    ],
    [
      "a read file referenced by a relative path",
      {
        ...BASE,
        memberUserId: "u1",
        readFiles: [{ ...REFERENCE, path: "out/clip.mp4" }],
      },
      false,
    ],
    [
      "a read file whose path is not a string",
      {
        ...BASE,
        memberUserId: "u1",
        readFiles: [{ ...REFERENCE, path: 1 }],
      },
      false,
    ],
    // A WhatsApp reply draft (task d03a61d8): the row and the text that
    // goes out at Send, on a plain ask only.
    [
      "WhatsApp reply draft",
      {
        ...BASE,
        memberUserId: "u1",
        options: ["Send", "Don't send"],
        messaging: DRAFT,
      },
      true,
    ],
    // An app a later release knows: it loads, so a downgrade keeps the file.
    [
      "reply draft for an app this release does not know",
      { ...BASE, memberUserId: "u1", messaging: { ...DRAFT, app: "telegram" } },
      true,
    ],
    ...(
      [
        ["draft that is not an object", "x"],
        ["draft with no row", { app: "whatsapp", text: "hi" }],
        [
          "draft with an empty row",
          { app: "whatsapp", routeId: "", text: "hi" },
        ],
        [
          "draft whose text is not a string",
          { app: "whatsapp", routeId: "r1", text: 5 },
        ],
        ["draft with no app", { routeId: "r1", text: "hi" }],
        ["draft with an empty app", { app: "", routeId: "r1", text: "hi" }],
      ] as const
    ).map(([label, messaging]): [string, unknown, boolean] => [
      label,
      { ...BASE, memberUserId: "u1", messaging },
      false,
    ]),
    [
      "secret with a draft",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal" },
        messaging: DRAFT,
      },
      false,
    ],
    ...(["commands", "editFiles", "readFiles"] as const).map(
      (key): [string, unknown, boolean] => [
        `secret with ${key}`,
        {
          ...BASE,
          memberUserId: "u1",
          secret: { ...SECRET, scope: "personal" },
          [key]: AFFORDANCES[key],
        },
        false,
      ],
    ),
    // A shared ask (task 9461c464): named members, or the room. Only a plain
    // ask is shared, and it keeps one member for an older server.
    ...(
      [
        ["list", { otherMemberUserIds: ["u2", "u3"] }, true],
        ["room", { room: true }, true],
        ["list that is not an array", { otherMemberUserIds: "u2" }, false],
        ["list with an empty id", { otherMemberUserIds: ["u2", ""] }, false],
        ["list with a non-string id", { otherMemberUserIds: ["u2", 3] }, false],
        ["room that is not true", { room: false }, false],
        ["room as a string", { room: "true" }, false],
        ["room and a list", { room: true, otherMemberUserIds: ["u2"] }, false],
        [
          "list on a secret",
          {
            otherMemberUserIds: ["u2"],
            secret: { ...SECRET, scope: "personal" },
          },
          false,
        ],
        [
          "room on a secret",
          { room: true, secret: { ...SECRET, scope: "personal" } },
          false,
        ],
        [
          "list on a draft",
          { otherMemberUserIds: ["u2"], messaging: DRAFT },
          false,
        ],
        ["room on a draft", { room: true, messaging: DRAFT }, false],
        [
          "list on a step",
          { otherMemberUserIds: ["u2"], step: { kind: "browser-pairing" } },
          false,
        ],
        [
          "room on a step",
          { room: true, step: { kind: "browser-pairing" } },
          false,
        ],
      ] as const
    ).map(([label, fields, loads]): [string, unknown, boolean] => [
      label,
      { ...BASE, memberUserId: "u1", ...fields },
      loads,
    ]),
    ["room with no member", { ...BASE, room: true }, false],
    ["list with no member", { ...BASE, otherMemberUserIds: ["u2"] }, false],
  ];
  for (const [label, entry, loads] of shapes)
    it(`${loads ? "loads" : "moves aside"} a file with a ${label} entry`, () => {
      const { dir, path } = fileIn();
      writeFileSync(path, JSON.stringify([entry]));
      const store = createAskStore({
        persistence: createAskFilePersistence(path),
      });
      expect(store.listAll().length).toBe(loads ? 1 : 0);
      expect(
        readdirSync(dir).some((f) => f.startsWith("asks.json.corrupt-")),
      ).toBe(!loads);
    });

  it("keeps a referenced read file's path through a write and a load", () => {
    const { path } = fileIn();
    const first = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    const made = first.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
      affordances: { readFiles: [AFFORDANCES.readFiles[0], REFERENCE] },
    });
    if (!made.ok) throw new Error("create failed");
    const second = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(second.get(made.entry.id)?.readFiles).toEqual([
      AFFORDANCES.readFiles[0],
      REFERENCE,
    ]);
  });

  it("keeps a WhatsApp reply draft through a write and a load", () => {
    const { path } = fileIn();
    const first = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    const made = first.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Send this?",
      options: ["Send", "Don't send"],
      messaging: DRAFT,
    });
    if (!made.ok) throw new Error("create failed");
    expect(made.entry.messaging).toEqual(DRAFT);
    const second = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(second.get(made.entry.id)?.messaging).toEqual(DRAFT);
  });

  it("keeps a shared ask's members and room mark through a write and a load (task 9461c464)", () => {
    const { path } = fileIn();
    const first = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    const list = first.create({
      agentId: "a1",
      memberUserId: "u1",
      otherMemberUserIds: ["u3", "u2"],
      prompt: "Who takes it?",
    });
    const room = first.create({
      agentId: "a1",
      memberUserId: "u1",
      room: true,
      prompt: "Anyone?",
    });
    if (!list.ok || !room.ok) throw new Error("create failed");
    const second = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    const reread = (id: string) => {
      const e = second.get(id);
      return [e?.memberUserId, e?.otherMemberUserIds ?? null, e?.room ?? null];
    };
    expect(reread(list.entry.id)).toEqual(["u1", ["u3", "u2"], null]);
    expect(reread(room.entry.id)).toEqual(["u1", null, true]);
  });

  it("refuses to create an entry of no shape, and writes nothing", () => {
    const { path } = fileIn();
    const store = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    expect(() =>
      store.create({
        agentId: "a1",
        prompt: "Go?",
        secret: { ...SECRET, scope: "personal" },
      }),
    ).toThrow();
    expect(store.listAll()).toEqual([]);
    const office = store.create({
      agentId: "a1",
      prompt: "Go?",
      secret: { ...SECRET, scope: "office" },
    });
    expect(office.ok && office.entry.memberUserId).toBe(undefined);
  });

  it("never stores a link or options on a secret request, on create or on edit", () => {
    const { path } = fileIn();
    const store = createAskStore({
      persistence: createAskFilePersistence(path),
    });
    const secret = { ...SECRET, scope: "personal" as const };
    const ask = { agentId: "a1", memberUserId: "u1", prompt: "Go?", secret };
    expect(() =>
      store.create({ ...ask, link: "/integrations/secrets" }),
    ).toThrow();
    expect(() =>
      store.create({ ...ask, options: ["Save", "Decline"] }),
    ).toThrow();
    expect(store.listAll()).toEqual([]);
    const made = store.create(ask);
    if (!made.ok) throw new Error("create failed");
    expect(() =>
      store.edit(made.entry.id, "Go?", "/integrations/secrets"),
    ).toThrow();
    expect(() =>
      store.edit(made.entry.id, "Go?", undefined, ["Save", "Decline"]),
    ).toThrow();
    expect(store.get(made.entry.id)).toEqual(made.entry);
  });
});

describe("an ask's options", () => {
  it("checks the count, emptiness, length and repeats, after a trim", () => {
    expect(checkOptions([" Jim ", "Dwight"])).toEqual({
      ok: true,
      options: ["Jim", "Dwight"],
    });
    // One option is the "do this, then tell me" ask: its button sends it.
    expect(checkOptions([" Done "])).toEqual({ ok: true, options: ["Done"] });
    const atBounds = "abcdefghij".split("").map((c) => c.repeat(80));
    expect(checkOptions(atBounds)).toEqual({ ok: true, options: atBounds });
    // An 80-character option with spaces around it is in bounds.
    expect(checkOptions([` ${"a".repeat(80)} `, "b"]).ok).toBe(true);
    for (const bad of [
      [],
      "abcdefghijk".split(""),
      ["a", "   "],
      ["a", "b".repeat(81)],
      ["a", " a"],
      ["a", 1],
      "a",
      undefined,
    ])
      expect(`${JSON.stringify(bad)} ${checkOptions(bad).ok}`).toBe(
        `${JSON.stringify(bad)} false`,
      );
  });
});

describe("who sees an ask", () => {
  const audience = (over: Partial<AskAudienceDeps> = {}): AskAudienceDeps => ({
    isOfficeOwner: (userId) => userId === "u-owner",
    agentRoomId: (agentId) => (agentId === "a1" ? "r1" : null),
    canSeeRoom: () => true,
    roomHidden: () => false,
    roomMemberIds: () => [],
    ...over,
  });
  const plain: AskEntry = { ...BASE, memberUserId: "u1" };
  const personal: AskEntry = {
    ...plain,
    secret: { ...SECRET, scope: "personal" },
  };
  const office: AskEntry = { ...BASE, secret: { ...SECRET, scope: "office" } };

  it("a plain or personal secret ask: the member it names, nobody else", () => {
    for (const entry of [plain, personal]) {
      expect(askVisibleTo(entry, "u1", audience())).toBe(true);
      expect(askVisibleTo(entry, "u-owner", audience())).toBe(false);
      expect(askVisibleTo(entry, null, audience())).toBe(false);
    }
  });

  it("an office secret ask: every office owner, and no other member", () => {
    expect(askVisibleTo(office, "u-owner", audience())).toBe(true);
    expect(askVisibleTo(office, "u1", audience())).toBe(false);
    expect(askVisibleTo(office, null, audience())).toBe(false);
    // Read live: an owner who is demoted stops seeing it.
    expect(
      askVisibleTo(office, "u-owner", audience({ isOfficeOwner: () => false })),
    ).toBe(false);
  });

  it("needs the agent and its room, for an owner too", () => {
    const noRoom = audience({ canSeeRoom: () => false });
    expect(askVisibleTo(plain, "u1", noRoom)).toBe(false);
    expect(askVisibleTo(office, "u-owner", noRoom)).toBe(false);
    expect(
      askVisibleTo({ ...office, agentId: "gone" }, "u-owner", audience()),
    ).toBe(false);
  });
});

// A shared ask (task 9461c464): named members, or everyone who reaches the
// agent's room and does not hide it, read live.
describe("who a shared ask is for", () => {
  // Room r1 holds a1; u1, u2, u3 and u-owner reach it, u-out does not.
  const reach = new Set(["u1", "u2", "u3", "u-owner"]);
  const audience = (
    hidden: string[] = [],
    over: Partial<AskAudienceDeps> = {},
  ): AskAudienceDeps => ({
    isOfficeOwner: (userId) => userId === "u-owner",
    agentRoomId: (agentId) => (agentId === "a1" ? "r1" : null),
    canSeeRoom: (userId, roomId) => roomId === "r1" && reach.has(userId),
    roomHidden: (userId, roomId) => roomId === "r1" && hidden.includes(userId),
    roomMemberIds: (roomId) => (roomId === "r1" ? [...reach] : []),
    ...over,
  });
  const list: AskEntry = {
    ...BASE,
    memberUserId: "u1",
    otherMemberUserIds: ["u3", "u2"],
  };
  const room: AskEntry = { ...BASE, memberUserId: "u1", room: true };
  const sees = (entry: AskEntry, deps: AskAudienceDeps) =>
    ["u1", "u2", "u3", "u-owner", "u-out"].filter((u) =>
      askVisibleTo(entry, u, deps),
    );

  it("a list: its members in the order the agent named them, each while they reach the room, hidden or not", () => {
    expect(askMemberIds(list, audience())).toEqual(["u1", "u3", "u2"]);
    expect(sees(list, audience())).toEqual(["u1", "u2", "u3"]);
    // The agent named them: hiding the room does not take it away.
    expect(sees(list, audience(["u1", "u2", "u3"]))).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
    // Read live: a member who loses the room stops seeing it.
    expect(
      sees(
        list,
        audience([], { canSeeRoom: (u) => reach.has(u) && u !== "u3" }),
      ),
    ).toEqual(["u1", "u2"]);
  });

  it("a plain ask is for its one member", () => {
    expect(askMemberIds({ ...BASE, memberUserId: "u2" }, audience())).toEqual([
      "u2",
    ]);
  });

  it("a room ask: everyone who reaches the room and does not hide it, read live; the stored member is not special", () => {
    expect([...askMemberIds(room, audience())].sort()).toEqual([
      "u-owner",
      "u1",
      "u2",
      "u3",
    ]);
    expect(sees(room, audience())).toEqual(["u1", "u2", "u3", "u-owner"]);
    // u1 is the stored member, and hiding the room takes it away from them
    // too; an owner who hides it does not get it either.
    const hidden = audience(["u1", "u-owner"]);
    expect([...askMemberIds(room, hidden)].sort()).toEqual(["u2", "u3"]);
    expect(sees(room, hidden)).toEqual(["u2", "u3"]);
    // A member who reaches the room later gets it.
    const joined = audience([], {
      canSeeRoom: (u, r) => r === "r1" && (reach.has(u) || u === "u-out"),
      roomMemberIds: () => [...reach, "u-out"],
    });
    expect(askMemberIds(room, joined)).toContain("u-out");
    expect(askVisibleTo(room, "u-out", joined)).toBe(true);
    // Everyone hides it: open for nobody.
    expect(askMemberIds(room, audience(["u1", "u2", "u3", "u-owner"]))).toEqual(
      [],
    );
    // The agent is gone: no room, nobody.
    expect(askMemberIds({ ...room, agentId: "gone" }, audience())).toEqual([]);
  });

  it("the owners' view of other members' asks: a list once for an owner it does not name, a room ask never", () => {
    // Not named: the owner sees it as another member's ask.
    expect(askShownToOwnerAsOther(list, "u-owner", audience())).toBe(true);
    // Named: it is their own ask, not another member's.
    const named: AskEntry = { ...list, otherMemberUserIds: ["u-owner"] };
    expect(askVisibleTo(named, "u-owner", audience())).toBe(true);
    expect(askShownToOwnerAsOther(named, "u-owner", audience())).toBe(false);
    // An owner who hides the room does not get a room ask back this way.
    expect(askShownToOwnerAsOther(room, "u-owner", audience(["u-owner"]))).toBe(
      false,
    );
    expect(askShownToOwnerAsOther(room, "u-owner", audience())).toBe(false);
    expect(askVisibleTo(room, "u-owner", audience())).toBe(true);
  });

  it("a token limited to other rooms reaches no one through a room ask", () => {
    const token = {
      scope: "api",
      userId: "u2",
      role: "member",
      capabilities: API_CAPABILITIES,
      apiTokenLimits: { rooms: ["r2"] },
    } as Identity;
    const limited = askAudienceFor(audience(), token);
    expect(askMemberIds(room, limited)).toEqual([]);
    expect(askVisibleTo(room, "u2", limited)).toBe(false);
    const inRoom = askAudienceFor(audience(), {
      ...token,
      apiTokenLimits: { rooms: ["r1"] },
    } as Identity);
    expect(askVisibleTo(room, "u2", inRoom)).toBe(true);
  });

  it("the wire names every member by current name, first member as `member`, and marks a room ask", () => {
    const names: Record<string, string> = {
      u1: "ana",
      u2: "bo",
      u3: "cy",
      "u-owner": "nil",
    };
    const name = (u: string) => names[u] ?? null;
    const listed = askAgentWire(list, name, audience());
    expect([listed.member, listed.members, listed.room ?? null]).toEqual([
      "ana",
      ["ana", "cy", "bo"],
      null,
    ]);
    const roomWire = askAgentWire(room, name, audience(["u1"]));
    expect([[...(roomWire.members ?? [])].sort(), roomWire.room]).toEqual([
      ["bo", "cy", "nil"],
      true,
    ]);
    // `member` is the first of `members` for an older reader.
    expect(roomWire.member).toBe(roomWire.members?.[0] ?? null);
    // Open for nobody now: no names, and `member` falls back to the stored one.
    const empty = askAgentWire(
      room,
      name,
      audience(["u1", "u2", "u3", "u-owner"]),
    );
    expect([empty.members, empty.member]).toEqual([[], "ana"]);
  });
});

describe("the note before the member's words", () => {
  it("names the ask, quotes the whole prompt and tells a dismiss from a reply", () => {
    const long = `${"word ".repeat(100)}\n- option one\n- option two`;
    const note = askReplyNote({ id: "abcd1234", prompt: long });
    expect(note).toContain("abcd1234");
    const quoted = JSON.parse(
      note.slice(note.indexOf('"'), note.lastIndexOf('"') + 1),
    );
    expect(quoted).toBe(long.trim());
    expect(note).not.toContain("\n");
    expect(
      askReplyNote({ id: "abcd1234", prompt: "x", sessionId: "s-1" }, "s-1"),
    ).toBe(askReplyNote({ id: "abcd1234", prompt: "x" }));
    expect(
      askReplyNote({ id: "abcd1234", prompt: "x", sessionId: "s-1" }, "s-2"),
    ).toContain("s-1");
    expect(
      askReplyNote({ id: "abcd1234", prompt: "x", sessionId: "s-1" }, null),
    ).toContain("s-1");
    expect(
      askReplyNote({ id: "abcd1234", prompt: "x", dismissed: true }),
    ).not.toBe(askReplyNote({ id: "abcd1234", prompt: "x" }));
  });

  // And its withdrawal (task fc2021b7).
  it("tells a simplify request and its withdrawal from each other and from a reply, a dismiss and a filed task, for an app's ask too", () => {
    const ask = { id: "abcd1234", prompt: "Ship it?" };
    const app = { name: "triage-bot" };
    const notes = (flag: { simplify: true } | { simplifyUndone: true }) => {
      const note = askReplyNote({ ...ask, ...flag });
      expect(note).toContain("abcd1234");
      expect(note).toContain(JSON.stringify("Ship it?"));
      for (const other of [
        askReplyNote(ask),
        askReplyNote({ ...ask, dismissed: true }),
        askReplyNote({ ...ask, taskId: "feed0001" }),
      ])
        expect(note).not.toBe(other);
      const appNote = askReplyNote({ ...ask, ...flag, app });
      expect(appNote).toContain("triage-bot");
      expect(appNote).not.toBe(askReplyNote({ ...ask, app }));
      expect(appNote).not.toBe(askReplyNote({ ...ask, dismissed: true, app }));
      expect(
        askReplyNote({ ...ask, ...flag, sessionId: "s-1" }, "s-2"),
      ).toContain("s-1");
      return [note, appNote];
    };
    const [simplify, appSimplify] = notes({ simplify: true });
    const [undone, appUndone] = notes({ simplifyUndone: true });
    expect(undone).not.toBe(simplify);
    expect(appUndone).not.toBe(appSimplify);
  });

  it("names the task an ask was filed as, apart from a reply and a dismiss", () => {
    const filed = askReplyNote({
      id: "abcd1234",
      prompt: "Ship it?",
      taskId: "feed0001",
    });
    expect(filed).toContain("abcd1234");
    expect(filed).toContain("feed0001");
    expect(filed).toContain(JSON.stringify("Ship it?"));
    expect(filed).not.toBe(
      askReplyNote({ id: "abcd1234", prompt: "Ship it?" }),
    );
    expect(filed).not.toBe(
      askReplyNote({ id: "abcd1234", prompt: "Ship it?", dismissed: true }),
    );
    // The opening session is still named when the note reaches a later one.
    expect(
      askReplyNote(
        { id: "abcd1234", prompt: "x", taskId: "feed0001", sessionId: "s-1" },
        "s-2",
      ),
    ).toContain("s-1");
  });
});

describe("the task an ask is filed as", () => {
  const ask = (over: Partial<AskEntry>): AskEntry => ({
    id: "abcd1234",
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Ship it?",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  const codePoints = (s: string) => Array.from(s).length;
  const loneSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("takes the title from the prompt's first non-blank line, whitespace collapsed", () => {
    const { title } = askTaskFields(
      ask({ prompt: "\n  \n  Ship   the\tbuild?  \nThe tests are green." }),
      "Asker",
    );
    expect(title).toBe("Ship the build?");
  });

  it("cuts a long first line by code points, never through a character", () => {
    // An exact fit stays whole.
    const fits = "a".repeat(ASK_TASK_TITLE_MAX);
    expect(askTaskFields(ask({ prompt: fits }), "Asker").title).toBe(fits);
    // An emoji (two UTF-16 units) sits across the cut: a cut by units would
    // split it.
    const line = `${"a".repeat(ASK_TASK_TITLE_MAX - 2)}${"😀".repeat(20)}`;
    const { title } = askTaskFields(ask({ prompt: line }), "Asker");
    expect(loneSurrogate.test(title)).toBe(false);
    expect(codePoints(title)).toBeLessThanOrEqual(ASK_TASK_TITLE_MAX);
    // A visible cut: the title is shorter than the line and ends with a mark
    // that is not the line's own text.
    const kept = Array.from(title).slice(0, -1).join("");
    expect(line.startsWith(kept)).toBe(true);
    expect(codePoints(kept)).toBeGreaterThanOrEqual(ASK_TASK_TITLE_MAX - 2);
    expect(line.startsWith(title)).toBe(false);
  });

  it("holds the whole prompt first, then what the card showed, then where it came from", () => {
    const prompt = "Merge the branch?\n\nCI is green on 807b5ad5.";
    const full = ask({
      prompt,
      options: ["Merge now", "Wait for Nil"],
      recommended: "Wait for Nil",
      link: "/tasks",
      commands: ["git log --oneline -3"],
      editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
      readFiles: [
        {
          filename: "ab12.png",
          originalName: "plot.png",
          mediaType: "image/png",
          size: 7,
        },
        REFERENCE,
      ],
    });
    const { description } = askTaskFields(full, "Asker");
    expect(description.startsWith(prompt)).toBe(true);
    const lines = description.split("\n");
    for (const part of [
      "Merge now",
      "Wait for Nil",
      "/tasks",
      "git log --oneline -3",
      "/w/notes.md",
      "plot.png",
      // A reference by its path: the task outlives the ask, and the path is
      // the way back to the file.
      REFERENCE.path,
    ])
      expect([part, lines.filter((l) => l.includes(part)).length]).toEqual([
        part,
        1,
      ]);
    // The recommended option is marked: its line changes with the mark, the
    // other option's line does not.
    const unmarked = askTaskFields(
      { ...full, recommended: undefined },
      "Asker",
    ).description.split("\n");
    const lineOf = (ls: string[], part: string) =>
      ls.find((l) => l.includes(part));
    expect(lineOf(lines, "Merge now")).toBe(lineOf(unmarked, "Merge now"));
    expect(lineOf(lines, "Wait for Nil")).not.toBe(
      lineOf(unmarked, "Wait for Nil"),
    );
    // The last line names the agent and the ask.
    const last = lines[lines.length - 1];
    expect(last).toContain("Asker");
    expect(last).toContain("abcd1234");
  });

  it("adds the member's note when there is one, and nothing for a bare ask", () => {
    const bare = askTaskFields(ask({}), "Asker").description;
    const noted = askTaskFields(ask({}), "Asker", "After the launch.");
    expect(noted.description).toContain("After the launch.");
    expect(bare).not.toContain("After the launch.");
    // A bare ask is the prompt and the line it came from, nothing else.
    expect(bare.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
    // The note does not change the title.
    expect(noted.title).toBe("Ship it?");
  });
});

describe("the member's runs of an ask's commands (task c3b91695)", () => {
  const run = (
    command: string,
    over: Partial<AskCommandRun> = {},
  ): AskCommandRun => ({
    command,
    by: "u1",
    startedAt: 1,
    state: "running",
    ...over,
  });
  function storeWith(commands: string[]) {
    const { path } = fileIn();
    const changes: AskChange[] = [];
    const store = createAskStore({
      persistence: createAskFilePersistence(path),
      onChange: (c) => changes.push(c),
    });
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Run the checks?",
      affordances: { commands },
    });
    if (!made.ok) throw new Error("create failed");
    const reopen = () =>
      createAskStore({ persistence: createAskFilePersistence(path) });
    return { store, id: made.entry.id, changes, reopen };
  }

  it("keeps one run per command, persists it and pushes the entry", () => {
    const { store, id, changes, reopen } = storeWith(["bun test", "bun lint"]);
    changes.length = 0;
    expect(store.setRun(id, "bun test", run("bun test"))).not.toBeNull();
    store.setRun(id, "bun lint", run("bun lint"));
    const done = run("bun test", {
      state: "done",
      exitCode: 0,
      output: "ok\n",
    });
    store.setRun(id, "bun test", done);
    const runs = store.get(id)!.runs ?? [];
    expect(runs.filter((r) => r.command === "bun test")).toEqual([done]);
    expect(runs.map((r) => r.command).sort()).toEqual(["bun lint", "bun test"]);
    expect(changes.map((c) => c.kind)).toEqual([
      "upserted",
      "upserted",
      "upserted",
    ]);
    expect(changes.at(-1)!.entry.runs).toEqual(runs);
    expect(reopen().get(id)!.runs).toEqual(runs);

    // Null takes the command's run back; the other stays.
    store.setRun(id, "bun test", null);
    expect(store.get(id)!.runs?.map((r) => r.command)).toEqual(["bun lint"]);
  });

  it("writes nothing for a command the ask does not list, or an ask that is gone", () => {
    const { store, id, changes } = storeWith(["bun test"]);
    changes.length = 0;
    expect(store.setRun(id, "rm -rf ~", run("rm -rf ~"))).toBeNull();
    expect(store.setRun("nosuchid", "bun test", run("bun test"))).toBeNull();
    expect(store.get(id)!.runs ?? []).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("an agent edit that drops a command drops its run, and keeps the others", () => {
    const { store, id } = storeWith(["bun test", "bun lint"]);
    store.setRun(
      id,
      "bun test",
      run("bun test", { state: "done", exitCode: 1 }),
    );
    store.setRun(id, "bun lint", run("bun lint"));
    store.edit(id, "Run the lint?", undefined, undefined, {
      commands: ["bun lint", "bun typecheck"],
    });
    expect(store.get(id)!.runs?.map((r) => r.command)).toEqual(["bun lint"]);
    // A prompt-only edit keeps every run.
    store.edit(id, "Run it now?");
    expect(store.get(id)!.runs?.map((r) => r.command)).toEqual(["bun lint"]);
  });

  it("at boot, marks each running run lost, leaves a finished one, and persists it", () => {
    const { store, id, reopen } = storeWith(["bun test", "bun lint"]);
    const finished = run("bun lint", { state: "done", exitCode: 0 });
    store.setRun(id, "bun test", run("bun test"));
    store.setRun(id, "bun lint", finished);
    const booted = reopen();
    const marked = booted.markLostRuns();
    expect(marked.map((m) => [m.entry.id, m.run.command, m.run.state])).toEqual(
      [[id, "bun test", "lost"]],
    );
    const runs = booted.get(id)!.runs ?? [];
    expect(runs.find((r) => r.command === "bun test")?.state).toBe("lost");
    expect(runs.find((r) => r.command === "bun lint")).toEqual(finished);
    expect(reopen().markLostRuns()).toEqual([]);
  });
});
