// The ask store's load posture, the three shapes of an entry, who sees an
// ask, and the note the agent reads.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AskEntry } from "../shared/types.ts";
import {
  ASK_TASK_TITLE_MAX,
  askReplyNote,
  askTaskFields,
  askVisibleTo,
  checkOptions,
  type AskAudienceDeps,
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
    expect(() => store.remove(made.entry.id)).toThrow();
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
      "five options",
      { ...BASE, memberUserId: "u1", options: ["a", "b", "c", "d", "e"] },
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
    const atBounds = ["a", "b", "c", "d"].map((c) => c.repeat(80));
    expect(checkOptions(atBounds)).toEqual({ ok: true, options: atBounds });
    // An 80-character option with spaces around it is in bounds.
    expect(checkOptions([` ${"a".repeat(80)} `, "b"]).ok).toBe(true);
    for (const bad of [
      ["one"],
      ["a", "b", "c", "d", "e"],
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
