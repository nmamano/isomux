// Fallback to the office sign-in when a member's own sign-in reaches its usage
// limit (server/provider-fallback.ts, task 2008c993). Seam: the DI manager
// (createAgentManager + FakeBackend) with an injected clock, fallback store and
// office account, as in server/test-support/limit-resume.test.ts. The member
// "Alice" has her own Claude and Codex sign-in (the personal provider homes);
// the office's are folders under the state root. A conversation's account is
// the CLAUDE_CONFIG_DIR / CODEX_HOME / OPENCODE_API_KEY its session started
// with, and its files are real files that the move copies. The store's own
// rules are in server/provider-fallback.test.ts and the file move in
// server/session-account-move.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";
import { createAgentManager, type LimitResumeClock } from "../agent-manager.ts";
import { OfficeState } from "../../shared/office-state.ts";
import {
  getSessionClaudeConfigDir,
  loadAgents,
  loadMessageQueuesRaw,
} from "../persistence.ts";
import { personalProviderHome } from "../provider-homes.ts";
import { createMember, getUserByName } from "../users.ts";
import { removeManagedUserEnv, writeManagedUserEnv } from "../user-env.ts";
import {
  createMemberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
import {
  createProviderFallback,
  FALLBACK_CONTINUE_TEXT,
  OPENCODE_FALLBACK_RETRY_MS,
  type FallbackAccount,
  type FallbackFamily,
  type FallbackProvider,
  type ProviderFallback,
} from "../provider-fallback.ts";
import { LIMIT_RESUME_DELAY_MS, LIMIT_RESUME_TEXT } from "../limit-resume.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";
import { removeStateDir } from "./temp-state.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import type { EventHandler } from "../internal-types.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentInfo,
  type LogEntry,
  type RoomWire,
} from "../../shared/types.ts";

type Engine = "claude" | "codex";
const HOUR = 60 * 60 * 1000;
const rooms: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const OTHER = {
  kind: "agent" as const,
  agentId: "agent-other",
  agentName: "Other",
  roomName: "room-a",
};

// The user store outlives the state dir reset in a multi-file run, so an
// earlier file may have made Alice already.
function aliceId(): string {
  const known = getUserByName("Alice");
  if (known) return known.id;
  const created = createMember("Alice", { role: "member" });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}

// Which own sign-ins Alice has (provider-account-state.json, injected).
const personal = { claude: true, codex: true };
let restorePersonal: ReturnType<typeof setPersonalProviderActiveProvider>;

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
  personal.claude = true;
  personal.codex = true;
  const alice = aliceId();
  restorePersonal = setPersonalProviderActiveProvider(
    (userId, provider) => userId === alice && personal[provider] === true,
  );
});

const activeFakes: FakeBackend[] = [];
afterEach(() => {
  for (const f of activeFakes) f.sessions.forEach((s) => s.close());
  activeFakes.length = 0;
  setPersonalProviderActiveProvider(restorePersonal);
  setMemberUsageCapForTests(null);
  removeManagedUserEnv(aliceId());
  clearTestManagedOfficeEnv();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}
// Long enough for a flush that is not supposed to happen to have happened.
const settle = () => sleep(100);

// The resume timers' clock, which the fallback store reads too. advance()
// runs every timer due by the new time, in order.
function fakeClock() {
  let now = Date.now();
  const timers: { at: number; fn: () => void; done: boolean }[] = [];
  const clock: LimitResumeClock & {
    advance(ms: number): Promise<void>;
  } = {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn, done: false };
      timers.push(t);
      return t;
    },
    clearTimeout(handle) {
      if (handle) (handle as { done: boolean }).done = true;
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => !t.done && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.done = true;
        next.fn();
        await sleep(0);
      }
      now = end;
    },
  };
  return clock;
}

// The office's sign-ins, as fallbackOfficeAccount reports them.
const officeDir = (engine: Engine) => join(STATE_ROOT, `office-${engine}`);
const OFFICE_KEY = "office-opencode-key";
const MEMBER_KEY = "member-opencode-key";

interface Office {
  clock: ReturnType<typeof fakeClock>;
  store: ProviderFallback;
  accounts: Partial<Record<FallbackProvider, FallbackAccount | null>>;
}

function makeOffice(): Office {
  const clock = fakeClock();
  let enabled = true;
  let state: unknown;
  const store = createProviderFallback({
    load: () => enabled,
    save: (next) => {
      enabled = next;
    },
    loadState: () => state,
    saveState: (next) => {
      state = JSON.parse(JSON.stringify(next));
    },
    now: () => clock.now(),
  });
  return {
    clock,
    store,
    accounts: {
      claude: { dir: officeDir("claude") },
      codex: { dir: officeDir("codex") },
      opencode: { apiKey: OFFICE_KEY },
    },
  };
}

interface Harness {
  mgr: ReturnType<typeof createAgentManager>;
  fake: FakeBackend;
  office: Office;
  logs: LogEntry[];
}

function makeHarness(
  office: Office = makeOffice(),
  initialRooms: Parameters<typeof createAgentManager>[0]["initialRooms"] = [],
  opts: {
    // The office sign-in as the office has it, not injected.
    realOffice?: boolean;
    capabilities?: Partial<AgentCapabilities>;
  } = {},
): Harness {
  const fake = new FakeBackend({
    newSessionId: () => crypto.randomUUID(),
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, ...opts.capabilities },
  });
  const logs: LogEntry[] = [];
  const sink: EventHandler = (e) => {
    const ev = e as { type?: string; entry?: LogEntry };
    if (ev.type === "log_entry" && ev.entry) logs.push(ev.entry);
  };
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms }),
    initialRooms,
    eventSink: sink,
    limitResumeClock: office.clock,
    // An older manager's restart-wake timers must not touch this one's
    // record (turns-in-flight.json).
    restartWakeClock: office.clock,
    providerFallback: office.store,
    ...(opts.realOffice
      ? {}
      : {
          fallbackOfficeAccount: (provider: FallbackProvider) =>
            office.accounts[provider] ?? null,
        }),
  });
  mgr.configureAgentTurnDeps();
  activeFakes.push(fake);
  return { mgr, fake, office, logs };
}

async function spawn(
  h: Harness,
  agentType: AgentInfo["agentType"] = "claude",
  opts: { name?: string; modelFamily?: string; owner?: "alice" | null } = {},
): Promise<AgentInfo> {
  const owner = opts.owner === undefined ? "alice" : opts.owner;
  const info = await h.mgr.spawn(
    opts.name ?? "Receiver",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    opts.modelFamily,
    undefined,
    owner ? "Alice" : undefined,
    agentType,
    undefined,
    owner ? aliceId() : null,
  );
  if (!info) throw new Error("spawn returned null");
  return info;
}

const stateOf = (h: Harness, id: string) => h.mgr.getAgent(id)?.state;
const texts = (s: FakeSession | undefined) =>
  (s?.sent ?? []).map((m) => m.text);
const sessionsOf = (h: Harness, id: string) =>
  h.fake.sessions.filter((s) => s.opts.agentId === id);
const sentTo = (h: Harness, id: string) => sessionsOf(h, id).flatMap(texts);
// The flush sends the continue as its own message, with no prefix.
const isContinue = (t: string) =>
  t.split("\n").includes(FALLBACK_CONTINUE_TEXT);
const continuesTo = (h: Harness, id: string) =>
  sentTo(h, id).filter(isContinue).length;

// The account a session started on.
function accountOf(
  s: FakeSession | undefined,
  engine: FallbackProvider = "claude",
): string | undefined {
  const env = s?.opts.env;
  if (engine === "codex") return env?.CODEX_HOME;
  if (engine === "opencode") return env?.OPENCODE_API_KEY;
  return env?.CLAUDE_CONFIG_DIR;
}
const memberDir = (engine: Engine) => personalProviderHome(aliceId(), engine);

// The session that got `text`.
function sessionWith(
  h: Harness,
  id: string,
  pred: (t: string) => boolean,
): FakeSession | undefined {
  return sessionsOf(h, id).find((s) => texts(s).some(pred));
}

const persisted = (id: string) =>
  loadAgents()
    .flatMap((r) => r.agents)
    .find((a) => a.id === id);

// The agent's log lines with a message of `key`.
function lines(h: Harness, id: string, key: string): LogEntry[] {
  return h.logs.filter(
    (e) =>
      e.agentId === id &&
      Array.isArray(e.message) &&
      e.message.some((p) => typeof p === "object" && p.key === key),
  );
}
const TO_OFFICE = "systemEntries.providerFallback.toOffice";
const BACK = "systemEntries.providerFallback.backToOwn";
const STOPPED = "systemEntries.usageLimit.stopped";
// The `at` of a toOffice line: the time the agent goes back.
function atOf(entry: LogEntry): number | undefined {
  for (const part of entry.message ?? []) {
    if (typeof part !== "object" || part.key !== TO_OFFICE) continue;
    const at = (part.params as { at?: { time?: number } } | undefined)?.at;
    return at?.time;
  }
  return undefined;
}

// The conversation's file in an account folder: the Claude transcript or the
// Codex rollout, as each engine names it.
function conversationFile(engine: Engine, root: string, sid: string): string {
  if (engine === "claude")
    return join(
      claudeProjectDir(STATE_ROOT, { CLAUDE_CONFIG_DIR: root }),
      `${sid}.jsonl`,
    );
  return join(
    root,
    "sessions",
    "2026",
    "10",
    "26",
    `rollout-2026-10-26T10-00-00-${sid}.jsonl`,
  );
}
function writeConversation(engine: Engine, s: FakeSession): void {
  const path = conversationFile(engine, accountOf(s, engine)!, s.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `conversation ${s.sessionId}\n`);
}
const conversationAt = (engine: Engine, root: string, sid: string) => {
  const path = conversationFile(engine, root, sid);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

// A member turn, running. Its conversation is on disk (`write`), as the
// engine writes it at the first turn.
async function memberTurn(
  h: Harness,
  id: string,
  text: string,
  engine: Engine = "claude",
  write = true,
): Promise<FakeSession> {
  void h.mgr.sendMessage(id, text, "Alice");
  await waitUntil(
    () =>
      stateOf(h, id) === "thinking" &&
      sentTo(h, id).some((t) => t.endsWith(text)),
    `turn "${text}" running`,
  );
  const s = sessionWith(h, id, (t) => t.endsWith(text))!;
  if (write && engine !== undefined) writeConversation(engine, s);
  return s;
}

// The running turn ends on a usage limit. Codex ends such a turn failed.
function stopTurn(
  s: FakeSession,
  engine: Engine,
  stop: { resetsAtMs?: number; family?: FallbackFamily },
): void {
  s.push({ kind: "usage_limit_stop", ...stop });
  if (engine === "codex")
    s.push({
      kind: "turn_completed",
      status: "failed",
      error: "You've hit your usage limit.",
    });
  else s.completeTurn();
}

async function endTurn(h: Harness, id: string, s: FakeSession): Promise<void> {
  s.completeTurn({ text: "done" });
  await waitUntil(
    () => stateOf(h, id) === "waiting_for_response",
    "turn ended",
  );
}

// A member turn on Alice's own sign-in that a usage limit stops, and the
// continue on the office sign-in, running.
async function toOffice(
  h: Harness,
  id: string,
  engine: Engine,
  resetsAtMs: number,
): Promise<{ before: FakeSession; after: FakeSession }> {
  const before = await memberTurn(h, id, "work", engine);
  stopTurn(before, engine, { resetsAtMs });
  await waitUntil(() => continuesTo(h, id) === 1, "continue sent");
  const after = sessionWith(h, id, isContinue)!;
  await waitUntil(() => stateOf(h, id) === "thinking", "continue running");
  return { before, after };
}

describe("a stop on the member's own sign-in, with the switch on", () => {
  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: the conversation moves to the office sign-in and continues there, with one line`, async () => {
      const h = makeHarness();
      const info = await spawn(h, engine);
      const reset = h.office.clock.now() + 5 * HOUR;
      const { before, after } = await toOffice(h, info.id, engine, reset);
      const sid = before.sessionId;
      expect(accountOf(before, engine)).toBe(memberDir(engine));

      // The same conversation, resumed on the office sign-in after the old
      // session was closed.
      expect(before.closed).toBe(true);
      expect(after.isResume).toBe(true);
      expect(after.sessionId).toBe(sid);
      expect(accountOf(after, engine)).toBe(officeDir(engine));
      expect(conversationAt(engine, officeDir(engine), sid)).toBe(
        `conversation ${sid}\n`,
      );
      expect(conversationAt(engine, memberDir(engine), sid)).toBeNull();
      if (engine === "claude")
        expect(getSessionClaudeConfigDir(info.id, sid)).toBe(
          officeDir("claude"),
        );

      // The entry, and no wait for the reset.
      expect(h.office.store.entry(aliceId(), engine)?.until).toBe(reset);
      expect(persisted(info.id)?.limitResumeAt).toBeUndefined();
      expect(persisted(info.id)?.officeFallback).toBe(true);

      // The member reads the stop and the switch, not the continue text.
      expect(lines(h, info.id, STOPPED)).toHaveLength(1);
      const switched = lines(h, info.id, TO_OFFICE);
      expect(switched.map((e) => [e.kind, atOf(e)])).toEqual([
        ["system", reset],
      ]);
      expect(lines(h, info.id, BACK)).toEqual([]);
      expect(
        h.logs.some(
          (e) =>
            e.kind === "user_message" &&
            e.content.includes(FALLBACK_CONTINUE_TEXT),
        ),
      ).toBe(false);

      // Only agent sessions change: the member's env for everything else
      // (schedules, terminal, sign-in card) stays on her own sign-in.
      const env = h.mgr.buildEnvForUserId(aliceId());
      expect(
        engine === "claude" ? env?.CLAUDE_CONFIG_DIR : env?.CODEX_HOME,
      ).toBe(memberDir(engine));

      // The continue turn runs to its end on the office sign-in.
      await endTurn(h, info.id, after);
      expect(continuesTo(h, info.id)).toBe(1);
    });
  }

  it("the continue goes through the member usage cap, which counts the office sign-in", async () => {
    const reads = { count: 0 };
    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: {
          async read() {
            reads.count++;
            // Well ahead of any day's line.
            return {
              kind: "weekly",
              usedPercent: 99,
              resetsAtMs: Date.now() + WEEK_MS / 2,
              observedAtMs: Date.now(),
            };
          },
          invalidate() {},
          close() {},
        },
        officeDir: (provider) => officeDir(provider),
        load: () => true,
        save: () => {},
        loadShare: () => 80,
        saveShare: () => {},
      }),
    );
    const h = makeHarness();
    const info = await spawn(h);
    // Her own sign-in is not the office's: the cap lets her turn run.
    const s = await memberTurn(h, info.id, "work");
    stopTurn(s, "claude", { resetsAtMs: h.office.clock.now() + HOUR });
    await waitUntil(
      () => lines(h, info.id, TO_OFFICE).length === 1,
      "moved to the office",
    );
    await waitUntil(
      () =>
        h.logs.some(
          (e) =>
            e.kind === "error" &&
            (e.message ?? []).some(
              (p) =>
                typeof p === "object" &&
                p.key === "systemEntries.usageCap.pace",
            ),
        ),
      "the cap refused the continue",
    );
    await settle();
    expect(reads.count).toBeGreaterThan(0);
    expect(continuesTo(h, info.id)).toBe(0);
    expect(
      sessionsOf(h, info.id)
        .map((x) => accountOf(x))
        .at(-1),
    ).toBe(officeDir("claude"));
  });

  it("with the agent's resume after a limit off: no continue, and the next turn runs on the office sign-in", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    await h.mgr.editAgent(info.id, { limitResume: false });
    const reset = h.office.clock.now() + HOUR;
    const s = await memberTurn(h, info.id, "work");
    stopTurn(s, "claude", { resetsAtMs: reset });
    await waitUntil(
      () => stateOf(h, info.id) === "waiting_for_response",
      "at rest",
    );
    await settle();
    expect(continuesTo(h, info.id)).toBe(0);
    expect(h.office.store.entry(aliceId(), "claude")?.until).toBe(reset);
    expect(persisted(info.id)?.limitResumeAt).toBeUndefined();

    void h.mgr.sendMessage(info.id, "next", "Alice");
    await waitUntil(
      () => !!sessionWith(h, info.id, (t) => t.endsWith("next")),
      "next turn sent",
    );
    expect(accountOf(sessionWith(h, info.id, (t) => t.endsWith("next")))).toBe(
      officeDir("claude"),
    );
    expect(lines(h, info.id, TO_OFFICE)).toHaveLength(1);
  });
});

// What happens today, with nothing to fall back to: the turn waits for the
// reset.
describe("a stop with no fallback", () => {
  const cases: [string, (h: Harness) => void][] = [
    ["the switch is off", (h) => h.office.store.setEnabled(false)],
    [
      "the office has no sign-in",
      (h) => {
        h.office.accounts.claude = null;
      },
    ],
    [
      "the member has no own sign-in",
      () => {
        personal.claude = false;
        setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: officeDir("claude") });
      },
    ],
    [
      "a member variable points the agents at another folder",
      () => {
        writeManagedUserEnv(aliceId(), {
          CLAUDE_CONFIG_DIR: join(STATE_ROOT, "alice-own-folder"),
        });
      },
    ],
  ];
  for (const [why, given] of cases) {
    it(`${why}: the agent waits for the reset on the same sign-in`, async () => {
      const h = makeHarness();
      given(h);
      const info = await spawn(h);
      const reset = h.office.clock.now() + HOUR;
      const s = await memberTurn(h, info.id, "work");
      const account = accountOf(s);
      stopTurn(s, "claude", { resetsAtMs: reset });
      await waitUntil(
        () =>
          persisted(info.id)?.limitResumeAt === reset + LIMIT_RESUME_DELAY_MS,
        "resume armed",
      );
      await settle();
      expect(continuesTo(h, info.id)).toBe(0);
      expect(lines(h, info.id, TO_OFFICE)).toEqual([]);
      expect(lines(h, info.id, STOPPED)).toHaveLength(1);
      // The next turn stays in the same session.
      void h.mgr.sendMessage(info.id, "again", "Alice");
      await waitUntil(
        () => texts(s).some((t) => t.endsWith("again")),
        "next turn in the same session",
      );
      expect(sessionsOf(h, info.id).map((x) => accountOf(x))).toEqual([
        account,
      ]);
    });
  }
});

// Each turn start checks the account: every agent of the member on that
// provider moves at its next turn, whichever way the turn starts.
describe("the member's other agents", () => {
  async function onOwnSignIn(h: Harness) {
    const b = await spawn(h, "claude", { name: "B" });
    const s = await memberTurn(h, b.id, "first");
    await endTurn(h, b.id, s);
    return { b, s };
  }

  async function stopA(h: Harness, family?: FallbackFamily) {
    const a = await spawn(h, "claude", { name: "A" });
    const s = await memberTurn(h, a.id, "work");
    stopTurn(s, "claude", { resetsAtMs: h.office.clock.now() + HOUR, family });
    await waitUntil(() => continuesTo(h, a.id) === 1, "A continues");
    return a;
  }

  const starts: [string, (h: Harness, id: string) => string][] = [
    [
      "a member's message",
      (h, id) => {
        void h.mgr.sendMessage(id, "from Alice", "Alice");
        return "from Alice";
      },
    ],
    [
      "a queued message from another agent",
      (h, id) => {
        expect(
          h.mgr.enqueueMessage(id, { sender: OTHER, text: "from Other" }).ok,
        ).toBe(true);
        return "from Other";
      },
    ],
    [
      "a skill",
      (h, id) => {
        const dir = join(STATE_ROOT, "skills", "fallbackskill");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), "Skill body for the fallback.");
        void h.mgr.sendMessage(id, "/fallbackskill", "Alice");
        return "Skill body for the fallback.";
      },
    ],
  ];
  for (const [how, start] of starts) {
    it(`moves at its next turn: ${how}`, async () => {
      const h = makeHarness();
      const { b, s } = await onOwnSignIn(h);
      await stopA(h);
      expect(accountOf(s)).toBe(memberDir("claude"));

      const text = start(h, b.id);
      await waitUntil(
        () => !!sessionWith(h, b.id, (t) => t.includes(text)),
        "B's turn sent",
      );
      const moved = sessionWith(h, b.id, (t) => t.includes(text))!;
      // The turn went to the moved conversation, never to the old session.
      expect(texts(s).some((t) => t.includes(text))).toBe(false);
      expect(s.closed).toBe(true);
      expect(moved.sessionId).toBe(s.sessionId);
      expect(accountOf(moved)).toBe(officeDir("claude"));
      expect(
        conversationAt("claude", officeDir("claude"), s.sessionId),
      ).not.toBe(null);
      expect(lines(h, b.id, TO_OFFICE)).toHaveLength(1);
      // And it ends there.
      await endTurn(h, b.id, moved);
    });
  }

  it("a stop of one model family's weekly limit moves only that family's agents", async () => {
    const h = makeHarness();
    const sonnet = await spawn(h, "claude", {
      name: "Sonnet",
      modelFamily: "sonnet",
    });
    const s = await memberTurn(h, sonnet.id, "first");
    await endTurn(h, sonnet.id, s);
    const opus = await stopA(h, "opus");
    // The agent that stopped is on Opus, and moved.
    expect(h.office.store.entry(aliceId(), "claude")?.family).toBe("opus");
    expect(accountOf(sessionWith(h, opus.id, isContinue))).toBe(
      officeDir("claude"),
    );

    void h.mgr.sendMessage(sonnet.id, "still mine", "Alice");
    await waitUntil(
      () => texts(s).some((t) => t.endsWith("still mine")),
      "Sonnet's turn in its own session",
    );
    expect(sessionsOf(h, sonnet.id)).toHaveLength(1);
    expect(lines(h, sonnet.id, TO_OFFICE)).toEqual([]);
  });

  it("a new conversation and a new agent start on the office sign-in", async () => {
    const h = makeHarness();
    const { b } = await onOwnSignIn(h);
    await stopA(h);

    await h.mgr.newConversation(b.id);
    void h.mgr.sendMessage(b.id, "fresh", "Alice");
    await waitUntil(
      () => !!sessionWith(h, b.id, (t) => t.endsWith("fresh")),
      "fresh turn sent",
    );
    const fresh = sessionWith(h, b.id, (t) => t.endsWith("fresh"))!;
    expect(fresh.isResume).toBe(false);
    expect(accountOf(fresh)).toBe(officeDir("claude"));
    expect(lines(h, b.id, TO_OFFICE)).toHaveLength(1);

    const c = await spawn(h, "claude", { name: "C" });
    void h.mgr.sendMessage(c.id, "hello", "Alice");
    await waitUntil(
      () => !!sessionWith(h, c.id, (t) => t.endsWith("hello")),
      "C's first turn sent",
    );
    expect(sessionsOf(h, c.id).map((x) => accountOf(x))).toEqual([
      officeDir("claude"),
    ]);
    expect(lines(h, c.id, TO_OFFICE)).toHaveLength(1);
  });
});

describe("back to the member's own sign-in", () => {
  const ways: [string, (h: Harness, reset: number) => Promise<void> | void][] =
    [
      [
        "her limit resets",
        (h, reset) => h.office.clock.advance(reset - h.office.clock.now()),
      ],
      ["the switch goes off", (h) => h.office.store.setEnabled(false)],
      [
        "the office sign-in is gone",
        (h) => {
          h.office.accounts.claude = null;
        },
      ],
      [
        "her own account changes",
        (h) => h.office.store.accountChanged(aliceId(), "claude"),
      ],
    ];
  for (const [why, given] of ways) {
    it(`at the next turn after ${why}, with one line`, async () => {
      const h = makeHarness();
      const info = await spawn(h);
      const reset = h.office.clock.now() + HOUR;
      const { before, after } = await toOffice(h, info.id, "claude", reset);
      await endTurn(h, info.id, after);
      const sid = before.sessionId;

      await given(h, reset);
      void h.mgr.sendMessage(info.id, "later", "Alice");
      await waitUntil(
        () => !!sessionWith(h, info.id, (t) => t.endsWith("later")),
        "later turn sent",
      );
      const back = sessionWith(h, info.id, (t) => t.endsWith("later"))!;
      expect(after.closed).toBe(true);
      expect(back.sessionId).toBe(sid);
      expect(accountOf(back)).toBe(memberDir("claude"));
      expect(conversationAt("claude", memberDir("claude"), sid)).toBe(
        `conversation ${sid}\n`,
      );
      expect(conversationAt("claude", officeDir("claude"), sid)).toBeNull();
      expect(getSessionClaudeConfigDir(info.id, sid)).toBe(memberDir("claude"));
      expect(lines(h, info.id, BACK).map((e) => e.kind)).toEqual(["system"]);
      expect(lines(h, info.id, TO_OFFICE)).toHaveLength(1);
      expect(persisted(info.id)?.officeFallback).toBeUndefined();
    });
  }
});

describe("back to the member's own sign-in, from a released Codex agent", () => {
  it("finds the thread in the office home and moves it back at the next turn", async () => {
    const h = makeHarness();
    const info = await spawn(h, "codex");
    const reset = h.office.clock.now() + HOUR;
    const { before, after } = await toOffice(h, info.id, "codex", reset);
    await endTurn(h, info.id, after);
    const sid = before.sessionId;
    expect(accountOf(after, "codex")).toBe(officeDir("codex"));
    expect(conversationAt("codex", officeDir("codex"), sid)).not.toBeNull();
    // No live session tells where the thread is.
    expect(await h.mgr.demoteToLazy(info.id)).toBe(true);
    await h.office.clock.advance(reset - h.office.clock.now());

    void h.mgr.sendMessage(info.id, "later", "Alice");
    await waitUntil(
      () => !!sessionWith(h, info.id, (t) => t.endsWith("later")),
      "later turn sent",
    );
    const back = sessionWith(h, info.id, (t) => t.endsWith("later"))!;
    expect(back.sessionId).toBe(sid);
    expect(accountOf(back, "codex")).toBe(memberDir("codex"));
    expect(conversationAt("codex", memberDir("codex"), sid)).toBe(
      `conversation ${sid}\n`,
    );
    expect(conversationAt("codex", officeDir("codex"), sid)).toBeNull();
    expect(lines(h, info.id, BACK)).toHaveLength(1);
  });
});

// The office sign-in as the office has it: its variables name the folder,
// and the folder holds the sign-in. An office variable sets the office key.
describe("the office's own sign-in", () => {
  // The process env of the run can carry a Claude credential, which would
  // count as a sign-in of every folder.
  const noClaudeCredential = {
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };

  for (const signedIn of [true, false]) {
    it(`claude, ${signedIn ? "signed in: the stop moves the agent there" : "signed out: the agent waits for the reset"}`, async () => {
      setTestManagedOfficeEnv({
        ...noClaudeCredential,
        CLAUDE_CONFIG_DIR: officeDir("claude"),
      });
      mkdirSync(officeDir("claude"), { recursive: true });
      if (signedIn)
        writeFileSync(join(officeDir("claude"), ".credentials.json"), "{}");
      const h = makeHarness(makeOffice(), [], { realOffice: true });
      const info = await spawn(h);
      const reset = h.office.clock.now() + HOUR;
      const s = await memberTurn(h, info.id, "work");
      expect(accountOf(s)).toBe(memberDir("claude"));
      stopTurn(s, "claude", { resetsAtMs: reset });
      if (signedIn) {
        await waitUntil(() => continuesTo(h, info.id) === 1, "continue sent");
        expect(accountOf(sessionWith(h, info.id, isContinue))).toBe(
          officeDir("claude"),
        );
      } else {
        await waitUntil(
          () =>
            persisted(info.id)?.limitResumeAt === reset + LIMIT_RESUME_DELAY_MS,
          "resume armed",
        );
        await settle();
        expect(continuesTo(h, info.id)).toBe(0);
        expect(lines(h, info.id, TO_OFFICE)).toEqual([]);
      }
    });
  }

  it("opencode: an office variable is the office key", async () => {
    setTestManagedOfficeEnv({ OPENCODE_API_KEY: OFFICE_KEY });
    writeManagedUserEnv(aliceId(), { OPENCODE_API_KEY: MEMBER_KEY });
    const h = makeHarness(makeOffice(), [], {
      realOffice: true,
      capabilities: { limitResume: false },
    });
    const info = await spawn(h, "opencode");
    void h.mgr.sendMessage(info.id, "work", "Alice");
    await waitUntil(
      () => !!sessionWith(h, info.id, (t) => t.endsWith("work")),
      "turn sent",
    );
    const s = sessionWith(h, info.id, (t) => t.endsWith("work"))!;
    expect(accountOf(s, "opencode")).toBe(MEMBER_KEY);
    s.push({ kind: "usage_limit_stop" });
    s.push({
      kind: "turn_completed",
      status: "failed",
      error: "Quota exceeded for this plan.",
    });
    await waitUntil(() => continuesTo(h, info.id) === 1, "continue sent");
    expect(accountOf(sessionWith(h, info.id, isContinue), "opencode")).toBe(
      OFFICE_KEY,
    );
  });
});

describe("a move that fails", () => {
  it("leaves the conversation on the member's sign-in, and the agent waits for the reset", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.office.clock.now() + HOUR;
    // The conversation is not on disk, so it cannot be copied.
    const s = await memberTurn(h, info.id, "work", "claude", false);
    stopTurn(s, "claude", { resetsAtMs: reset });
    await waitUntil(
      () => persisted(info.id)?.limitResumeAt === reset + LIMIT_RESUME_DELAY_MS,
      "today's resume armed",
    );
    await settle();
    // The stop was the member's, with the switch on: the entry stays, so a
    // later turn tries the move again.
    expect(h.office.store.entry(aliceId(), "claude")?.until).toBe(reset);
    expect(continuesTo(h, info.id)).toBe(0);
    expect(lines(h, info.id, TO_OFFICE)).toEqual([]);
    expect(lines(h, info.id, STOPPED)).toHaveLength(1);
    // No error line: the console has the reason.
    expect(h.logs.filter((e) => e.kind === "error")).toEqual([]);
    expect(
      sessionsOf(h, info.id).every((x) => accountOf(x) === memberDir("claude")),
    ).toBe(true);
    expect(persisted(info.id)?.officeFallback).toBeUndefined();
  });
});

describe("a stop on the office sign-in", () => {
  for (const [label, officeOffset] of [
    ["the office resets first", HOUR],
    ["the member resets first", 9 * HOUR],
  ] as const) {
    it(`waits for the earlier reset: ${label}`, async () => {
      const h = makeHarness();
      const info = await spawn(h);
      const reset = h.office.clock.now() + 5 * HOUR;
      const { after } = await toOffice(h, info.id, "claude", reset);
      const officeReset = h.office.clock.now() + officeOffset;
      stopTurn(after, "claude", { resetsAtMs: officeReset });
      const due = Math.min(reset, officeReset) + LIMIT_RESUME_DELAY_MS;
      await waitUntil(
        () => persisted(info.id)?.limitResumeAt === due,
        "resume armed",
      );
      await settle();
      // The member's entry is unchanged, and no second continue.
      expect(h.office.store.entry(aliceId(), "claude")?.until).toBe(reset);
      expect(continuesTo(h, info.id)).toBe(1);
    });
  }

  it("the resume after the member's reset runs on her own sign-in again", async () => {
    const h = makeHarness();
    const info = await spawn(h);
    const reset = h.office.clock.now() + HOUR;
    const { before, after } = await toOffice(h, info.id, "claude", reset);
    stopTurn(after, "claude", { resetsAtMs: h.office.clock.now() + 9 * HOUR });
    await waitUntil(
      () => persisted(info.id)?.limitResumeAt === reset + LIMIT_RESUME_DELAY_MS,
      "resume armed",
    );
    await h.office.clock.advance(
      reset + LIMIT_RESUME_DELAY_MS - h.office.clock.now(),
    );
    await waitUntil(
      () => sentTo(h, info.id).some((t) => t.includes(LIMIT_RESUME_TEXT)),
      "resume sent",
    );
    const resumed = sessionWith(h, info.id, (t) =>
      t.includes(LIMIT_RESUME_TEXT),
    )!;
    expect(resumed.sessionId).toBe(before.sessionId);
    expect(accountOf(resumed)).toBe(memberDir("claude"));
    expect(lines(h, info.id, BACK)).toHaveLength(1);
  });
});

describe("across a server restart", () => {
  // The next boot on the same state root, from agents.json and the persisted
  // queues as the office boots. The fallback state and the clock carry over
  // (the store's own persistence is in server/provider-fallback.test.ts).
  async function restart(office: Office): Promise<Harness> {
    const h = makeHarness(office, loadAgents());
    await h.mgr.restoreAgents();
    return h;
  }

  it("a continue queued before the restart moves the conversation after it, and the way back still has its line", async () => {
    const h1 = makeHarness();
    const info = await spawn(h1);
    const reset = h1.office.clock.now() + HOUR;
    const s = await memberTurn(h1, info.id, "work");
    // The restart comes before the continue's flush.
    h1.mgr._testHoldQueue(info.id);
    stopTurn(s, "claude", { resetsAtMs: reset });
    await waitUntil(
      () => stateOf(h1, info.id) === "waiting_for_response",
      "at rest",
    );
    const queued = loadMessageQueuesRaw()[info.id] as
      | { queue: { text: string; fallbackContinue?: boolean }[] }
      | undefined;
    expect(
      (queued?.queue ?? []).map((m) => [m.text, m.fallbackContinue]),
    ).toEqual([[FALLBACK_CONTINUE_TEXT, true]]);

    const h2 = await restart(h1.office);
    await waitUntil(() => continuesTo(h2, info.id) === 1, "continue sent");
    const after = sessionWith(h2, info.id, isContinue)!;
    expect(accountOf(after)).toBe(officeDir("claude"));
    expect(lines(h2, info.id, TO_OFFICE)).toHaveLength(1);
    expect(
      h2.logs.some(
        (e) =>
          e.kind === "user_message" &&
          e.content.includes(FALLBACK_CONTINUE_TEXT),
      ),
    ).toBe(false);
    await endTurn(h2, info.id, after);

    // Still on the office sign-in after the next restart: the way back
    // writes its line.
    const h3 = await restart(h1.office);
    await h1.office.clock.advance(reset - h1.office.clock.now());
    void h3.mgr.sendMessage(info.id, "later", "Alice");
    await waitUntil(
      () => !!sessionWith(h3, info.id, (t) => t.endsWith("later")),
      "later turn sent",
    );
    expect(
      accountOf(sessionWith(h3, info.id, (t) => t.endsWith("later"))),
    ).toBe(memberDir("claude"));
    expect(lines(h3, info.id, BACK)).toHaveLength(1);
  });
});

// OpenCode signs in with OPENCODE_API_KEY; all of a member's OpenCode agents
// share one server, which starts with one key.
describe("OpenCode", () => {
  async function refusedTurn(h: Harness, id: string): Promise<FakeSession> {
    void h.mgr.sendMessage(id, "work", "Alice");
    await waitUntil(
      () =>
        stateOf(h, id) === "thinking" &&
        sentTo(h, id).some((t) => t.endsWith("work")),
      "turn running",
    );
    const s = sessionWith(h, id, (t) => t.endsWith("work"))!;
    // OpenCode Zen or Go refused the request: no reset time.
    s.push({ kind: "usage_limit_stop" });
    s.push({
      kind: "turn_completed",
      status: "failed",
      error: "Quota exceeded for this plan.",
    });
    return s;
  }
  const refusalLines = (h: Harness) =>
    h.logs.filter(
      (e) => e.kind === "error" && e.content.includes("Quota exceeded"),
    );

  // OpenCode has no resume after a usage limit (capabilities.limitResume).
  const openCodeHarness = () =>
    makeHarness(makeOffice(), [], { capabilities: { limitResume: false } });

  it("a refusal of the member's key moves her OpenCode agents to the office key, and tries her key again after an hour", async () => {
    writeManagedUserEnv(aliceId(), { OPENCODE_API_KEY: MEMBER_KEY });
    const h = openCodeHarness();
    const other = await spawn(h, "opencode", { name: "Other" });
    const first = await memberTurn(h, other.id, "first", "claude", false);
    await endTurn(h, other.id, first);
    const info = await spawn(h, "opencode");
    const stoppedAt = h.office.clock.now();
    const s = await refusedTurn(h, info.id);
    expect(accountOf(s, "opencode")).toBe(MEMBER_KEY);

    await waitUntil(() => continuesTo(h, info.id) === 1, "continue sent");
    const after = sessionWith(h, info.id, isContinue)!;
    expect(accountOf(after, "opencode")).toBe(OFFICE_KEY);
    // A new environment revision: the member's server starts again with the
    // office key.
    expect(after.opts.environmentRevision).not.toBe(s.opts.environmentRevision);
    expect(h.office.store.entry(aliceId(), "opencode")?.until).toBe(
      stoppedAt + OPENCODE_FALLBACK_RETRY_MS,
    );
    const switched = lines(h, info.id, TO_OFFICE);
    expect(switched.map(atOf)).toEqual([
      stoppedAt + OPENCODE_FALLBACK_RETRY_MS,
    ]);
    expect(lines(h, info.id, STOPPED)).toEqual([]);
    expect(persisted(info.id)?.limitResumeAt).toBeUndefined();

    // Her other OpenCode agent uses the office key from its next turn.
    void h.mgr.sendMessage(other.id, "next", "Alice");
    await waitUntil(
      () => !!sessionWith(h, other.id, (t) => t.endsWith("next")),
      "other agent's turn sent",
    );
    expect(
      accountOf(
        sessionWith(h, other.id, (t) => t.endsWith("next")),
        "opencode",
      ),
    ).toBe(OFFICE_KEY);

    // A refusal of the office key is no new stop of hers: it stays the
    // turn's error, and the agent moves back at its first turn after the
    // hour.
    await waitUntil(() => stateOf(h, info.id) === "thinking", "continue runs");
    const refusalsBefore = refusalLines(h).length;
    after.push({ kind: "usage_limit_stop" });
    after.push({
      kind: "turn_completed",
      status: "failed",
      error: "Quota exceeded for this plan.",
    });
    await waitUntil(
      () => refusalLines(h).length === refusalsBefore + 1,
      "refusal shown",
    );
    await settle();
    expect(h.office.store.entry(aliceId(), "opencode")?.until).toBe(
      stoppedAt + OPENCODE_FALLBACK_RETRY_MS,
    );
    expect(continuesTo(h, info.id)).toBe(1);
    expect(persisted(info.id)?.limitResumeAt).toBeUndefined();

    await h.office.clock.advance(OPENCODE_FALLBACK_RETRY_MS);
    void h.mgr.sendMessage(info.id, "after the hour", "Alice");
    await waitUntil(
      () => !!sessionWith(h, info.id, (t) => t.endsWith("after the hour")),
      "turn after the hour sent",
    );
    expect(
      accountOf(
        sessionWith(h, info.id, (t) => t.endsWith("after the hour")),
        "opencode",
      ),
    ).toBe(MEMBER_KEY);
    expect(lines(h, info.id, BACK)).toHaveLength(1);
  });

  const unchanged: [string, (h: Harness) => void][] = [
    ["the switch is off", (h) => h.office.store.setEnabled(false)],
    [
      "her key is the office key",
      () => writeManagedUserEnv(aliceId(), { OPENCODE_API_KEY: OFFICE_KEY }),
    ],
    [
      "she has no key of her own",
      () => setTestManagedOfficeEnv({ OPENCODE_API_KEY: OFFICE_KEY }),
    ],
  ];
  for (const [why, given] of unchanged) {
    it(`${why}: a refusal stays the turn's error, as today`, async () => {
      if (why !== "she has no key of her own")
        writeManagedUserEnv(aliceId(), { OPENCODE_API_KEY: MEMBER_KEY });
      const h = openCodeHarness();
      given(h);
      const info = await spawn(h, "opencode");
      await refusedTurn(h, info.id);
      await waitUntil(() => refusalLines(h).length === 1, "refusal shown");
      await settle();
      expect(continuesTo(h, info.id)).toBe(0);
      expect(lines(h, info.id, TO_OFFICE)).toEqual([]);
      expect(lines(h, info.id, STOPPED)).toEqual([]);
      expect(persisted(info.id)?.limitResumeAt).toBeUndefined();
      expect(stateOf(h, info.id)).toBe("error");
    });
  }
});
