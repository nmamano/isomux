// skills.* handlers over injected deps: reads and saves reach only the
// caller's catalog paths, read-only skills refuse a save, a stale save is a
// 409 that writes nothing, and a successful write refreshes the Sk menus.

import { describe, expect, it } from "bun:test";
import { skillsHandlers, type SkillsDeps } from "./skills.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import { USER_CAPABILITIES, type Identity } from "../../identity/index.ts";
import type {
  SkillCatalogEntry,
  SkillCatalogRes,
} from "../../../shared/contract-shapes.ts";

const VALID_CONTENT = "---\nname: mine\ndescription: fixture\n---\nBody\n";

const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function entry(over: Partial<SkillCatalogEntry>): SkillCatalogEntry {
  return {
    name: "mine",
    source: "user",
    kind: "skill",
    path: "/h/.claude/skills/mine/SKILL.md",
    dir: "/h/.claude/skills",
    editable: true,
    uses: 0,
    ...over,
  };
}

const catalog: SkillCatalogRes = {
  engines: [
    {
      engine: "claude",
      skills: [
        entry({}),
        entry({
          name: "grill-me",
          source: "isomux",
          path: "/opt/isomux/skills/grill-me/SKILL.md",
          editable: false,
        }),
      ],
    },
  ],
  newSkillDir: "/h/.claude/skills",
  home: "/h",
};

function harness(over: Partial<SkillsDeps> = {}) {
  const calls = {
    saves: 0,
    deletes: 0,
    refresh: 0,
    catalogFor: [] as Identity[],
  };
  const deps: SkillsDeps = {
    catalogFor: (id) => {
      calls.catalogFor.push(id);
      return catalog;
    },
    readFile: (path) => ({
      kind: "ok",
      path,
      content: "body",
      mtime: 1,
      language: "markdown",
      size: 4,
      rev: 7,
      sig: "s",
    }),
    saveFile: (path) => {
      calls.saves++;
      return { kind: "ok", path, mtime: 2, rev: 8 };
    },
    deleteFile: async () => {
      calls.deletes++;
      return { kind: "ok" };
    },
    createSkill: (dir, input) => ({
      kind: "ok",
      path: `${dir}/${String(input.name)}/SKILL.md`,
    }),
    refreshMenus: () => {
      calls.refresh++;
    },
    ...over,
  };
  return { handlers: skillsHandlers(deps), calls };
}

function ctx(query = "", body: unknown = undefined): RouteHandlerContext {
  return {
    identity,
    params: {},
    body,
    rawBody: "",
    query: new URLSearchParams(query),
    req: new Request("http://localhost/"),
  };
}

async function run(
  handler: (c: RouteHandlerContext) => HandlerResult | Promise<HandlerResult>,
  c: RouteHandlerContext,
) {
  return await handler(c);
}

describe("skills handlers", () => {
  it("builds the catalog for the calling identity", async () => {
    const { handlers, calls } = harness();
    const r = await run(handlers["skills.catalog"], ctx());
    expect(r).toMatchObject({ kind: "json", body: catalog });
    expect(calls.catalogFor[0]).toBe(identity);
  });

  it("reads only a path the catalog lists, and says whether it is editable", async () => {
    const { handlers } = harness();
    const listed = await run(
      handlers["skills.readFile"],
      ctx("path=/opt/isomux/skills/grill-me/SKILL.md"),
    );
    expect(listed).toMatchObject({
      kind: "json",
      body: { content: "body", rev: 7, editable: false },
    });
    const other = await run(
      handlers["skills.readFile"],
      ctx("path=/etc/passwd"),
    );
    expect(other).toMatchObject({ kind: "error", status: 404 });
  });

  it("refuses to save a read-only or unlisted skill and writes nothing", async () => {
    const { handlers, calls } = harness();
    const builtIn = await run(
      handlers["skills.saveFile"],
      ctx("", {
        path: "/opt/isomux/skills/grill-me/SKILL.md",
        content: VALID_CONTENT,
        expectedRev: 7,
      }),
    );
    expect(builtIn).toMatchObject({ kind: "error", status: 403 });
    const unlisted = await run(
      handlers["skills.saveFile"],
      ctx("", { path: "/h/.bashrc", content: VALID_CONTENT, expectedRev: 7 }),
    );
    expect(unlisted).toMatchObject({ kind: "error", status: 404 });
    expect(calls.saves).toBe(0);
  });

  it("requires the revision the caller read", async () => {
    const { handlers, calls } = harness();
    const r = await run(
      handlers["skills.saveFile"],
      ctx("", {
        path: catalog.engines[0].skills[0].path,
        content: VALID_CONTENT,
      }),
    );
    expect(r).toMatchObject({ kind: "error", status: 422 });
    expect(calls.saves).toBe(0);
  });

  it("answers a stale save with 409 and the current revision, without a refresh", async () => {
    const { handlers, calls } = harness({
      saveFile: (path) => ({
        kind: "stale",
        path,
        currentMtime: 3,
        currentRev: 9,
      }),
    });
    const r = await run(
      handlers["skills.saveFile"],
      ctx("", {
        path: catalog.engines[0].skills[0].path,
        content: VALID_CONTENT,
        expectedRev: 7,
      }),
    );
    expect(r).toMatchObject({
      kind: "error",
      status: 409,
      code: "stale",
      detail: { currentRev: 9 },
    });
    expect(calls.refresh).toBe(0);
  });

  it("saves an editable skill and refreshes the menus", async () => {
    const { handlers, calls } = harness();
    const r = await run(
      handlers["skills.saveFile"],
      ctx("", {
        path: catalog.engines[0].skills[0].path,
        content: VALID_CONTENT,
        expectedRev: 7,
      }),
    );
    expect(r).toMatchObject({ kind: "json", body: { rev: 8 } });
    expect(calls.saves).toBe(1);
    expect(calls.refresh).toBe(1);
  });

  it("creates in the catalog's new-skill folder and maps failures to codes", async () => {
    let seenDir = "";
    const { handlers, calls } = harness({
      createSkill: (dir, input) => {
        seenDir = dir;
        return { kind: "ok", path: `${dir}/${String(input.name)}/SKILL.md` };
      },
    });
    const ok = await run(
      handlers["skills.create"],
      ctx("", { name: "new-one", description: "d" }),
    );
    expect(seenDir).toBe(catalog.newSkillDir);
    expect(ok).toMatchObject({
      kind: "json",
      status: 201,
      body: { path: "/h/.claude/skills/new-one/SKILL.md", editable: true },
    });
    expect(calls.refresh).toBe(1);

    for (const [result, status, code] of [
      [{ kind: "invalid", field: "name" }, 422, "invalid_name"],
      [{ kind: "invalid", field: "description" }, 422, "invalid_description"],
      [{ kind: "exists", path: "/p" }, 409, "skill_exists"],
    ] as const) {
      const { handlers: h } = harness({ createSkill: () => result });
      const r = await run(h["skills.create"], ctx("", { name: "x" }));
      expect(r).toMatchObject({ kind: "error", status, code });
    }
  });
});

it("leaves legacy command saves unvalidated", async () => {
  const command = entry({
    kind: "command",
    path: "/h/.claude/commands/mine.md",
  });
  const { handlers, calls } = harness({
    catalogFor: () => ({
      ...catalog,
      engines: [{ engine: "claude", skills: [command] }],
    }),
  });
  const r = await run(
    handlers["skills.saveFile"],
    ctx("", {
      path: command.path,
      content: "---\nname: [broken\n---\nLegacy body",
      expectedRev: 7,
    }),
  );
  expect(r).toMatchObject({ kind: "json" });
  expect(calls.saves).toBe(1);
});

it("checks the current catalog and revision before delete, and refreshes only on success", async () => {
  const path = catalog.engines[0].skills[0].path;
  const { handlers, calls } = harness();
  for (const [body, status] of [
    [{ expectedRev: 7 }, 400],
    [{ path }, 422],
    [{ path: "/other/SKILL.md", expectedRev: 7 }, 404],
    [{ path: catalog.engines[0].skills[1].path, expectedRev: 7 }, 403],
  ] as const) {
    expect(
      await run(handlers["skills.deleteFile"], ctx("", body)),
    ).toMatchObject({ kind: "error", status });
  }
  expect(calls.deletes).toBe(0);
  expect(calls.refresh).toBe(0);
  expect(
    await run(handlers["skills.deleteFile"], ctx("", { path, expectedRev: 7 })),
  ).toMatchObject({ kind: "noContent" });
  expect(calls.deletes).toBe(1);
  expect(calls.refresh).toBe(1);
  expect(calls.catalogFor.every((id) => id === identity)).toBe(true);
  for (const [result, status, code] of [
    [{ kind: "stale", currentRev: 9, currentMtime: 3 }, 409, "stale"],
    [{ kind: "deleted" }, 409, "deleted"],
    [{ kind: "read_only" }, 403, "read_only"],
    [{ kind: "io_error", message: "fixture" }, 500, "io_error"],
  ] as const) {
    const h = harness({ deleteFile: async () => result });
    expect(
      await run(
        h.handlers["skills.deleteFile"],
        ctx("", { path, expectedRev: 7 }),
      ),
    ).toMatchObject({ kind: "error", status, code });
    expect(h.calls.refresh).toBe(0);
  }
});
