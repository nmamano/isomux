// Step asks (task c71cb60f): what an agent's step may be and who may do it,
// the link the server sets, a step done at create, and the reconcile that
// closes an ask once its step is done, with its line, once, and never one
// whose step is not done. The office wiring and the hooks run end to end in
// server/test-support/routes-step-asks.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AskEntry, StepAskRequest } from "../shared/types.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { createAskFilePersistence, createAskStore } from "./asks.ts";
import { createStepAsks } from "./step-asks.ts";
import type { SecretScope } from "./secret-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Alice manages agent a1 in room r1; Nil is an office owner; Bob is a
// member.
const ALICE = "u-alice";
const OWNER = "u-owner";
const BOB = "u-bob";

type Settled = {
  agentId: string;
  askId: string;
  line: LogMessage;
  memberUserId: string;
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "isomux-step-asks-"));
  roots.push(root);
  const asksPath = join(root, "asks.json");
  // The state each predicate reads; tests change it in place.
  const state = {
    // "<userId>|<provider>|<scope>"
    connected: new Set<string>(),
    // "<scope key>|<name>": the scope key is "office" or the user id.
    servers: new Map<string, { oauth: boolean; signedIn: boolean }>(),
    paired: new Set<string>(),
    linked: new Set<string>(),
    // While set, every provider read waits on it.
    providerGate: null as Promise<void> | null,
    providerFails: false,
  };
  const scopeKey = (scope: SecretScope) =>
    scope.kind === "office" ? "office" : scope.userId;
  const settled: Settled[] = [];
  function boot() {
    const asks = createAskStore({
      persistence: createAskFilePersistence(asksPath),
    });
    const steps = createStepAsks({
      asks,
      isOfficeOwner: (userId) => userId === OWNER,
      providerConnected: async (userId, provider, scope) => {
        if (state.providerGate) await state.providerGate;
        if (state.providerFails) throw new Error("the provider CLI is gone");
        return state.connected.has(`${userId}|${provider}|${scope}`);
      },
      mcpServer: (scope, name) =>
        state.servers.get(`${scopeKey(scope)}|${name}`) ?? null,
      browserPaired: (userId) => state.paired.has(userId),
      roomLinked: (roomId) => state.linked.has(roomId),
      settled: (agentId, askId, line, memberUserId) =>
        settled.push({ agentId, askId, line, memberUserId }),
    });
    return { asks, steps };
  }
  const first = boot();
  return { ...first, state, settled, asksPath, boot };
}

type T = ReturnType<typeof setup>;

// A create's input: Alice's agent in r1, for Alice unless a test says so.
const input = (
  step: unknown,
  over: Partial<{
    managerUserId: string | null;
    memberUserId: string;
    memberNamed: boolean;
  }> = {},
) => ({
  step,
  roomId: "r1",
  managerUserId: ALICE,
  memberUserId: ALICE,
  memberNamed: false,
  ...over,
});

const answer = (result: { ok: boolean; status?: number; code?: string }) =>
  result.ok ? "ok" : `${result.status} ${result.code}`;

// Check a step and open its ask, as the create route does.
async function open(
  t: T,
  step: unknown,
  over: Parameters<typeof input>[1] = {},
): Promise<AskEntry> {
  const checked = await t.steps.check(input(step, over));
  if (!checked.ok) throw new Error(`check refused: ${checked.code}`);
  const made = t.asks.create({
    agentId: "a1",
    memberUserId: over.memberUserId ?? ALICE,
    prompt: "Please do this step.",
    link: checked.link,
    step: checked.step,
  });
  if (!made.ok) throw new Error("create refused");
  return made.entry;
}

const openIds = (t: { asks: T["asks"] }) =>
  t.asks
    .listAll()
    .map((e) => e.id)
    .sort();

describe("the step check", () => {
  it("completes each kind's step and gives the tab its link opens", async () => {
    const t = setup();
    t.state.servers.set(`${ALICE}|mail`, { oauth: true, signedIn: false });
    t.state.servers.set("office|wiki", { oauth: true, signedIn: false });
    const cases: [unknown, Parameters<typeof input>[1], unknown][] = [
      [
        { kind: "provider-sign-in", provider: "claude" },
        {},
        {
          step: {
            kind: "provider-sign-in",
            provider: "claude",
            scope: "personal",
          },
          link: "/integrations/providers",
        },
      ],
      [
        { kind: "provider-sign-in", provider: "codex", scope: "office" },
        { memberUserId: OWNER, memberNamed: true },
        {
          step: {
            kind: "provider-sign-in",
            provider: "codex",
            scope: "office",
          },
          link: "/integrations/providers",
        },
      ],
      [
        { kind: "mcp-sign-in", name: "mail" },
        {},
        {
          step: {
            kind: "mcp-sign-in",
            name: "mail",
            scope: "personal",
            ownerUserId: ALICE,
          },
          link: "/integrations/mcp",
        },
      ],
      // An owner named for a personal server signs in Alice's server.
      [
        { kind: "mcp-sign-in", name: "mail", scope: "personal" },
        { memberUserId: OWNER, memberNamed: true },
        {
          step: {
            kind: "mcp-sign-in",
            name: "mail",
            scope: "personal",
            ownerUserId: ALICE,
          },
          link: "/integrations/mcp",
        },
      ],
      [
        { kind: "mcp-sign-in", name: "wiki", scope: "office" },
        { memberUserId: OWNER, memberNamed: true },
        {
          step: { kind: "mcp-sign-in", name: "wiki", scope: "office" },
          link: "/integrations/mcp",
        },
      ],
      [
        { kind: "browser-pairing" },
        {},
        { step: { kind: "browser-pairing" }, link: "/integrations/browser" },
      ],
      // Naming the manager is the same as naming no one.
      [
        { kind: "browser-pairing" },
        { memberNamed: true },
        { step: { kind: "browser-pairing" }, link: "/integrations/browser" },
      ],
      [
        { kind: "github-link" },
        { managerUserId: OWNER, memberUserId: OWNER },
        {
          step: { kind: "github-link", roomId: "r1" },
          link: "/integrations/github",
        },
      ],
    ];
    for (const [step, over, expected] of cases)
      expect([step, await t.steps.check(input(step, over))]).toEqual([
        step,
        { ok: true, ...(expected as object) },
      ]);
  });

  it("refuses a step that is not one, one the member may not do, and one that is done", async () => {
    const t = setup();
    t.state.servers.set(`${ALICE}|mail`, { oauth: true, signedIn: false });
    t.state.servers.set(`${ALICE}|plain`, { oauth: false, signedIn: false });
    t.state.servers.set("office|wiki", { oauth: true, signedIn: false });
    const refused: [string, unknown, Parameters<typeof input>[1], string][] = [
      ["not an object", "browser-pairing", {}, "400 invalid_request"],
      ["an unknown kind", { kind: "voice" }, {}, "400 invalid_request"],
      [
        "an unknown provider",
        { kind: "provider-sign-in", provider: "gemini" },
        {},
        "400 invalid_request",
      ],
      [
        "an unknown scope",
        { kind: "provider-sign-in", provider: "claude", scope: "team" },
        {},
        "400 invalid_request",
      ],
      [
        "a field the kind does not take",
        { kind: "browser-pairing", provider: "claude" },
        {},
        "400 invalid_request",
      ],
      [
        "a room from the agent",
        { kind: "github-link", roomId: "r2" },
        { managerUserId: OWNER, memberUserId: OWNER },
        "400 invalid_request",
      ],
      [
        "an owner from the agent",
        { kind: "mcp-sign-in", name: "mail", ownerUserId: BOB },
        {},
        "400 invalid_request",
      ],
      [
        "another member's own sign-in",
        { kind: "provider-sign-in", provider: "claude" },
        { memberUserId: BOB, memberNamed: true },
        "400 invalid_request",
      ],
      [
        "another member's browser",
        { kind: "browser-pairing" },
        { memberUserId: OWNER, memberNamed: true },
        "400 invalid_request",
      ],
      [
        "the office account by a member",
        { kind: "provider-sign-in", provider: "claude", scope: "office" },
        {},
        "403 member_not_allowed",
      ],
      [
        "a GitHub link by a member",
        { kind: "github-link" },
        {},
        "403 member_not_allowed",
      ],
      [
        "the manager's server by another member",
        { kind: "mcp-sign-in", name: "mail" },
        { memberUserId: BOB, memberNamed: true },
        "403 member_not_allowed",
      ],
      [
        "an office server by a member",
        { kind: "mcp-sign-in", name: "wiki", scope: "office" },
        {},
        "403 member_not_allowed",
      ],
      [
        "no such server",
        { kind: "mcp-sign-in", name: "nope" },
        {},
        "422 unknown_mcp_server",
      ],
      [
        "a server of another scope",
        { kind: "mcp-sign-in", name: "wiki" },
        {},
        "422 unknown_mcp_server",
      ],
      [
        "a server with no OAuth",
        { kind: "mcp-sign-in", name: "plain" },
        {},
        "409 not_oauth",
      ],
    ];
    expect(
      await Promise.all(
        refused.map(async ([what, step, over]) => [
          what,
          answer(await t.steps.check(input(step, over))),
        ]),
      ),
    ).toEqual(refused.map(([what, , , expected]) => [what, expected]));

    // Done already: each kind's own state, for the member it is for.
    t.state.connected.add(`${ALICE}|claude|office`);
    t.state.connected.add(`${BOB}|claude|personal`);
    expect(
      answer(
        await t.steps.check(
          input({ kind: "provider-sign-in", provider: "claude" }),
        ),
      ),
    ).toBe("ok");
    t.state.connected.add(`${ALICE}|claude|personal`);
    t.state.servers.set(`${ALICE}|mail`, { oauth: true, signedIn: true });
    t.state.paired.add(ALICE);
    t.state.linked.add("r1");
    const done: [unknown, Parameters<typeof input>[1]][] = [
      [{ kind: "provider-sign-in", provider: "claude" }, {}],
      [{ kind: "mcp-sign-in", name: "mail" }, {}],
      [{ kind: "browser-pairing" }, {}],
      [{ kind: "github-link" }, { managerUserId: OWNER, memberUserId: OWNER }],
    ];
    for (const [step, over] of done)
      expect([step, answer(await t.steps.check(input(step, over)))]).toEqual([
        step,
        "409 step_done",
      ]);
  });
});

describe("the reconcile", () => {
  it("closes each ask whose step is done, with its line, and leaves the rest open", async () => {
    const t = setup();
    t.state.servers.set(`${ALICE}|mail`, { oauth: true, signedIn: false });
    const claude = await open(t, {
      kind: "provider-sign-in",
      provider: "claude",
    });
    const codexOffice = await open(
      t,
      { kind: "provider-sign-in", provider: "codex", scope: "office" },
      { memberUserId: OWNER, memberNamed: true },
    );
    const mail = await open(t, { kind: "mcp-sign-in", name: "mail" });
    const browser = await open(t, { kind: "browser-pairing" });
    const github = await open(
      t,
      { kind: "github-link" },
      { managerUserId: OWNER, memberUserId: OWNER },
    );
    const plain = t.asks.create({
      agentId: "a1",
      memberUserId: ALICE,
      prompt: "Go?",
    });
    if (!plain.ok) throw new Error("plain ask refused");

    // Nothing done yet, or done for someone else or another scope.
    t.state.connected.add(`${ALICE}|claude|office`);
    t.state.connected.add(`${BOB}|claude|personal`);
    t.state.connected.add(`${OWNER}|codex|personal`);
    t.state.paired.add(BOB);
    t.state.linked.add("r2");
    t.state.servers.set("office|mail", { oauth: true, signedIn: true });
    await t.steps.reconcile();
    expect(t.settled).toEqual([]);
    expect(openIds(t)).toHaveLength(6);

    t.state.connected.add(`${ALICE}|claude|personal`);
    t.state.servers.set(`${ALICE}|mail`, { oauth: true, signedIn: true });
    t.state.paired.add(ALICE);
    t.state.linked.add("r1");
    await t.steps.reconcile();
    const byAsk = (s: Settled) => s.askId;
    expect(
      [...t.settled].sort((a, b) => byAsk(a).localeCompare(byAsk(b))),
    ).toEqual(
      [
        {
          agentId: "a1",
          askId: claude.id,
          line: msg("systemEntries.stepAsk.providerSignedIn", {
            provider: "Claude",
          }),
          memberUserId: ALICE,
        },
        {
          agentId: "a1",
          askId: mail.id,
          line: msg("systemEntries.stepAsk.mcpSignedIn", { name: "mail" }),
          memberUserId: ALICE,
        },
        {
          agentId: "a1",
          askId: browser.id,
          line: msg("systemEntries.stepAsk.browserPaired"),
          memberUserId: ALICE,
        },
        {
          agentId: "a1",
          askId: github.id,
          line: msg("systemEntries.stepAsk.githubLinked"),
          memberUserId: OWNER,
        },
      ].sort((a, b) => byAsk(a).localeCompare(byAsk(b))),
    );
    expect(openIds(t)).toEqual([codexOffice.id, plain.entry.id].sort());

    // The office account, whoever signs it in.
    t.settled.length = 0;
    t.state.connected.add(`${ALICE}|codex|office`);
    t.state.connected.add(`${OWNER}|codex|office`);
    await t.steps.reconcile();
    expect(t.settled).toEqual([
      {
        agentId: "a1",
        askId: codexOffice.id,
        line: msg("systemEntries.stepAsk.providerSignedInOffice", {
          provider: "Codex",
        }),
        memberUserId: OWNER,
      },
    ]);
    expect(openIds(t)).toEqual([plain.entry.id]);
  });

  it("two reconciles at once close an ask once", async () => {
    const t = setup();
    const claude = await open(t, {
      kind: "provider-sign-in",
      provider: "claude",
    });
    let release = () => {};
    t.state.providerGate = new Promise((resolve) => (release = resolve));
    t.state.connected.add(`${ALICE}|claude|personal`);
    const both = Promise.all([t.steps.reconcile(), t.steps.reconcile()]);
    release();
    await both;
    expect(t.settled.map((s) => s.askId)).toEqual([claude.id]);
    expect(openIds(t)).toEqual([]);
  });

  it("an ask answered while its step was being read is not settled again", async () => {
    const t = setup();
    const claude = await open(t, {
      kind: "provider-sign-in",
      provider: "claude",
    });
    let release = () => {};
    t.state.providerGate = new Promise((resolve) => (release = resolve));
    t.state.connected.add(`${ALICE}|claude|personal`);
    const running = t.steps.reconcile();
    // The member dismisses it meanwhile.
    expect(t.asks.remove(claude.id)?.id).toBe(claude.id);
    release();
    await running;
    expect(t.settled).toEqual([]);
  });

  it("a predicate that throws leaves its ask open and does not stop the others", async () => {
    const t = setup();
    const claude = await open(t, {
      kind: "provider-sign-in",
      provider: "claude",
    });
    const browser = await open(t, { kind: "browser-pairing" });
    t.state.providerFails = true;
    t.state.paired.add(ALICE);
    await t.steps.reconcile();
    expect(t.settled.map((s) => s.askId)).toEqual([browser.id]);
    expect(openIds(t)).toEqual([claude.id]);
  });

  it("a step ask survives a restart, and the next boot's reconcile closes it", async () => {
    const t = setup();
    const browser = await open(t, { kind: "browser-pairing" });
    const next = t.boot();
    const [loaded] = next.asks.listAll();
    expect([loaded.id, loaded.step, loaded.link]).toEqual([
      browser.id,
      { kind: "browser-pairing" },
      "/integrations/browser",
    ]);
    t.state.paired.add(ALICE);
    await next.steps.reconcile();
    expect(t.settled.map((s) => s.askId)).toEqual([browser.id]);
    expect(openIds(next)).toEqual([]);
  });

  it("a step of a later kind loads with the other asks and never closes itself", async () => {
    const t = setup();
    await open(t, { kind: "browser-pairing" });
    const plain = t.asks.create({
      agentId: "a1",
      memberUserId: ALICE,
      prompt: "Go?",
    });
    if (!plain.ok) throw new Error("plain ask refused");
    const file = JSON.parse(readFileSync(t.asksPath, "utf-8")) as AskEntry[];
    writeFileSync(
      t.asksPath,
      JSON.stringify(
        file.map((e) =>
          e.step
            ? {
                ...e,
                step: { kind: "later-step" } as unknown as StepAskRequest,
              }
            : e,
        ),
        null,
        2,
      ),
    );
    const next = t.boot();
    expect(
      next.asks
        .listAll()
        .map((e) => (e.step as { kind?: string } | undefined)?.kind ?? null)
        .sort(),
    ).toEqual(["later-step", null].sort());
    t.state.paired.add(ALICE);
    await next.steps.reconcile();
    expect(t.settled).toEqual([]);
    expect(next.asks.listAll()).toHaveLength(2);
  });
});
