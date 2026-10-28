// The secret request end to end with the real agent manager (secrets loop,
// B4 acceptance): the agent asks, the member saves the value in the ask, the
// agent's next process has the placeholder, and neither the transcript nor
// anything sent to the agent holds the value. The outcome is a system line in
// the chat and the same line to the agent as an office notice, never a
// message from the member (task 9019f2f8). FakeBackend only.

import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import { msg, type LogMessage } from "../../shared/i18n/log-message.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setSecretEnvironmentProvider } from "../env-loader.ts";
import { createAskStore, type AskStore } from "../asks.ts";
import { createSecretRequests } from "../secret-requests.ts";
import { createSecretStore, type SecretScope } from "../secret-store.ts";
import { placeholderFor } from "../secret-proxy/placeholders.ts";
import { loadMessageQueuesRaw } from "../persistence.ts";
import { createMember, getUserById, getUserByName } from "../users.ts";
import {
  createMemberUsageCap,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import { WEEK_MS } from "../office-usage.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

// An office agent running this suite has its own GH_TOKEN stand-in and proxy
// variables in the host env; the manager would hand them to the fake session.
for (const name of [
  "GH_TOKEN",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
])
  delete process.env[name];

const VALUE = "ghp_FAKEdiaskFAKEdiaskFAKEdiaskFAKEdiask0";
const KEY = Buffer.alloc(32, 9);

// Real members, so the turn's member ids and the usage cap resolve them. The
// user store outlives the state dir reset in a multi-file run.
function memberId(name: string, role: "owner" | "member"): string {
  const known = getUserByName(name);
  if (known) return known.id;
  const created = createMember(name, { role });
  if (!created.ok) throw new Error(created.error);
  return created.user.id;
}
const MANAGER_NAME = "Sereq Manager";
const OWNER_NAME = "Sereq Owner";
const USER = memberId(MANAGER_NAME, "member");
const OWNER = memberId(OWNER_NAME, "owner");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

const ROOMS: RoomWire[] = [
  { id: "room-a", name: "room-a", prompt: null, canCloseWhenEmpty: false },
];
const claudeHome = () => join(STATE_ROOT, "claude-home-secret-requests");

const PROXY = "http://127.0.0.1:9";

const roots: string[] = [];
const restores: Parameters<typeof setSecretEnvironmentProvider>[0][] = [];
afterEach(() => {
  for (const restore of restores.splice(0))
    setSecretEnvironmentProvider(restore);
  clearTestManagedOfficeEnv();
  setMemberUsageCapForTests(null);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function world() {
  setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-requests-di-"));
  roots.push(root);
  const store = createSecretStore(root);
  const placeholderOf = (scope: SecretScope, name: string) => {
    const secret = store.readForProxy(scope).find((s) => s.name === name);
    return secret
      ? placeholderFor(KEY, scope, name, secret.generation, secret.value)
      : null;
  };
  // Every send completes its turn, except while `hold` is set.
  const hold = { value: false };
  const fake = new FakeBackend({
    session: {
      onSend: (_text, _a, s) => {
        if (!hold.value) s.completeTurn({ text: "ok" });
      },
    },
  });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: ROOMS }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  const asks: AskStore = createAskStore({
    persistence: {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    },
  });
  const requests = createSecretRequests({
    store,
    asks,
    audience: {
      isOfficeOwner: (userId) => getUserById(userId)?.role === "owner",
      agentRoomId: (agentId) => mgr.getAgent(agentId)?.roomId ?? null,
      canSeeRoom: () => true,
    },
    onChanged: async () => mgr.envChanged([{ kind: "user", userId: USER }]),
    agentUserId: (agentId) =>
      mgr.getAgent(agentId)
        ? (mgr.getAgent(agentId)!.userId ?? null)
        : undefined,
    appFor: () => null,
    memberByName: (name) => {
      const user = getUserByName(name);
      return user ? { id: user.id, name: user.name } : null;
    },
    memberName: (userId) => getUserById(userId)?.name ?? null,
    // The variable and MCP server writes (task c71cb60f): unused here.
    writes: {
      setVariable: () => {
        throw new Error("unused");
      },
      createMcpServer: () => {
        throw new Error("unused");
      },
    },
    variableExists: () => false,
    mcpServerExists: () => false,
    settled: (agentId, requestId, outcome, line, answeredBy) =>
      mgr.emitAgentSecretRequestSettled(
        agentId,
        requestId,
        outcome,
        line,
        answeredBy,
      ),
  });
  // The environment the spawn gets: the store's placeholders and the proxy,
  // as the secrets runtime builds them.
  const restore = setSecretEnvironmentProvider((userId) => {
    if (userId !== USER) return null;
    const member: Record<string, string> = {};
    for (const s of store.readForProxy({ kind: "user", userId: USER }))
      member[s.name] = placeholderOf({ kind: "user", userId: USER }, s.name)!;
    return Object.keys(member).length === 0
      ? null
      : {
          office: {},
          member,
          fixed: { HTTPS_PROXY: PROXY },
          gitCredentials: [],
          revision: JSON.stringify(member),
        };
  });
  restores.push(restore);

  const info = await mgr.spawn(
    "Asker",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    "room-a",
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    USER,
  );
  const id = info!.id;
  // A name that is no member: the first turn belongs to no one, so a turn
  // the outcome starts shows whose it is.
  mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "not-a-member" },
    text: "wake",
  });
  await waitUntil(
    () =>
      mgr.getCurrentSessionId(id) !== null &&
      mgr.getAgent(id)?.state === "waiting_for_response",
    "live",
  );
  const dir = claudeProjectDir(STATE_ROOT, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mgr.getCurrentSessionId(id)}.jsonl`), "");
  expect(mgr.getAgent(id)?.turnMemberIds).toEqual([]);
  return { mgr, fake, asks, requests, placeholderOf, id, hold };
}

type World = Awaited<ReturnType<typeof world>>;

function ask({ requests, id }: World, member?: string) {
  const asked = requests.open(id, {
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    reason: "To open the pull request.",
    ...(member ? { member } : {}),
  });
  if (!asked.ok) throw new Error(asked.code);
  return asked.requestId;
}

// The chat entries that settle the request.
function settledEntries(w: World, requestId: string): LogEntry[] {
  return w.mgr
    .getAgentLogs(w.id)
    .filter((e) => e.metadata?.secretRequestSettled === requestId);
}
const memberMessages = (w: World) =>
  w.mgr.getAgentLogs(w.id).filter((e) => e.kind === "user_message").length;

// The outcome as the chat stores it: one system line holding `line`, with the
// metadata that settles the request's card. Returns its English text.
function expectSettledLine(
  w: World,
  requestId: string,
  outcome: "saved" | "declined",
  line: LogMessage,
): string {
  const entries = settledEntries(w, requestId);
  expect(entries.map((e) => [e.kind, e.message, e.metadata?.outcome])).toEqual([
    ["system", [line], outcome],
  ]);
  return entries[0].content;
}

// What the agent reads for the outcome: the system line's English inside an
// office notice. A new process puts its own wake text before it.
const noticeOf = (english: string) => `[Isomux: ${english}]`;
const sentTexts = (w: World) =>
  w.fake.sessions
    .filter((s) => s.opts.agentId === w.id)
    .flatMap((s) => s.sent.map((m) => m.text));
// The sends that carry the notice, each checked for a member label.
function noticeSends(w: World, notice: string): string[] {
  const sends = sentTexts(w).filter((t) => t.endsWith(notice));
  for (const name of [MANAGER_NAME, OWNER_NAME])
    expect(sends.filter((t) => t.includes(`[${name}`))).toEqual([]);
  return sends;
}

// What the acceptance asks of the turn that the outcome starts: a new
// process whose environment has the placeholder and the proxy, the notice,
// a settled entry, a closed ask, and the value nowhere.
async function expectConfirmedOnNewProcess(
  w: World,
  requestId: string,
  firstSession: ReturnType<FakeBackend["sessionForAgent"]>,
  notice: string,
) {
  const placeholder = w.placeholderOf(
    { kind: "user", userId: USER },
    "GH_TOKEN",
  )!;
  expect(placeholder).not.toBe(VALUE);
  await waitUntil(
    () =>
      w.fake.sessionForAgent(w.id) !== firstSession &&
      w.fake.sessionForAgent(w.id)!.sent.some((m) => m.text.endsWith(notice)),
    "told on a new process",
  );
  expect(noticeSends(w, notice)).toHaveLength(1);
  const next = w.fake.sessionForAgent(w.id)!;
  expect(next.opts.env?.GH_TOKEN).toBe(placeholder);
  expect(next.opts.env?.HTTPS_PROXY).toBe(PROXY);
  // The notice ran on the new process only.
  expect(firstSession!.sent.some((m) => m.text.endsWith(notice))).toBe(false);
  expect(w.asks.listAll()).toEqual([]);
  const seen = JSON.stringify({
    logs: w.mgr.getAgentLogs(w.id),
    sent: [...firstSession!.sent, ...next.sent],
    env: next.opts.env,
  });
  expect(seen).not.toContain(VALUE);
  expect(seen).toContain(placeholder);
}

it("idle: the agent asks, the member saves in the masked form, and the outcome runs on a new process with the placeholder and the proxy", async () => {
  const w = await world();
  const firstSession = w.fake.sessionForAgent(w.id)!;
  // Presence only: a failure must never print a token value.
  expect(firstSession.opts.env?.GH_TOKEN === undefined).toBe(true);
  expect(firstSession.opts.env?.HTTPS_PROXY === undefined).toBe(true);
  const requestId = ask(w);
  // The request waits as an ask, not as a card in the chat.
  expect(w.asks.listForAgent(w.id).map((e) => e.secret?.requestId)).toEqual([
    requestId,
  ]);
  expect(
    w.mgr.getAgentLogs(w.id).some((e) => e.kind === "secret-request"),
  ).toBe(false);
  const before = memberMessages(w);
  const saved = await w.requests.save(USER, w.id, requestId, {
    value: VALUE,
    hosts: ["api.github.com"],
  });
  expect(saved.ok).toBe(true);
  const english = expectSettledLine(
    w,
    requestId,
    "saved",
    msg("systemEntries.secretRequest.savedPersonal", {
      name: "GH_TOKEN",
      member: MANAGER_NAME,
    }),
  );
  await expectConfirmedOnNewProcess(
    w,
    requestId,
    firstSession,
    noticeOf(english),
  );
  // The notice's delivery added no message from the member; its turn is the
  // member's who answered.
  expect(memberMessages(w)).toBe(before);
  expect(settledEntries(w, requestId)).toHaveLength(1);
  expect(w.mgr.getAgent(w.id)?.turnMemberIds).toEqual([USER]);
});

it("a member other than the manager saves: the turn the notice starts is theirs", async () => {
  const w = await world();
  const requestId = ask(w, OWNER_NAME);
  const saved = await w.requests.save(OWNER, w.id, requestId, {
    value: VALUE,
  });
  expect(saved.ok).toBe(true);
  const english = expectSettledLine(
    w,
    requestId,
    "saved",
    msg("systemEntries.secretRequest.savedPersonal", {
      name: "GH_TOKEN",
      member: MANAGER_NAME,
    }),
  );
  await waitUntil(
    () => sentTexts(w).some((t) => t.endsWith(noticeOf(english))),
    "notice delivered",
  );
  expect(noticeSends(w, noticeOf(english))).toHaveLength(1);
  await waitUntil(
    () => w.mgr.getAgent(w.id)?.state === "waiting_for_response",
    "notice turn done",
  );
  expect(w.mgr.getAgent(w.id)?.turnMemberIds).toEqual([OWNER]);
});

it("the usage cap refuses the manager's machine input: the notice of an owner's save still reaches the agent", async () => {
  const w = await world();
  setMemberUsageCapForTests(
    createMemberUsageCap({
      reader: {
        async read() {
          return {
            kind: "weekly",
            usedPercent: 90,
            resetsAtMs: Date.now() + WEEK_MS / 2,
            observedAtMs: Date.now(),
          };
        },
        invalidate() {},
        close() {},
      },
      officeDir: () => claudeHome(),
      load: () => true,
    }),
  );
  // The cap is in force for this agent: input from no member is refused.
  await w.mgr.prepareEnqueue(w.id);
  const machine = w.mgr.enqueueMessage(w.id, {
    sender: {
      kind: "agent",
      agentId: w.id,
      agentName: "Asker",
      roomName: "room-a",
    },
    text: "machine input",
  });
  expect(machine.ok ? "accepted" : machine.error).toBe("usage_cap");
  const requestId = ask(w, OWNER_NAME);
  const saved = await w.requests.save(OWNER, w.id, requestId, {
    value: VALUE,
  });
  expect(saved.ok).toBe(true);
  const english = settledEntries(w, requestId)[0]?.content;
  expect(typeof english).toBe("string");
  await waitUntil(
    () => sentTexts(w).some((t) => t.endsWith(noticeOf(english))),
    "notice delivered under the cap",
  );
});

it("a decline: the system line, and the agent reads it as a notice, with no member message", async () => {
  const w = await world();
  const requestId = ask(w);
  const before = memberMessages(w);
  expect(w.requests.decline(USER, w.id, requestId).ok).toBe(true);
  const english = expectSettledLine(
    w,
    requestId,
    "declined",
    msg("systemEntries.secretRequest.declined", { name: "GH_TOKEN" }),
  );
  // A decline changes no secret, so the same process reads the notice alone.
  await waitUntil(
    () => sentTexts(w).includes(noticeOf(english)),
    "notice delivered",
  );
  await waitUntil(
    () => w.mgr.getAgent(w.id)?.state === "waiting_for_response",
    "notice turn done",
  );
  expect(memberMessages(w)).toBe(before);
  expect(w.mgr.getAgent(w.id)?.turnMemberIds).toEqual([USER]);
});

it("an outcome during a turn waits as a notice, on disk too, and goes out as the notice alone when the turn ends", async () => {
  const w = await world();
  const requestId = ask(w);
  w.hold.value = true;
  w.mgr.enqueueMessage(w.id, {
    sender: { kind: "user", username: "not-a-member" },
    text: "keep working",
  });
  await waitUntil(
    () => sentTexts(w).some((t) => t.endsWith("keep working")),
    "busy turn running",
  );
  const before = memberMessages(w);
  expect(w.requests.decline(USER, w.id, requestId).ok).toBe(true);
  const english = settledEntries(w, requestId)[0]?.content;
  expect(typeof english).toBe("string");
  const queueOf = () =>
    w.mgr.getAllAgents().find((a) => a.id === w.id)?.queue ?? [];
  await waitUntil(() => queueOf().length > 0, "notice queued");
  const live = queueOf();
  expect(live.map((m) => [m.text, m.notice === true])).toEqual([
    [noticeOf(english), true],
  ]);
  const record = loadMessageQueuesRaw()[w.id] as {
    queue: { text: string; notice?: boolean }[];
  };
  expect(record.queue.map((m) => [m.text, m.notice === true])).toEqual([
    [noticeOf(english), true],
  ]);
  w.hold.value = false;
  w.fake.sessionForAgent(w.id)!.completeTurn({ text: "done" });
  // No note that a sender had not seen the last reply: the notice has no
  // sender talking to the agent.
  await waitUntil(
    () => sentTexts(w).includes(noticeOf(english)),
    "notice delivered after the turn",
  );
  await waitUntil(
    () => w.mgr.getAgent(w.id)?.state === "waiting_for_response",
    "notice turn done",
  );
  expect(memberMessages(w)).toBe(before);
});
