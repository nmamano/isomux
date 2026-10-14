// The secret request end to end with the real agent manager (secrets loop,
// B4 acceptance): the agent asks, the member saves the value on the card, the
// agent's next process has the placeholder, and neither the transcript nor
// anything sent to the agent holds the value. FakeBackend only.

import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setSecretEnvironmentProvider } from "../env-loader.ts";
import { createSecretRequests } from "../secret-requests.ts";
import { createSecretStore, type SecretScope } from "../secret-store.ts";
import { placeholderFor } from "../secret-proxy/placeholders.ts";
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
const USER = "u-alice";

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
  // Every send completes its turn, except "hold", which stays busy until the
  // test completes it.
  const fake = new FakeBackend({
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: ROOMS }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  const requests = createSecretRequests({
    store,
    onChanged: async () => mgr.secretsChanged([{ kind: "user", userId: USER }]),
    placeholderOf,
    agentUserId: (agentId) =>
      mgr.getAgent(agentId)
        ? (mgr.getAgent(agentId)!.userId ?? null)
        : undefined,
    isOfficeOwnerUserId: () => false,
    emitRequest: (agentId, payload) =>
      mgr.emitAgentSecretRequest(agentId, payload),
    emitSettled: (agentId, requestId, outcome, name) =>
      mgr.emitAgentSecretRequestSettled(agentId, requestId, outcome, name),
    tellAgent: (agentId, _userId, text) => {
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "alice" },
        text,
      });
    },
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
  mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "alice" },
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
  return { mgr, fake, requests, placeholderOf, id };
}

type World = Awaited<ReturnType<typeof world>>;

function ask({ requests, id }: World) {
  const asked = requests.open(id, {
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    reason: "To open the pull request.",
  });
  if (!asked.ok) throw new Error(asked.code);
  return asked.requestId;
}

// What the acceptance asks of the turn that the confirmation starts: a new
// process whose environment has the placeholder and the proxy, a message
// with the placeholder, a settled card, and the value nowhere.
async function expectConfirmedOnNewProcess(
  w: World,
  requestId: string,
  firstSession: ReturnType<FakeBackend["sessionForAgent"]>,
) {
  const placeholder = w.placeholderOf(
    { kind: "user", userId: USER },
    "GH_TOKEN",
  )!;
  expect(placeholder).not.toBe(VALUE);
  await waitUntil(
    () =>
      w.fake.sessionForAgent(w.id) !== firstSession &&
      w.fake
        .sessionForAgent(w.id)!
        .sent.some((m) => m.text.includes(placeholder)),
    "told on a new process",
  );
  const next = w.fake.sessionForAgent(w.id)!;
  expect(next.opts.env?.GH_TOKEN).toBe(placeholder);
  expect(next.opts.env?.HTTPS_PROXY).toBe(PROXY);
  // The confirmation ran on the new process only.
  expect(firstSession!.sent.some((m) => m.text.includes(placeholder))).toBe(
    false,
  );
  expect(
    w.mgr
      .getAgentLogs(w.id)
      .some((e) => e.metadata?.secretRequestSettled === requestId),
  ).toBe(true);
  const seen = JSON.stringify({
    logs: w.mgr.getAgentLogs(w.id),
    sent: [...firstSession!.sent, ...next.sent],
    env: next.opts.env,
  });
  expect(seen).not.toContain(VALUE);
  expect(seen).toContain(placeholder);
}

it("idle: the agent asks, the member saves in the masked form, and the confirmation runs on a new process with the placeholder and the proxy", async () => {
  const w = await world();
  const firstSession = w.fake.sessionForAgent(w.id)!;
  expect(firstSession.opts.env?.GH_TOKEN).toBeUndefined();
  expect(firstSession.opts.env?.HTTPS_PROXY).toBeUndefined();
  const requestId = ask(w);
  const card = w.mgr
    .getAgentLogs(w.id)
    .find((e) => e.kind === "secret-request");
  expect(card?.secretRequest?.requestId).toBe(requestId);
  const saved = await w.requests.save(USER, w.id, requestId, {
    value: VALUE,
    hosts: ["api.github.com"],
  });
  expect(saved.ok).toBe(true);
  await expectConfirmedOnNewProcess(w, requestId, firstSession);
});

it("busy: the member saves while the agent's turn still runs, and the confirmation waits for a new process", async () => {
  const w = await world();
  w.mgr.enqueueMessage(w.id, {
    sender: { kind: "user", username: "alice" },
    text: "hold",
  });
  await waitUntil(
    () =>
      w.fake.sessionForAgent(w.id)!.sent.some((m) => m.text.includes("hold")),
    "busy",
  );
  const busySession = w.fake.sessionForAgent(w.id)!;
  // The agent asks during its turn, and the member saves before it ends.
  const requestId = ask(w);
  const saved = await w.requests.save(USER, w.id, requestId, {
    value: VALUE,
  });
  expect(saved.ok).toBe(true);
  busySession.completeTurn({ text: "waiting for the secret" });
  await expectConfirmedOnNewProcess(w, requestId, busySession);
});
