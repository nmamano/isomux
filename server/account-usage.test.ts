// Task 3e70b6d4: the owners' account usage card. Which accounts it lists,
// what a row says, and that the usage key never reaches the wire.

import { describe, expect, it } from "bun:test";
import {
  collectAccountUsageSources,
  createAccountUsageService,
  noLimitFromEnv,
  type AccountUsageServiceDeps,
  type AccountUsageSource,
  type AccountUsageSourceDeps,
} from "./account-usage.ts";
import type { AccountUsageAnswer, AccountUsageTarget } from "./office-usage.ts";
import { normalizeClaudeSubscriptionUsage } from "./backends/claude.ts";
import { normalizeCodexSubscriptionUsage } from "./backends/codex/adapter.ts";
import { accountUsageHandlers } from "./routes/handlers/account-usage.ts";
import type { HandlerResult, RouteHandlerContext } from "./routes/executor.ts";
import type { Identity } from "./identity/index.ts";
import { USER_CAPABILITIES } from "./identity/index.ts";
import type {
  AccountUsageListRes,
  AccountUsageRowWire,
} from "../shared/contract-shapes.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("noLimitFromEnv", () => {
  it("names the accounts with no plan limit by their variables alone; a Claude OAuth token has plan limits", () => {
    const cases: ["claude" | "codex", Record<string, string>, boolean][] = [
      ["claude", {}, false],
      ["claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, false],
      ["claude", { ANTHROPIC_API_KEY: "k" }, true],
      ["claude", { ANTHROPIC_AUTH_TOKEN: "k" }, true],
      ["claude", { CLAUDE_CODE_USE_BEDROCK: "1" }, true],
      // Off by the CLI's rule.
      ["claude", { CLAUDE_CODE_USE_BEDROCK: "0" }, false],
      ["claude", { CLAUDE_CODE_USE_VERTEX: "1" }, true],
      ["claude", { CLAUDE_CODE_USE_FOUNDRY: "1" }, true],
      ["claude", { ANTHROPIC_BASE_URL: "https://proxy.example.test" }, true],
      // Another provider's key says nothing about this one.
      ["claude", { OPENAI_API_KEY: "k" }, false],
      ["codex", {}, false],
      ["codex", { CODEX_API_KEY: "k" }, true],
      ["codex", { OPENAI_API_KEY: "k" }, true],
      ["codex", { OPENAI_BASE_URL: "https://proxy.example.test" }, true],
      ["codex", { ANTHROPIC_API_KEY: "k" }, false],
    ];
    expect(
      cases.map(([provider, env]) => [
        provider,
        env,
        noLimitFromEnv(provider, env),
      ]),
    ).toEqual(cases);
  });
});

describe("collectAccountUsageSources", () => {
  // The key is the env's DIR and TOKEN, as usageAccountKey's directory and
  // auth variables.
  const keyOf = (provider: string, env: Record<string, string | undefined>) =>
    `${provider}|${env.DIR}|${env.TOKEN ?? ""}`;
  const office = {
    claude: { DIR: "/office/claude" },
    codex: { DIR: "/office/codex" },
  };

  function deps(): AccountUsageSourceDeps {
    return {
      officeEnv: (provider) => office[provider],
      memberIds: () => ["u1", "u2", "u3"],
      // u1 signed in to Claude with their own account, and nothing else.
      personalEnv: (userId, provider) =>
        userId === "u1" && provider === "claude" ? { DIR: "/u1/claude" } : null,
      agentEnv: (userId, provider, dir) => {
        if (userId === "u3") return null; // cannot load
        if (dir) return { DIR: dir };
        if (userId === "u1" && provider === "claude")
          return { DIR: "/u1/claude" };
        // u2 set a Claude token variable on the office directory.
        if (userId === "u2" && provider === "claude")
          return { DIR: "/office/claude", TOKEN: "u2-token" };
        return { ...office[provider] };
      },
      liveAgents: () => [
        // A session pinned to an old root of u1.
        {
          provider: "claude",
          userId: "u1",
          dir: "/u1/legacy",
          key: "claude|/u1/legacy|",
        },
        // Its env changed since launch: its key cannot be rebuilt.
        {
          provider: "claude",
          userId: "u2",
          dir: "/u2/old",
          key: "claude|/u2/old|STALE",
        },
        // An office agent on the office sign-in.
        {
          provider: "codex",
          userId: null,
          dir: "/office/codex",
          key: "codex|/office/codex|",
        },
        // No key (an engine whose readings are not shared, or not known).
        { provider: "claude", userId: "u1", dir: null, key: null },
      ],
      keyOf,
    };
  }

  it("lists the office sign-in, each member's sign-in and env, and the live agents' accounts, one source per key", () => {
    const sources = collectAccountUsageSources(deps());
    const shape = sources
      .map((s) => ({
        provider: s.provider,
        key: s.key,
        office: s.office,
        owners: s.owners,
        envKey: keyOf(s.provider, s.env),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(shape as unknown).toEqual(
      [
        {
          provider: "claude",
          key: "claude|/office/claude|",
          office: true,
          owners: [{ kind: "office" }],
        },
        {
          provider: "claude",
          key: "claude|/office/claude|u2-token",
          office: false,
          owners: [{ kind: "member", userId: "u2" }],
        },
        {
          provider: "claude",
          key: "claude|/u1/claude|",
          office: false,
          owners: [{ kind: "member", userId: "u1" }],
        },
        {
          provider: "claude",
          key: "claude|/u1/legacy|",
          office: false,
          owners: [{ kind: "member", userId: "u1" }],
        },
        {
          // u1's and u2's Codex env is the office sign-in: it folds in.
          provider: "codex",
          key: "codex|/office/codex|",
          office: true,
          owners: [{ kind: "office" }],
        },
      ]
        .map((s) => ({ ...s, envKey: s.key }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
});

describe("collectAccountUsageSources with an office credential", () => {
  it("lists the account the office's agents run on as the office's, and a member on it folds in", () => {
    const keyOf = (provider: string, env: Record<string, string | undefined>) =>
      `${provider}|${env.DIR}|${env.TOKEN ?? ""}`;
    // An office secret holds a Claude token: the office's agents get it,
    // the stored sign-in's env (officeEnv) does not.
    const secret = { DIR: "/office/claude", TOKEN: "office-secret" };
    const sources = collectAccountUsageSources({
      officeEnv: (provider) => ({ DIR: `/office/${provider}` }),
      memberIds: () => ["u1"],
      personalEnv: () => null,
      agentEnv: (_userId, provider, dir) =>
        dir
          ? { DIR: dir }
          : provider === "claude"
            ? { ...secret }
            : { DIR: "/office/codex" },
      liveAgents: () => [],
      keyOf,
    });
    expect(
      sources
        .map((s) => ({ key: s.key, owners: s.owners }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([
      { key: "claude|/office/claude|", owners: [{ kind: "office" }] },
      {
        key: "claude|/office/claude|office-secret",
        owners: [{ kind: "office" }],
      },
      { key: "codex|/office/codex|", owners: [{ kind: "office" }] },
    ]);
  });
});

// A reader the test drives: each readAccount waits for the test's answer.
function fakeReader(cached: Map<string, AccountUsageAnswer> = new Map()) {
  const calls: { target: AccountUsageTarget; refresh: boolean }[] = [];
  const pending = new Map<string, ((a: AccountUsageAnswer) => void)[]>();
  const retained: string[][] = [];
  const reader: AccountUsageServiceDeps["reader"] = {
    peek: (key) => ({
      answer: cached.get(key) ?? null,
      reading: (pending.get(key)?.length ?? 0) > 0,
    }),
    readAccount: (target, opts) => {
      calls.push({ target, refresh: opts?.refresh === true });
      const hit = cached.get(target.key);
      if (hit && opts?.refresh !== true) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const list = pending.get(target.key) ?? [];
        list.push((answer) => {
          cached.set(target.key, answer);
          resolve(answer);
        });
        pending.set(target.key, list);
      });
    },
    retain: (keys) => retained.push([...keys].sort()),
  };
  const answer = async (key: string, a: AccountUsageAnswer) => {
    const list = pending.get(key) ?? [];
    pending.delete(key);
    if (list.length === 0) throw new Error(`no read of ${key} is pending`);
    for (const resolve of list) resolve(a);
    await settled();
  };
  return { reader, calls, retained, answer, cached };
}

const claudeRaw = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 64, resets_at: "2026-11-19T15:00:00Z" },
    seven_day: { utilization: 31, resets_at: "2026-11-22T00:00:00Z" },
    model_scoped: [
      {
        display_name: "Fable",
        utilization: 77,
        resets_at: "2026-11-22T00:00:00Z",
      },
    ],
  },
};
function claudeUsage(identity: string | null): AccountUsageAnswer {
  const n = normalizeClaudeSubscriptionUsage(claudeRaw);
  if (n.kind !== "usage") throw new Error("fixture is not usage");
  return {
    reading: { kind: "usage", ...n.usage },
    identity,
    observedAtMs: NOW - 5000,
  };
}
function codexUsage(identity: string | null): AccountUsageAnswer {
  const resetsAt = Math.floor(NOW / 1000) + 3600;
  const n = normalizeCodexSubscriptionUsage({
    limitId: "codex",
    limitName: null,
    // The 5-hour window first: the weekly one is found by its length.
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
    normalModelSlug: null,
  });
  if (n.kind !== "usage") throw new Error("fixture is not usage");
  return {
    reading: { kind: "usage", ...n.usage },
    identity,
    observedAtMs: NOW,
  };
}

// Keys and env values the wire must never carry.
const K = {
  office: "key-office-/home/office/.claude",
  ana: "key-ana-/home/ana/.claude",
  ben: "key-ben-API",
  cy: "key-cy-/home/cy/.codex",
  dee: "key-dee-/home/dee/.claude",
};
const src = (
  key: string,
  provider: "claude" | "codex",
  owners: AccountUsageSource["owners"],
  env: Record<string, string> = { DIR: `${key}-env-dir` },
): AccountUsageSource => ({
  provider,
  key,
  env,
  owners,
  office: owners.some((o) => o.kind === "office"),
});
const names: Record<string, string> = {
  u1: "ana",
  u2: "ben",
  u3: "cy",
  u4: "dee",
};

function service(
  reader: AccountUsageServiceDeps["reader"],
  sources: () => AccountUsageSource[],
  liveAgents: AccountUsageServiceDeps["liveAgents"] = () => [],
) {
  let n = 0;
  return createAccountUsageService({
    reader,
    sources,
    liveAgents,
    username: (userId) => names[userId] ?? null,
    newId: () => `row-${++n}`,
    now: () => NOW,
  });
}

const byOwner = (rows: AccountUsageRowWire[]) =>
  Object.fromEntries(
    rows.map((r) => [
      r.owners
        .map((o) => (o.kind === "office" ? "office" : o.username))
        .join("+"),
      r,
    ]),
  );

describe("createAccountUsageService", () => {
  const sources = () => [
    src(K.office, "claude", [{ kind: "office" }]),
    src(K.ana, "claude", [{ kind: "member", userId: "u1" }]),
    src(K.ben, "claude", [{ kind: "member", userId: "u2" }], {
      ANTHROPIC_API_KEY: "sk-ben-secret",
    }),
    src(K.cy, "codex", [{ kind: "member", userId: "u3" }]),
  ];

  it("answers at once with what each slot holds, reads the rest, and puts no key, env value or email token on the wire", async () => {
    const f = fakeReader(
      new Map([[K.office, claudeUsage("office@example.test")]]),
    );
    const s = service(f.reader, sources, () => [
      { key: K.ana, userId: "u1" },
      { key: K.ana, userId: "u2" },
      { key: K.office, userId: "u3" },
      { key: K.office, userId: null },
      { key: null, userId: "u4" },
    ]);
    const list = s.list({ refresh: false });
    const rows = byOwner(list.rows);
    expect(Object.keys(rows).sort()).toEqual(["ana", "ben", "cy", "office"]);
    expect({
      office: [
        rows.office!.state,
        rows.office!.accountLabel,
        rows.office!.members,
      ],
      ana: [rows.ana!.state, rows.ana!.members.sort()],
      ben: [rows.ben!.state, rows.ben!.windows],
      cy: [rows.cy!.state, rows.cy!.provider],
    }).toEqual({
      office: ["usage", "office@example.test", ["cy"]],
      ana: ["loading", ["ana", "ben"]],
      // An API key: no limit, and no process.
      ben: ["no_limit", []],
      cy: ["loading", "codex"],
    });
    // Reads start for the loading rows, with the source's env and warm only
    // for the office; never for the no-limit row.
    const started = f.calls.map((c) => ({
      key: c.target.key,
      warm: c.target.warm,
      provider: c.target.provider,
      env: c.target.env,
    }));
    expect(started.filter((c) => c.key === K.ben)).toEqual([]);
    for (const source of sources().filter(
      (x) => x.key !== K.ben && x.key !== K.office,
    ))
      expect(started).toContainEqual({
        key: source.key,
        warm: false,
        provider: source.provider,
        env: source.env,
      });
    // The office slot is the cap's warm one.
    expect(started.filter((c) => c.key === K.office).every((c) => c.warm)).toBe(
      true,
    );
    expect(f.retained.length).toBe(1);
    expect(f.retained[0]).toEqual(
      expect.arrayContaining([K.office, K.ana, K.cy]),
    );

    const wire = JSON.stringify(list);
    for (const secret of [...Object.values(K), "env-dir", "sk-ben-secret"])
      expect({ secret, onWire: wire.includes(secret) }).toEqual({
        secret,
        onWire: false,
      });
    // The identity token is not the email.
    expect(rows.office!.identity).not.toBeNull();
    expect(rows.office!.identity).not.toContain("office@example.test");
  });

  it("gives a row once its read ends, keeps its id across lists, and answers null for an unknown id", async () => {
    const f = fakeReader();
    const s = service(f.reader, sources);
    const first = byOwner(s.list({ refresh: false }).rows);
    const ana = s.row(first.ana!.id);
    await settled();
    await f.answer(K.ana, claudeUsage("ana@example.test"));
    const row = await ana;
    expect(row).toMatchObject({
      id: first.ana!.id,
      state: "usage",
      accountLabel: "ana@example.test",
      plan: "max",
      observedAtMs: NOW - 5000,
    });
    // Claude's account-wide weekly window, not the per-model one.
    expect(row!.windows[row!.weeklyIndex!]).toMatchObject({ usedPercent: 31 });
    expect(row!.windows[row!.weeklyIndex!]!.modelFamily).toBeUndefined();
    expect(row!.windows.some((w) => w.modelFamily === "fable")).toBe(true);

    const second = byOwner(s.list({ refresh: false }).rows);
    expect(second.ana!.id).toBe(first.ana!.id);
    expect(second.ana!.state).toBe("usage");
    expect(await s.row("no-such-row")).toBeNull();

    // Codex: the weekly window by its length, in either slot.
    const cy = s.row(first.cy!.id);
    await settled();
    await f.answer(K.cy, codexUsage("cy@example.test"));
    const cyRow = await cy;
    expect(cyRow!.windows[cyRow!.weeklyIndex!]).toMatchObject({
      usedPercent: 12,
    });
  });

  it("reads again with refresh, and forgets the ids and slots of accounts no longer listed", async () => {
    const f = fakeReader(
      new Map([
        [K.office, claudeUsage("office@example.test")],
        [K.ana, claudeUsage("ana@example.test")],
        [K.cy, codexUsage("cy@example.test")],
      ]),
    );
    let current = sources();
    const s = service(f.reader, () => current);
    const first = byOwner(s.list({ refresh: false }).rows);
    f.calls.length = 0;
    s.list({ refresh: true });
    expect(
      f.calls
        .filter((c) => c.refresh)
        .map((c) => c.target.key)
        .sort(),
    ).toEqual([K.ana, K.cy, K.office].sort());

    current = current.filter((x) => x.key !== K.ana);
    const after = byOwner(s.list({ refresh: false }).rows);
    expect(Object.keys(after).sort()).toEqual(["ben", "cy", "office"]);
    expect(f.retained.at(-1)).not.toContain(K.ana);
    expect(await s.row(first.ana!.id)).toBeNull();
  });

  it("merges rows of one provider account and lists every owner and member; rows with no identity never merge", async () => {
    const f = fakeReader(
      new Map([
        // ana's personal directory is signed in to the office's account.
        [K.office, claudeUsage("shared@example.test")],
        [K.ana, claudeUsage("shared@example.test")],
        // Same email on another provider is another account.
        [K.cy, codexUsage("shared@example.test")],
        // Two failed reads: nothing names them.
        [
          K.ben,
          { reading: { kind: "failed" }, identity: null, observedAtMs: null },
        ],
        [
          K.dee,
          { reading: { kind: "failed" }, identity: null, observedAtMs: null },
        ],
      ]),
    );
    const s = service(
      f.reader,
      () => [
        src(K.office, "claude", [{ kind: "office" }]),
        src(K.ana, "claude", [{ kind: "member", userId: "u1" }]),
        src(K.cy, "codex", [{ kind: "member", userId: "u3" }]),
        src(K.ben, "claude", [{ kind: "member", userId: "u2" }]),
        src(K.dee, "claude", [{ kind: "member", userId: "u4" }]),
      ],
      () => [
        { key: K.office, userId: "u3" },
        { key: K.ana, userId: "u1" },
      ],
    );
    const rows = s.list({ refresh: false }).rows;
    const shape = rows
      .map((r) => ({
        provider: r.provider,
        owners: r.owners
          .map((o) => (o.kind === "office" ? "office" : o.username))
          .sort(),
        members: [...r.members].sort(),
      }))
      .sort((a, b) => a.owners.join().localeCompare(b.owners.join()));
    expect(shape as unknown).toEqual(
      [
        {
          provider: "claude",
          owners: ["ana", "office"],
          members: ["ana", "cy"],
        },
        { provider: "claude", owners: ["ben"], members: [] },
        { provider: "codex", owners: ["cy"], members: [] },
        { provider: "claude", owners: ["dee"], members: [] },
      ].sort((a, b) => a.owners.join().localeCompare(b.owners.join())),
    );
  });
});

describe("createAccountUsageService weekly window", () => {
  it("names no weekly window for a plan whose account-wide weekly window is null, even with a per-model one", async () => {
    // A team plan (office sign-in, 2026-10-26): the 5-hour window and a
    // per-model weekly one, no seven_day.
    const n = normalizeClaudeSubscriptionUsage({
      subscription_type: "team",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 70, resets_at: "2026-11-19T15:00:00Z" },
        seven_day: null,
        model_scoped: [
          {
            display_name: "Fable",
            utilization: 5,
            resets_at: "2026-11-22T00:00:00Z",
          },
        ],
      },
    });
    if (n.kind !== "usage") throw new Error("fixture is not usage");
    const f = fakeReader(
      new Map([
        [
          K.office,
          {
            reading: { kind: "usage", ...n.usage },
            identity: "team@example.test",
            observedAtMs: NOW,
          },
        ],
      ]),
    );
    const s = service(f.reader, () => [
      src(K.office, "claude", [{ kind: "office" }]),
    ]);
    const [row] = s.list({ refresh: false }).rows;
    expect({
      state: row!.state,
      windows: row!.windows.length,
      weeklyIndex: row!.weeklyIndex,
    }).toEqual({ state: "usage", windows: 2, weeklyIndex: null });
  });
});

describe("accountUsageHandlers", () => {
  const identity: Identity = {
    scope: "user",
    userId: "u1",
    role: "owner",
    capabilities: USER_CAPABILITIES,
  };
  const ctx = (
    params: Record<string, string>,
    query = "",
  ): RouteHandlerContext => ({
    identity,
    params,
    body: undefined,
    rawBody: "",
    query: new URLSearchParams(query),
    req: new Request("http://localhost/"),
  });
  const row: AccountUsageRowWire = {
    id: "row-1",
    provider: "claude",
    owners: [{ kind: "office" }],
    accountLabel: null,
    identity: null,
    members: [],
    state: "failed",
    plan: null,
    windows: [],
    weeklyIndex: null,
    observedAtMs: null,
  };

  it("passes refresh=1 to the list, answers a row, and 404s an id the list did not give", async () => {
    const refreshes: boolean[] = [];
    const handlers = accountUsageHandlers({
      service: () => ({
        list: ({ refresh }): AccountUsageListRes => {
          refreshes.push(refresh);
          return { rows: [row] };
        },
        row: async (id) => (id === "row-1" ? row : null),
      }),
    });
    const status = async (r: HandlerResult | Promise<HandlerResult>) => {
      const result = await r;
      return result.kind === "json"
        ? { status: result.status ?? 200, body: result.body }
        : result.kind === "error"
          ? { status: result.status }
          : { kind: result.kind };
    };
    expect(await status(handlers["accountUsage.list"]!(ctx({})))).toEqual({
      status: 200,
      body: { rows: [row] },
    });
    await handlers["accountUsage.list"]!(ctx({}, "refresh=1"));
    expect(refreshes).toEqual([false, true]);
    expect(
      await status(handlers["accountUsage.read"]!(ctx({ rowId: "row-1" }))),
    ).toEqual({ status: 200, body: row });
    expect(
      await status(handlers["accountUsage.read"]!(ctx({ rowId: "nope" }))),
    ).toEqual({ status: 404 });
  });
});
