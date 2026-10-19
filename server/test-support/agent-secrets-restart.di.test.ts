// DI tests for the restart rule of the secrets design (section 2.6, appendix
// D): a change of the set of secrets in a scope releases the processes of
// that scope's agents, so their next turn starts a new process with the
// current environment and resumes the same conversation. FakeBackend only.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { english } from "../i18n.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setSecretEnvironmentProvider } from "../env-loader.ts";
import {
  clearTestManagedOfficeEnv,
  setTestManagedOfficeEnv,
} from "./managed-office-env.ts";

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

const claudeHome = () => join(STATE_ROOT, "claude-home-secrets-restart");

// Every send completes its turn, except "hold", which stays busy until the
// test completes it.
function makeFake(): FakeBackend {
  return new FakeBackend({
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

function makeManager(fake: FakeBackend) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: ROOMS }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

type Manager = ReturnType<typeof makeManager>;

function live(mgr: Manager, id: string): boolean {
  const agent = mgr.getAgent(id);
  return (
    mgr.getCurrentSessionId(id) !== null &&
    agent?.dormant !== true &&
    (agent?.state === "idle" || agent?.state === "waiting_for_response")
  );
}

function dormant(mgr: Manager, id: string): boolean {
  return mgr.getAgent(id)?.dormant === true;
}

function send(mgr: Manager, id: string, text: string) {
  const result = mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "tester" },
    text,
  });
  if (!result.ok) throw new Error("enqueue failed");
}

// The on-disk transcript the Claude resume check looks for.
function seedSession(mgr: Manager, id: string) {
  const sessionId = mgr.getCurrentSessionId(id)!;
  const dir = claudeProjectDir(STATE_ROOT, { CLAUDE_CONFIG_DIR: claudeHome() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "");
}

async function spawnLive(mgr: Manager, name: string, userId: string | null) {
  const info = await mgr.spawn(
    name,
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
    userId,
  );
  if (!info) throw new Error("spawn failed");
  send(mgr, info.id, "wake");
  await waitUntil(() => live(mgr, info.id), `${name} live`);
  seedSession(mgr, info.id);
  return info.id;
}

async function wake(mgr: Manager, id: string) {
  send(mgr, id, "again");
  await waitUntil(() => live(mgr, id), "woke");
  seedSession(mgr, id);
}

afterEach(() => clearTestManagedOfficeEnv());

describe("which agents a secrets change reaches", () => {
  it("a member change releases only that member's agents; an office change and a port change release every member's", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const alice = await spawnLive(mgr, "Alice", "u-alice");
    const bob = await spawnLive(mgr, "Bob", "u-bob");
    const unowned = await spawnLive(mgr, "Nobody", null);

    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    await waitUntil(() => dormant(mgr, alice), "alice released");
    expect(dormant(mgr, bob)).toBe(false);
    expect(dormant(mgr, unowned)).toBe(false);

    await wake(mgr, alice);
    mgr.envChanged([{ kind: "office" }]);
    await waitUntil(
      () => [alice, bob, unowned].every((id) => dormant(mgr, id)),
      "office change released all",
    );

    for (const id of [alice, bob, unowned]) await wake(mgr, id);
    mgr.envChanged("all");
    await waitUntil(
      () => [alice, bob, unowned].every((id) => dormant(mgr, id)),
      "port change released all",
    );
  });
});

describe("when the release happens", () => {
  it("an idle agent is released at once and resumes the same conversation, and the agent is told", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Idle", "u-alice");
    const sessionId = mgr.getCurrentSessionId(id);
    const resumes = fake.resumeSessionCount;
    const firstSession = fake.sessionForAgent(id)!;

    // The office gets its first secret: from now on, environments carry its
    // placeholder and the proxy.
    const restore = setSecretEnvironmentProvider(() => ({
      office: { OFFICE_KEY: "office-placeholder-0001" },
      member: {},
      fixed: { HTTPS_PROXY: "http://127.0.0.1:9" },
      gitCredentials: [],
      revision: "first-secret",
    }));
    try {
      mgr.envChanged([{ kind: "office" }]);
      expect(dormant(mgr, id)).toBe(true);
      send(mgr, id, "after");
      await waitUntil(() => live(mgr, id), "woke");
    } finally {
      setSecretEnvironmentProvider(restore);
    }
    const newSession = fake.sessionForAgent(id)!;
    expect(newSession).not.toBe(firstSession);
    expect(newSession.opts.env?.OFFICE_KEY).toBe("office-placeholder-0001");
    expect(newSession.opts.env?.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(firstSession.opts.env?.OFFICE_KEY).toBeUndefined();

    expect(fake.resumeSessionCount).toBe(resumes + 1);
    expect(mgr.getCurrentSessionId(id)).toBe(sessionId);
    const wakeText = english.t("systemEntries.wake.env");
    expect(
      mgr.getAgentLogs(id).some((e) => String(e.content ?? "") === wakeText),
    ).toBe(true);
    // The note reached the agent with the message.
    expect(fake.sessionForAgent(id)!.sent.at(-1)!.text).toContain(wakeText);
  });

  it("a busy agent is released when its turn ends, with nothing queued", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "BusyAlone", "u-alice");
    send(mgr, id, "hold");
    await waitUntil(
      () => fake.sessionForAgent(id)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );
    mgr.envChanged([{ kind: "user", userId: "u-alice" }]);
    expect(dormant(mgr, id)).toBe(false);
    fake.sessionForAgent(id)!.completeTurn({ text: "done" });
    await waitUntil(() => dormant(mgr, id), "released at turn end");
  });

  it("a busy agent is released when its turn ends, and a message queued meanwhile runs on a new process", async () => {
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome() });
    const fake = makeFake();
    const mgr = makeManager(fake);
    const id = await spawnLive(mgr, "Busy", "u-alice");
    send(mgr, id, "hold");
    await waitUntil(
      () => fake.sessionForAgent(id)!.sent.some((m) => m.text.includes("hold")),
      "busy",
    );
    const busySession = fake.sessionForAgent(id)!;

    mgr.envChanged([{ kind: "office" }]);
    // Busy: not released yet.
    expect(dormant(mgr, id)).toBe(false);
    send(mgr, id, "queued-next");

    busySession.completeTurn({ text: "done" });
    await waitUntil(
      () =>
        fake.sessionForAgent(id) !== busySession &&
        fake
          .sessionForAgent(id)!
          .sent.some((m) => m.text.includes("queued-next")),
      "queued message on a new process",
    );
    // No turn started on the old process after the change.
    expect(busySession.sent.some((m) => m.text.includes("queued-next"))).toBe(
      false,
    );
  });
});
