// The ask store's load posture, the three shapes of an entry, who sees an
// ask, and the note the agent reads.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AskCommandRun,
  AskEntry,
  AskEvent,
  PagerDelivery,
} from "../shared/types.ts";
import { createAskHistory, type AskHistory } from "./ask-history.ts";
import { openOfficeDatabase } from "./audit-store.ts";
import { API_CAPABILITIES, type Identity } from "./identity/index.ts";
import {
  ASK_PAGES_MAX_OPEN_PER_SOURCE,
  ASK_TASK_TITLE_MAX,
  askAgentWire,
  askMemberWire,
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
const SUDO = { requestId: "req-2", command: "apt update", cwd: "/w" };
const OFFICE_SRC = { feature: "whatsapp", name: "WhatsApp" };
const APP_SRC = { name: "uptime", createdAt: 7 };
const RINGING = {
  state: "ringing",
  delivery: { u1: { state: "not_delivered", sends: 0 } },
};
// The send records of a paged ask that rings for u1 and u2.
const SENDS = {
  u1: { state: "not_delivered", sends: 0 },
  u2: { state: "delivered", sends: 2, lastAttemptAt: 9 },
};
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
    // A secret request's own link to an outside page (task 0355f4b7) sits
    // in the request, so an older server loads it. Its form is checked on
    // write only, as the ask's link is.
    [
      "secret whose request links an outside page",
      {
        ...BASE,
        memberUserId: "u1",
        secret: {
          ...SECRET,
          scope: "personal",
          link: "https://github.com/settings/tokens/new",
        },
      },
      true,
    ],
    [
      "secret whose request link this release would refuse",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal", link: "http://example.com" },
      },
      true,
    ],
    [
      "secret whose request link is not a string",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal", link: 1 },
      },
      false,
    ],
    [
      "secret whose request link is empty",
      {
        ...BASE,
        memberUserId: "u1",
        secret: { ...SECRET, scope: "personal", link: "" },
      },
      false,
    ],
    // A Discord bot request's application id (task f242899f): a string
    // loads, the snowflake check is on write only, as a link's is.
    [
      "Discord bot request with an application id",
      {
        ...BASE,
        memberUserId: "u1",
        secret: {
          ...SECRET,
          scope: "personal",
          kind: "discord-bot",
          applicationId: "1100000000000000001",
        },
      },
      true,
    ],
    [
      "Discord bot request whose application id this release would refuse",
      {
        ...BASE,
        memberUserId: "u1",
        secret: {
          ...SECRET,
          scope: "personal",
          kind: "discord-bot",
          applicationId: "not-a-snowflake",
        },
      },
      true,
    ],
    [
      "Discord bot request whose application id is not a string",
      {
        ...BASE,
        memberUserId: "u1",
        secret: {
          ...SECRET,
          scope: "personal",
          kind: "discord-bot",
          applicationId: 2 ** 60,
        },
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
    // A paged ask (task 74e8fc07): an alarm, ringing or acked, with one send
    // record per recipient.
    ...(
      [
        [
          "ringing paged",
          { page: { state: "ringing", delivery: SENDS } },
          true,
        ],
        [
          "acked paged",
          {
            page: {
              state: "acked",
              ackedByUserId: "u1",
              ackedAt: 5,
              delivery: SENDS,
            },
          },
          true,
        ],
        [
          "paged room",
          { room: true, page: { state: "ringing", delivery: SENDS } },
          true,
        ],
        [
          "paged with no recipient",
          { page: { state: "ringing", delivery: {} } },
          true,
        ],
        [
          "page in an unknown state",
          { page: { state: "silenced", delivery: SENDS } },
          false,
        ],
        [
          "ringing page naming who acked",
          {
            page: {
              state: "ringing",
              ackedByUserId: "u1",
              ackedAt: 5,
              delivery: SENDS,
            },
          },
          false,
        ],
        ["page with no send records", { page: { state: "ringing" } }, false],
        [
          "page with a bad send record",
          { page: { state: "ringing", delivery: { u1: { sends: "1" } } } },
          false,
        ],
        [
          "paged personal secret",
          {
            secret: { ...SECRET, scope: "personal" },
            page: { state: "ringing", delivery: SENDS },
          },
          false,
        ],
        [
          "paged reply draft",
          {
            options: ["Send", "Don't send"],
            messaging: DRAFT,
            page: { state: "ringing", delivery: SENDS },
          },
          false,
        ],
        // Slice 3: the page id, the raise count and the last raise, each
        // optional (a page from slice 1 or 2 has none); a migrated page acked
        // by no member names "".
        [
          "page with its page id, raise count and last raise",
          {
            page: {
              state: "ringing",
              pageId: "00112233aabbccdd",
              raiseCount: 3,
              lastRaisedAt: 7,
              delivery: SENDS,
            },
          },
          true,
        ],
        [
          "page acked by no member",
          {
            page: {
              state: "acked",
              pageId: "00112233aabbccdd",
              ackedByUserId: "",
              ackedAt: 5,
              delivery: SENDS,
            },
          },
          true,
        ],
        [
          "page with an empty page id",
          { page: { state: "ringing", pageId: "", delivery: SENDS } },
          false,
        ],
        [
          "page with a numeric page id",
          { page: { state: "ringing", pageId: 7, delivery: SENDS } },
          false,
        ],
        [
          "page with a text raise count",
          { page: { state: "ringing", raiseCount: "2", delivery: SENDS } },
          false,
        ],
        [
          "page with a text last raise",
          { page: { state: "ringing", lastRaisedAt: "9", delivery: SENDS } },
          false,
        ],
        // The sudo row loads, so its paged twin fails on the page alone.
        ["sudo", { sudo: SUDO }, true],
        [
          "paged sudo",
          { sudo: SUDO, page: { state: "ringing", delivery: SENDS } },
          false,
        ],
      ] as [string, Record<string, unknown>, boolean][]
    ).map(([label, fields, loads]): [string, unknown, boolean] => [
      label,
      { ...BASE, memberUserId: "u1", ...fields },
      loads,
    ]),
    // An ask with no agent (task 74e8fc07, slice 2): agentId "", one member,
    // a page, and its source: an office feature or an app.
    ...(
      [
        ["office page", { office: OFFICE_SRC, page: RINGING }, true],
        ["agentless app page", { app: APP_SRC, page: RINGING }, true],
        ["agentless ask with no page", { office: OFFICE_SRC }, false],
        ["agentless page with no source", { page: RINGING }, false],
        [
          "agentless page with both sources",
          { office: OFFICE_SRC, app: APP_SRC, page: RINGING },
          false,
        ],
        [
          "office page for a room",
          { office: OFFICE_SRC, room: true, page: RINGING },
          false,
        ],
        [
          "office page for a member list",
          { office: OFFICE_SRC, otherMemberUserIds: ["u2"], page: RINGING },
          false,
        ],
        [
          "office page with options",
          { office: OFFICE_SRC, options: ["Fix it"], page: RINGING },
          false,
        ],
        [
          "office page with a link",
          { office: OFFICE_SRC, link: "/integrations", page: RINGING },
          false,
        ],
        [
          "office page with commands",
          { office: OFFICE_SRC, commands: ["bun test"], page: RINGING },
          false,
        ],
        [
          "office page with no member",
          { office: OFFICE_SRC, memberUserId: undefined, page: RINGING },
          false,
        ],
      ] as [string, Record<string, unknown>, boolean][]
    ).map(([label, fields, loads]): [string, unknown, boolean] => [
      label,
      { ...BASE, agentId: "", memberUserId: "u1", ...fields },
      loads,
    ]),
    // The office source is for an ask with no agent only.
    [
      "office source on an agent's ask",
      { ...BASE, memberUserId: "u1", office: OFFICE_SRC, page: RINGING },
      false,
    ],
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
    const hidden = audience(["u1", "u2", "u3"]);
    expect(askMemberIds(list, hidden)).toEqual(["u1", "u3", "u2"]);
    expect(sees(list, hidden)).toEqual(["u1", "u2", "u3"]);
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

  it("a plain, personal secret or sudo ask is for the member it names, hidden or not", () => {
    const plain: AskEntry = { ...BASE, memberUserId: "u2" };
    const personal: AskEntry = {
      ...plain,
      secret: { ...SECRET, scope: "personal" },
    };
    const sudo: AskEntry = {
      ...plain,
      sudo: { requestId: "req-2", command: "apt update", cwd: "/w" },
    };
    for (const entry of [plain, personal, sudo]) {
      expect(askMemberIds(entry, audience(["u2"]))).toEqual(["u2"]);
      expect(askVisibleTo(entry, "u2", audience(["u2"]))).toBe(true);
    }
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

  it("an owner who hides the room: a named ask is still theirs and another member's list still in the owners' view; a room ask is in neither", () => {
    const hides = audience(["u-owner"]);
    const named: AskEntry = { ...list, otherMemberUserIds: ["u-owner"] };
    expect(askVisibleTo(named, "u-owner", hides)).toBe(true);
    expect(askShownToOwnerAsOther(named, "u-owner", hides)).toBe(false);
    expect(askShownToOwnerAsOther(list, "u-owner", hides)).toBe(true);
    expect(askVisibleTo(room, "u-owner", hides)).toBe(false);
    expect(askShownToOwnerAsOther(room, "u-owner", hides)).toBe(false);
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

// A paged ask (task 74e8fc07): an ask with an alarm. Its recipients are fixed
// at create; an ack stops the alarm and keeps the ask open; the delivery
// engines record each recipient's sends on it; every close of a paged ask
// tells them (onPage). Seam: the store on a temp file, with the history and
// onPage as recording fakes.
describe("a paged ask (task 74e8fc07)", () => {
  function pagedStore(start = 1_000) {
    const { path } = fileIn();
    let t = start;
    const changes: AskChange[] = [];
    const pages: string[] = [];
    const events: { askId: string; kind: string; byUserId?: string }[] = [];
    const history = {
      record: () => {},
      recordEvent: (_agentId: string, askId: string, event: AskEvent) =>
        events.push({
          askId,
          kind: event.kind,
          ...("byUserId" in event && event.byUserId
            ? { byUserId: event.byUserId }
            : {}),
        }),
      has: () => false,
      recordPage: () => {},
      pageAskId: () => null,
    } as unknown as AskHistory;
    const throwing = { onPage: false };
    const open = () =>
      createAskStore({
        persistence: createAskFilePersistence(path),
        now: () => t,
        history,
        onChange: (c) => changes.push(c),
        onPage: (entry, event) => {
          pages.push(`${event} ${entry.id}`);
          if (throwing.onPage) throw new Error("listener down");
        },
      });
    const store = open();
    const paged = (over: Partial<Parameters<typeof store.create>[0]> = {}) => {
      const made = store.create({
        agentId: "a1",
        memberUserId: "u1",
        otherMemberUserIds: ["u2"],
        prompt: "Restart the box?",
        page: { recipients: ["u1", "u2"] },
        ...over,
      });
      if (!made.ok) throw new Error(`create failed: ${made.code}`);
      return made.entry;
    };
    return {
      store,
      paged,
      reopen: open,
      changes,
      pages,
      events,
      throwing,
      tick: (ms: number) => (t += ms),
      now: () => t,
    };
  }

  const NONE: PagerDelivery = { state: "not_delivered", sends: 0 };

  it("rings at create, with one empty send record per recipient, and tells onPage once", () => {
    const { store, paged, pages, reopen } = pagedStore();
    const plain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    expect(plain.ok).toBe(true);
    expect(pages).toEqual([]);
    const entry = paged();
    expect(entry.page).toEqual({
      state: "ringing",
      pageId: expect.stringMatching(/^[0-9a-f]{16}$/),
      delivery: { u1: NONE, u2: NONE },
    });
    expect(pages).toEqual([`created ${entry.id}`]);
    expect(reopen().get(entry.id)?.page).toEqual(entry.page);
  });

  it("an onPage listener that throws does not undo the create", () => {
    const { store, paged, throwing } = pagedStore();
    throwing.onPage = true;
    const entry = paged();
    expect(store.get(entry.id)?.page?.state).toBe("ringing");
  });

  it("holds at most 50 open paged asks per agent, apart from its plain asks and from an app's", () => {
    const { store, paged } = pagedStore();
    const first = paged();
    for (let i = 1; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++) paged();
    const over = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "One more?",
      page: { recipients: ["u1"] },
    });
    expect(over).toEqual({ ok: false, code: "too_many_pages" });
    // A plain ask, another agent's page and an app's page through this
    // agent are not this agent's pages.
    const kinds = [
      store.create({ agentId: "a1", memberUserId: "u1", prompt: "Plain?" }),
      store.create({
        agentId: "a2",
        memberUserId: "u1",
        prompt: "Other agent?",
        page: { recipients: ["u1"] },
      }),
      store.create({
        agentId: "a1",
        memberUserId: "u1",
        prompt: "From the app?",
        app: { name: "uptime", createdAt: 7 },
        page: { recipients: ["u1"] },
      }),
    ];
    expect(kinds.map((r) => r.ok)).toEqual([true, true, true]);
    // A closed page frees its place.
    store.remove(first.id, { outcome: "withdrawn" });
    expect(paged().page?.state).toBe("ringing");
  });

  it("holds at most 50 open paged asks per app registration, whatever its target agent", () => {
    const { store } = pagedStore();
    const appPage = (agentId: string, createdAt = 7) =>
      store.create({
        agentId,
        memberUserId: "u1",
        prompt: "Down?",
        app: { name: "uptime", createdAt },
        page: { recipients: ["u1"] },
      });
    for (let i = 0; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++)
      expect(appPage(i % 2 ? "a1" : "a2").ok).toBe(true);
    expect(appPage("a3")).toEqual({ ok: false, code: "too_many_pages" });
    // A later app of the same name is another source.
    expect(appPage("a3", 8).ok).toBe(true);
    // The agent itself still pages.
    expect(
      store.create({
        agentId: "a1",
        memberUserId: "u1",
        prompt: "Mine?",
        page: { recipients: ["u1"] },
      }).ok,
    ).toBe(true);
  });

  it("an ack stops the alarm and keeps the ask open; a second ack changes nothing", () => {
    const { store, paged, reopen, changes, pages, events, tick, now } =
      pagedStore();
    const entry = paged();
    changes.length = 0;
    pages.length = 0;
    events.length = 0;
    tick(500);
    const acked = store.ack(entry.id, "u2");
    expect(acked?.outcome).toBe("changed");
    expect(acked?.entry.page).toEqual({
      state: "acked",
      pageId: entry.page!.pageId,
      ackedByUserId: "u2",
      ackedAt: now(),
      delivery: entry.page!.delivery,
    });
    // The ack is not an edit.
    expect(acked?.entry.updatedAt).toBe(entry.updatedAt);
    expect(reopen().get(entry.id)?.page?.state).toBe("acked");
    expect(changes.map((c) => [c.kind, c.entry.page?.state])).toEqual([
      ["upserted", "acked"],
    ]);
    expect(pages).toEqual([`acked ${entry.id}`]);
    expect(events).toEqual([
      { askId: entry.id, kind: "acked", byUserId: "u2" },
    ]);

    tick(500);
    const again = store.ack(entry.id, "u1");
    expect(again?.outcome).toBe("unchanged");
    expect(again?.entry.page?.ackedByUserId).toBe("u2");
    expect(changes).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("acks no plain ask and no closed one", () => {
    const { store, paged, changes, events } = pagedStore();
    const plain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    if (!plain.ok) throw new Error("create failed");
    const gone = paged();
    store.remove(gone.id, { outcome: "withdrawn" });
    changes.length = 0;
    events.length = 0;
    expect(store.ack(plain.entry.id, "u1")).toBeNull();
    expect(store.ack(gone.id, "u1")).toBeNull();
    expect(store.get(plain.entry.id)?.page).toBeUndefined();
    expect([changes, events]).toEqual([[], []]);
  });

  it("records one recipient's sends durably, and tells no listener", () => {
    const { store, paged, reopen, changes, pages, events, tick } = pagedStore();
    const entry = paged();
    changes.length = 0;
    pages.length = 0;
    events.length = 0;
    tick(500);
    const sent = {
      state: "delivered" as const,
      sends: 1,
      lastAttemptAt: 1_500,
    };
    const after = store.recordPageDelivery(entry.id, "u2", sent);
    expect(after?.page?.delivery).toEqual({ u1: NONE, u2: sent });
    expect(after?.updatedAt).toBe(entry.updatedAt);
    expect(reopen().get(entry.id)?.page?.delivery.u2).toEqual(sent);
    expect([changes, pages, events]).toEqual([[], [], []]);
  });

  it("records no sends for a member it does not ring for, a plain ask or a closed one", () => {
    const { store, paged, reopen } = pagedStore();
    const entry = paged();
    const plain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    if (!plain.ok) throw new Error("create failed");
    const gone = paged();
    store.remove(gone.id, { outcome: "withdrawn" });
    const sent = { state: "delivered" as const, sends: 1 };
    expect(store.recordPageDelivery(entry.id, "u3", sent)).toBeNull();
    expect(store.recordPageDelivery(plain.entry.id, "u1", sent)).toBeNull();
    expect(store.recordPageDelivery(gone.id, "u1", sent)).toBeNull();
    const back = reopen();
    expect(Object.keys(back.get(entry.id)!.page!.delivery).sort()).toEqual([
      "u1",
      "u2",
    ]);
    expect(back.get(plain.entry.id)?.page).toBeUndefined();
  });

  it("tells onPage of every close of a paged ask, by a remove or the agent's removal, and of no plain one", () => {
    const { store, paged, pages } = pagedStore();
    const replied = paged();
    const keptA = paged({ agentId: "a2" });
    const keptB = paged({ agentId: "a2" });
    const plain = store.create({
      agentId: "a2",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    expect(plain.ok).toBe(true);
    pages.length = 0;
    store.remove(replied.id, { outcome: "replied", byUserId: "u1" });
    expect(store.removeAgent("a2")).toBe(3);
    expect(pages.sort()).toEqual(
      [
        `closed ${replied.id}`,
        `closed ${keptA.id}`,
        `closed ${keptB.id}`,
      ].sort(),
    );
  });
});

// An ask with no agent (task 74e8fc07, slice 2): the office itself (a page
// about the member's own WhatsApp or Discord link) or an app with no message
// target opens it. agentId is "" in memory and on disk, so an older release
// still loads the file. A source's key dedupes its open paged ask; a
// re-raise edits the prompt and never re-rings.
describe("an ask with no agent (task 74e8fc07)", () => {
  const WA = { feature: "whatsapp", name: "WhatsApp" };
  const DC = { feature: "discord", name: "Discord" };

  function officeStore(persistence?: AskPersistence) {
    const { path } = fileIn();
    const changes: AskChange[] = [];
    const pages: string[] = [];
    const events: { askId: string; kind: string; office?: string }[] = [];
    let saves = 0;
    const file = createAskFilePersistence(path);
    const counted: AskPersistence = persistence ?? {
      load: () => file.load(),
      save: (entries) => {
        saves++;
        file.save(entries);
      },
      quarantine: () => file.quarantine(),
    };
    const history = {
      record: () => {},
      recordEvent: (_agentId: string, askId: string, event: AskEvent) =>
        events.push({
          askId,
          kind: event.kind,
          ...(event.kind === "edited" && event.office
            ? { office: event.office }
            : {}),
        }),
      has: () => false,
      recordPage: () => {},
      pageAskId: () => null,
    } as unknown as AskHistory;
    const store = createAskStore({
      persistence: counted,
      history,
      onChange: (c) => changes.push(c),
      onPage: (entry, event) => pages.push(`${event} ${entry.id}`),
    });
    const open = (
      over: {
        memberUserId?: string;
        office?: { feature: string; name: string };
        key?: string;
        prompt?: string;
      } = {},
    ) => {
      const memberUserId = over.memberUserId ?? "u1";
      const made = store.create({
        agentId: "",
        memberUserId,
        office: over.office ?? WA,
        prompt: over.prompt ?? "WhatsApp stopped\n\nThe bridge exited.",
        priority: "P1",
        page: { recipients: [memberUserId], key: over.key ?? "k-dead" },
      });
      if (!made.ok) throw new Error(`create failed: ${made.code}`);
      return made.entry;
    };
    return {
      store,
      open,
      path,
      changes,
      pages,
      events,
      saves: () => saves,
      reopen: () =>
        createAskStore({ persistence: createAskFilePersistence(path) }),
    };
  }

  it('keeps agentId "" on disk, where a check that only asks for a string agentId and a member loads every entry', () => {
    const { open, path, reopen } = officeStore();
    const entry = open();
    expect(entry.agentId).toBe("");
    expect(entry.office).toEqual(WA);
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >[];
    // The first fields an older release's load check reads.
    expect(
      raw.every(
        (e) =>
          typeof e.id === "string" &&
          typeof e.agentId === "string" &&
          typeof e.memberUserId === "string" &&
          typeof e.prompt === "string",
      ),
    ).toBe(true);
    expect(raw[0].agentId).toBe("");
    // The key is kept with the page, for the next raise.
    expect((raw[0].page as { key?: string }).key).toBe("k-dead");
    expect(reopen().get(entry.id)?.office).toEqual(WA);
  });

  it("finds a source's open paged ask by its key, and no other source's", () => {
    const { store, open } = officeStore();
    const waU1 = open();
    open({ memberUserId: "u2" });
    open({ office: DC });
    const agentPage = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Disk full?",
      page: { recipients: ["u1"], key: "k-dead" },
    });
    if (!agentPage.ok) throw new Error("create failed");
    const appPage = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Down?",
      app: { name: "uptime", createdAt: 7 },
      page: { recipients: ["u1"], key: "k-dead" },
    });
    if (!appPage.ok) throw new Error("create failed");
    const office = (memberUserId: string, feature = "whatsapp") =>
      store.openPaged({ kind: "office", feature, memberUserId }, "k-dead")?.id;
    expect(office("u1")).toBe(waU1.id);
    expect(office("u3")).toBeUndefined();
    expect(office("u1", "discord")).not.toBe(waU1.id);
    expect(
      store.openPaged(
        { kind: "office", feature: "whatsapp", memberUserId: "u1" },
        "k-other",
      ),
    ).toBeNull();
    expect(
      store.openPaged({ kind: "agent", agentId: "a1" }, "k-dead")?.id,
    ).toBe(agentPage.entry.id);
    expect(
      store.openPaged({ kind: "app", name: "uptime", createdAt: 7 }, "k-dead")
        ?.id,
    ).toBe(appPage.entry.id);
    expect(
      store.openPaged({ kind: "app", name: "uptime", createdAt: 8 }, "k-dead"),
    ).toBeNull();
    // A closed ask is not open.
    store.remove(waU1.id, { outcome: "dismissed", byUserId: "u1" });
    expect(office("u1")).toBeUndefined();
  });

  it("a re-raise with the same text only counts the raise; new text edits it once, with the office as the actor, and never re-rings", () => {
    const { store, open, changes, pages, events, saves, reopen } =
      officeStore();
    const entry = open();
    store.ack(entry.id, "u1");
    changes.length = 0;
    pages.length = 0;
    events.length = 0;
    const before = saves();

    // Slice 3: the raise count goes up and is saved, with no event and no
    // push (the count is on no ask wire).
    const same = store.reraise(entry.id, entry.prompt, { office: "whatsapp" });
    expect(same?.outcome).toBe("unchanged");
    expect(same?.entry.page?.raiseCount).toBe(2);
    expect(saves()).toBe(before + 1);
    expect([changes, pages, events]).toEqual([[], [], []]);
    expect(reopen().get(entry.id)?.page?.raiseCount).toBe(2);

    const text = "WhatsApp stopped\n\nThe bridge exited again.";
    const changed = store.reraise(entry.id, text, { office: "whatsapp" });
    expect(changed?.outcome).toBe("changed");
    expect(changed?.entry.prompt).toBe(text);
    // An acked page stays acked, with its send records.
    expect(changed?.entry.page?.state).toBe("acked");
    expect(changed?.entry.page?.delivery).toEqual(entry.page!.delivery);
    expect(changes.map((c) => c.kind)).toEqual(["upserted"]);
    expect(pages).toEqual([]);
    expect(events).toEqual([
      { askId: entry.id, kind: "edited", office: "whatsapp" },
    ]);
    expect(reopen().get(entry.id)?.prompt).toBe(text);
  });

  it("a re-raise of a ringing page keeps it ringing; no re-raise reaches a plain or closed ask", () => {
    const { store, open } = officeStore();
    const entry = open();
    const changed = store.reraise(entry.id, "WhatsApp stopped\n\nAgain.", {
      office: "whatsapp",
    });
    expect(changed?.entry.page?.state).toBe("ringing");
    const plain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
    });
    if (!plain.ok) throw new Error("create failed");
    expect(store.reraise(plain.entry.id, "New?", { app: "uptime" })).toBeNull();
    store.remove(entry.id, { outcome: "dismissed", byUserId: "u1" });
    expect(store.reraise(entry.id, "Gone?", { office: "whatsapp" })).toBeNull();
  });

  it("holds at most 50 open office pages per feature and member, and no 500-per-agent cap applies", () => {
    const mem: AskPersistence = {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    };
    const { store, open } = officeStore(mem);
    for (let i = 0; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++)
      open({ key: `k${i}` });
    const over = store.create({
      agentId: "",
      memberUserId: "u1",
      office: WA,
      prompt: "One more",
      page: { recipients: ["u1"], key: "k-more" },
    });
    expect(over).toEqual({ ok: false, code: "too_many_pages" });
    expect(open({ memberUserId: "u2", key: "k-more" }).agentId).toBe("");
    expect(open({ office: DC, key: "k-more" }).agentId).toBe("");
    // 11 sources of 50 each: 550 open asks with agentId "".
    for (let m = 3; m <= 11; m++)
      for (let i = 0; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++)
        open({ memberUserId: `u${m}`, key: `k${i}` });
    expect(store.listAll().length).toBeGreaterThan(500);
  });
});

describe("who sees an ask with no agent (task 74e8fc07)", () => {
  // No agent has a room: agentRoomId("") is null.
  const audience: AskAudienceDeps = {
    isOfficeOwner: (userId) => userId === "u-owner",
    agentRoomId: (agentId) => (agentId === "a1" ? "r1" : null),
    canSeeRoom: () => true,
    roomHidden: () => false,
    roomMemberIds: () => [],
  };
  const office: AskEntry = {
    ...BASE,
    agentId: "",
    memberUserId: "u1",
    office: { feature: "whatsapp", name: "WhatsApp" },
    page: {
      state: "ringing",
      delivery: { u1: { state: "not_delivered", sends: 0 } },
    },
  };
  const app: AskEntry = {
    ...office,
    office: undefined,
    app: { name: "uptime", createdAt: 7 },
  };

  it("an office page: its member only, never an owner as another member's", () => {
    expect(askMemberIds(office, audience)).toEqual(["u1"]);
    expect(askVisibleTo(office, "u1", audience)).toBe(true);
    expect(askVisibleTo(office, "u2", audience)).toBe(false);
    expect(askVisibleTo(office, "u-owner", audience)).toBe(false);
    expect(askVisibleTo(office, null, audience)).toBe(false);
    expect(askShownToOwnerAsOther(office, "u-owner", audience)).toBe(false);
  });

  it("an app page with no agent: its member, and office owners as another member's", () => {
    expect(askMemberIds(app, audience)).toEqual(["u1"]);
    expect(askVisibleTo(app, "u1", audience)).toBe(true);
    expect(askVisibleTo(app, "u2", audience)).toBe(false);
    expect(askShownToOwnerAsOther(app, "u-owner", audience)).toBe(true);
    expect(askShownToOwnerAsOther(app, "u2", audience)).toBe(false);
  });
});

// Slice 3 of task 74e8fc07: every paged ask has a page id, indexed in the
// history from its create; a re-raise counts; the migration's create.
describe("a page id and a raise count (task 74e8fc07, slice 3)", () => {
  const databases: { close(): void }[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  // A store over a file and a real office database.
  // `index.fail`: each page index write throws.
  function indexed(index = { fail: false }) {
    const { dir, path } = fileIn();
    const db = openOfficeDatabase(join(dir, "office.sqlite"));
    databases.push(db);
    const real = createAskHistory(db);
    const history: AskHistory = {
      ...real,
      recordPage: (pageId, askId) => {
        if (index.fail) throw new Error("database locked");
        real.recordPage(pageId, askId);
      },
    };
    let t = 1_000;
    let saves = 0;
    const changes: AskChange[] = [];
    const events: AskEvent[] = [];
    const pages: string[] = [];
    const file = createAskFilePersistence(path);
    const open = () =>
      createAskStore({
        persistence: {
          load: () => file.load(),
          save: (entries) => {
            saves++;
            file.save(entries);
          },
          quarantine: () => file.quarantine(),
        },
        history: {
          ...history,
          recordEvent: (agentId, askId, event) => {
            events.push(event);
            history.recordEvent(agentId, askId, event);
          },
        },
        now: () => t,
        onChange: (c) => changes.push(c),
        onPage: (entry, event) => pages.push(`${event} ${entry.id}`),
      });
    const store = open();
    const paged = (over: Partial<Parameters<typeof store.create>[0]> = {}) => {
      const made = store.create({
        agentId: "a1",
        memberUserId: "u1",
        prompt: "Disk full",
        page: { recipients: ["u1"] },
        ...over,
      });
      if (!made.ok) throw new Error(`create failed: ${made.code}`);
      return made.entry;
    };
    return {
      store,
      paged,
      history: real,
      path,
      reopen: open,
      changes,
      events,
      pages,
      saves: () => saves,
      tick: (ms: number) => (t += ms),
      now: () => t,
    };
  }

  const NO_SENDS: PagerDelivery = { state: "not_delivered", sends: 0 };

  it("gives every paged ask a page id at create, indexed and kept, found by it while open; never a plain ask", () => {
    const { store, paged, history, reopen } = indexed();
    const agent = paged();
    const office = paged({
      agentId: "",
      office: { feature: "whatsapp", name: "WhatsApp" },
      page: { recipients: ["u1"], key: "k" },
    });
    const app = paged({ app: { name: "uptime", createdAt: 7 } });
    const plain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Go?",
    });
    if (!plain.ok) throw new Error("create failed");
    expect(plain.entry.page).toBeUndefined();
    const ids = [agent, office, app].map((e) => e.page?.pageId);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(3);
    for (const e of [agent, office, app]) {
      expect(history.pageAskId(e.page!.pageId!)).toBe(e.id);
      expect(store.findPaged(e.page!.pageId!)?.id).toBe(e.id);
      expect(reopen().get(e.id)?.page?.pageId).toBe(e.page!.pageId);
    }
    expect(store.findPaged("ffffffffffffffff")).toBeNull();
    store.remove(agent.id, { outcome: "dismissed", byUserId: "u1" });
    expect(store.findPaged(agent.page!.pageId!)).toBeNull();
    expect(history.pageAskId(agent.page!.pageId!)).toBe(agent.id);
  });

  it("never gives a page id an open ask or the index already holds", () => {
    const index = { fail: false };
    const { paged, history } = indexed(index);
    const real = crypto.getRandomValues.bind(crypto);
    const draws: Uint8Array[] = [];
    // Page ids are 8 random bytes; ask ids are 4 and stay random.
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array && array.length === 8 && draws.length) {
          array.set(draws.shift()!);
          return array;
        }
        return real(array as never) as T;
      },
    );
    const bytes = (b: number) => new Uint8Array(8).fill(b);
    try {
      draws.push(bytes(0x00));
      const first = paged();
      // Enabling: the store's page id came from the draw.
      expect(first.page?.pageId).toBe("0000000000000000");
      // Taken by an open ask: the next draw.
      draws.push(bytes(0x00), bytes(0x11));
      expect(paged().page?.pageId).toBe("1111111111111111");
      // Taken in the index only (a closed or migrated page).
      history.recordPage("2222222222222222", "gone-ask");
      draws.push(bytes(0x22), bytes(0x33));
      expect(paged().page?.pageId).toBe("3333333333333333");
      // Taken by an open ask whose index row did not land.
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        index.fail = true;
        draws.push(bytes(0x44));
        expect(paged().page?.pageId).toBe("4444444444444444");
        expect(history.pageAskId("4444444444444444")).toBeNull();
        index.fail = false;
        draws.push(bytes(0x44), bytes(0x55));
        expect(paged().page?.pageId).toBe("5555555555555555");
      } finally {
        errors.mockRestore();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed index write is logged and keeps the create; the boot backfill writes it later", () => {
    const index = { fail: true };
    const { paged, history, store } = indexed(index);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const entry = paged();
      expect(store.get(entry.id)?.page?.pageId).toBe(entry.page!.pageId);
      expect(history.pageAskId(entry.page!.pageId!)).toBeNull();
      expect(errors).toHaveBeenCalled();
      index.fail = false;
      store.backfillPages();
      expect(history.pageAskId(entry.page!.pageId!)).toBe(entry.id);
    } finally {
      errors.mockRestore();
    }
  });

  it("the boot backfill gives each open paged ask a page id with one save and indexes every one; a second run writes nothing", () => {
    const { dir, path } = fileIn();
    const sends = { u1: NO_SENDS };
    const old = (id: string, page: Record<string, unknown> | undefined) => ({
      id,
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Disk full",
      createdAt: 1,
      updatedAt: 1,
      ...(page ? { page } : {}),
    });
    // Two pages from a slice 1 or 2 build (no page id), one whose index row
    // never landed, and a plain ask.
    writeFileSync(
      path,
      JSON.stringify([
        old("aaaa0001", { state: "ringing", delivery: sends }),
        old("aaaa0002", {
          state: "acked",
          ackedByUserId: "u1",
          ackedAt: 3,
          delivery: sends,
        }),
        old("aaaa0003", {
          state: "ringing",
          pageId: "4444444444444444",
          delivery: sends,
        }),
        old("aaaa0004", undefined),
      ]),
    );
    const db = openOfficeDatabase(join(dir, "office.sqlite"));
    databases.push(db);
    const history = createAskHistory(db);
    const file = createAskFilePersistence(path);
    let saves = 0;
    const open = () =>
      createAskStore({
        persistence: {
          load: () => file.load(),
          save: (entries) => {
            saves++;
            file.save(entries);
          },
          quarantine: () => file.quarantine(),
        },
        history,
      });
    const store = open();
    store.backfillPages();
    expect(saves).toBe(1);
    const after = open();
    const pageIds = ["aaaa0001", "aaaa0002", "aaaa0003"].map(
      (id) => after.get(id)?.page?.pageId,
    );
    expect(pageIds[2]).toBe("4444444444444444");
    for (const p of pageIds) expect(p).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(pageIds).size).toBe(3);
    ["aaaa0001", "aaaa0002", "aaaa0003"].forEach((id, i) =>
      expect(history.pageAskId(pageIds[i]!)).toBe(id),
    );
    // The rest of each entry is as it was.
    expect(after.get("aaaa0002")?.page?.state).toBe("acked");
    expect(after.get("aaaa0004")?.page).toBeUndefined();
    after.backfillPages();
    expect(saves).toBe(1);
  });

  it("a re-raise counts every raise and saves it; only new text is an edit, and with no actor the agent made it", () => {
    const { store, paged, changes, events, pages, saves, tick, now, reopen } =
      indexed();
    const entry = paged();
    expect(entry.page?.raiseCount ?? 1).toBe(1);
    changes.length = 0;
    events.length = 0;
    pages.length = 0;
    const before = saves();
    tick(100);
    const same = store.reraise(entry.id, entry.prompt);
    expect(same?.outcome).toBe("unchanged");
    expect(same?.entry.page).toMatchObject({
      raiseCount: 2,
      lastRaisedAt: now(),
    });
    expect(same?.entry.updatedAt).toBe(entry.updatedAt);
    expect(saves()).toBe(before + 1);
    expect([changes, events, pages]).toEqual([[], [], []]);
    tick(100);
    const changed = store.reraise(entry.id, "Disk full\n\n95%");
    expect(changed?.outcome).toBe("changed");
    expect(changed?.entry.page).toMatchObject({
      raiseCount: 3,
      lastRaisedAt: now(),
      state: "ringing",
      pageId: entry.page!.pageId,
    });
    expect(changes.map((c) => c.kind)).toEqual(["upserted"]);
    expect(events).toEqual([
      { kind: "edited", at: now(), before: { prompt: "Disk full" } },
    ]);
    expect(pages).toEqual([]);
    expect(reopen().get(entry.id)?.page).toMatchObject({
      raiseCount: 3,
      lastRaisedAt: now(),
    });
  });

  it("finds a source's keyed page for one member only when a member is named", () => {
    const { store, paged } = indexed();
    const forU1 = paged({ page: { recipients: ["u1"], key: "disk" } });
    const src = { kind: "agent" as const, agentId: "a1" };
    expect(store.openPaged(src, "disk")?.id).toBe(forU1.id);
    expect(store.openPaged(src, "disk", "u1")?.id).toBe(forU1.id);
    expect(store.openPaged(src, "disk", "u2")).toBeNull();
  });

  it("a migrated create keeps the page's id, times, count, send record and ack, past every cap, and rings nothing new", () => {
    const { store, paged, history, reopen, pages } = indexed();
    for (let i = 0; i < ASK_PAGES_MAX_OPEN_PER_SOURCE; i++) paged();
    // Enabling: the source is at its cap for a plain create.
    expect(
      store.create({
        agentId: "a1",
        memberUserId: "u1",
        prompt: "One more",
        page: { recipients: ["u1"] },
      }),
    ).toEqual({ ok: false, code: "too_many_pages" });
    pages.length = 0;
    const delivery: PagerDelivery = {
      state: "delivered",
      sends: 3,
      lastAttemptAt: 40,
    };
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Disk full\n\n90%",
      priority: "P1",
      page: { recipients: ["u1"], key: "disk" },
      migrated: {
        pageId: "5555555555555555",
        createdAt: 10,
        raiseCount: 4,
        lastRaisedAt: 30,
        delivery,
        acked: { byUserId: "", at: 35 },
      },
    });
    if (!made.ok) throw new Error(`create failed: ${made.code}`);
    expect(made.entry.createdAt).toBe(10);
    expect(made.entry.page).toEqual({
      state: "acked",
      pageId: "5555555555555555",
      key: "disk",
      raiseCount: 4,
      lastRaisedAt: 30,
      ackedByUserId: "",
      ackedAt: 35,
      delivery: { u1: delivery },
    });
    expect(history.pageAskId("5555555555555555")).toBe(made.entry.id);
    // It loads again: "" is a string to the load check.
    expect(reopen().get(made.entry.id)?.page?.ackedByUserId).toBe("");
    // A ringing one has no ack.
    const ringing = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Box down",
      page: { recipients: ["u1"] },
      migrated: {
        pageId: "6666666666666666",
        createdAt: 11,
        raiseCount: 1,
        lastRaisedAt: 11,
        delivery: NO_SENDS,
      },
    });
    if (!ringing.ok) throw new Error("create failed");
    expect(ringing.entry.page?.state).toBe("ringing");
    expect(ringing.entry.page?.ackedByUserId).toBeUndefined();
    // The delivery engines arm it from its send record, not as a new page.
    expect(pages).toEqual([]);
  });

  it("an agent's removal leaves its app pages open with no agent; every other ask of it closes", () => {
    const { store, paged, history, changes, pages } = indexed();
    const APP = { name: "uptime", createdAt: 7 };
    const appPage = paged({ app: APP, sessionId: "s1" });
    // Not a valid ask with no agent: it has options.
    const appPageWithOptions = paged({ app: APP, options: ["Fix it"] });
    const appPlain = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Plain?",
      app: APP,
    });
    if (!appPlain.ok) throw new Error("create failed");
    const own = paged();
    const other = paged({ agentId: "a2" });
    changes.length = 0;
    pages.length = 0;
    expect(store.removeAgent("a1")).toBe(3);
    const kept = store.get(appPage.id);
    expect(kept).toMatchObject({ agentId: "", app: APP, memberUserId: "u1" });
    expect(kept?.sessionId).toBeUndefined();
    expect(kept?.page).toEqual(appPage.page);
    expect(history.getById(appPage.id)).toBeNull();
    for (const gone of [appPageWithOptions.id, appPlain.entry.id, own.id]) {
      expect(store.get(gone)).toBeNull();
      expect(history.getById(gone)?.closure.outcome).toBe("agent_removed");
    }
    expect(store.get(other.id)?.agentId).toBe("a2");
    expect(changes.map((c) => [c.kind, c.entry.id]).sort()).toEqual(
      [
        ["upserted", appPage.id],
        ["removed", appPageWithOptions.id],
        ["removed", appPlain.entry.id],
        ["removed", own.id],
      ].sort(),
    );
    expect(pages.sort()).toEqual(
      [`closed ${appPageWithOptions.id}`, `closed ${own.id}`].sort(),
    );
    // It is found by its page id still, and reloads.
    expect(store.findPaged(appPage.page!.pageId!)?.agentId).toBe("");
  });

  it("the page id is on the member and agent wires; the raise count, the last raise and the key never are", () => {
    const { store, paged } = indexed();
    const entry = paged({ page: { recipients: ["u1"], key: "disk" } });
    store.reraise(entry.id, entry.prompt);
    const now = store.get(entry.id)!;
    const audience: AskAudienceDeps = {
      isOfficeOwner: () => false,
      agentRoomId: () => "r1",
      canSeeRoom: () => true,
      roomHidden: () => false,
      roomMemberIds: () => [],
    };
    for (const wire of [
      askMemberWire(now, () => "Uma", audience),
      askAgentWire(now, () => "Uma", audience),
    ]) {
      expect(wire.page).toEqual({
        state: "ringing",
        pageId: entry.page!.pageId,
      });
    }
  });
});
