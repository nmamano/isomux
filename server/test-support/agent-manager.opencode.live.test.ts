// This test drives a first reply end to end through a real
// pinned OpenCode server. It uses a local provider mock and spends no model
// credits, but starting the server makes the test too costly for the default
// suite. A regression in this path is therefore caught only by the gated run:
//
//   bun run test:opencode

import { afterAll, afterEach, expect, it } from "bun:test";
import { loadavg } from "node:os";
import type { EventHandler } from "../internal-types.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import { createOpenCodeBackend } from "../backends/opencode/adapter.ts";
import { openCodeProfilePaths } from "../backends/opencode/profile-paths.ts";
import { OpenCodeSupervisor } from "../backends/opencode/supervisor.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";

import {
  openCodeLiveConfig,
  openCodeLiveLaunchEnv,
  openCodeMockProvider,
} from "./opencode-live-config.ts";
import { createOpenCodeTestReaper } from "./opencode-test-reaper.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const reaper = createOpenCodeTestReaper();
afterEach(reaper.afterEach);
afterAll(reaper.afterAll);

function expectedLog(label: string, matches: (content: string) => boolean) {
  const seen = Promise.withResolvers<void>();
  let agentId: string | undefined;
  let observed = false;
  const sink: EventHandler = (event) => {
    if (
      event.type === "log_entry" &&
      event.entry.agentId === agentId &&
      matches(event.entry.content)
    ) {
      observed = true;
    }
    if (
      event.type === "agent_updated" &&
      event.agentId === agentId &&
      (event.changes.state === "waiting_for_response" ||
        event.changes.state === "error")
    ) {
      if (observed) seen.resolve();
      else
        seen.reject(
          new Error(`Agent settled without the required ${label} log event`),
        );
    }
  };
  return {
    sink,
    arm(id: string) {
      agentId = id;
    },
    async wait() {
      console.info(`Waiting for ${label} log event`);
      await seen.promise;
      expect(observed, `Missing ${label} log event`).toBe(true);
    },
  };
}

async function measure<T>(phase: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await action();
  } finally {
    console.info(
      "OpenCode manager live timing",
      JSON.stringify({
        phase,
        ms: Math.round(performance.now() - started),
        load: loadavg(),
      }),
    );
  }
}

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(!LIVE)(
  "runs the first reply end to end through the real pinned OpenCode server",
  async () => {
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(
                `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
              );
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "OpenCode real tracer reply.",
                  },
                  finish_reason: null,
                },
              ],
            });
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            send("[DONE]");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const supervisor = new OpenCodeSupervisor({
      profileDir: `${STATE_ROOT}/opencode-success-profile`,
      serverCwd: STATE_ROOT,
      launchEnv: openCodeLiveLaunchEnv(
        `${STATE_ROOT}/opencode-success-profile`,
      ),
      idleShutdownMs: 100,
      config: openCodeLiveConfig("gate/gate-model", {
        gate: openCodeMockProvider(`http://127.0.0.1:${mock.port}/v1`),
      }),
    });
    reaper.track(supervisor);
    const teardown = reaper.add(async () => {
      await measure("first reply teardown", () => supervisor.shutdown());
      await mock.stop(true);
    });
    try {
      const backend = createOpenCodeBackend({ supervisor });
      let reportStoredSessionAsDurable = false;
      const backendWithControlledStorage: Backend = {
        ...backend,
        inspectStoredSession: (sessionId, opts) =>
          reportStoredSessionAsDurable
            ? "durable"
            : backend.inspectStoredSession(sessionId, opts),
      };
      const reply = expectedLog(
        "first reply",
        (content) => content === "OpenCode real tracer reply.",
      );
      const mgr = createAgentManager({
        eventSink: reply.sink,
        resolveBackend: () => backendWithControlledStorage,
        officeState: new OfficeState({ rooms: rooms("room-opencode-real") }),
        initialRooms: [],
      });
      mgr.configureAgentTurnDeps();
      const info = await mgr.spawn(
        "OpenCode real tracer",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-opencode-real",
        undefined,
        "gate/gate-model",
        "high",
        undefined,
        "opencode",
      );
      const warmLease = await measure("first reply server start", () =>
        supervisor.acquire(),
      );
      const warmPid = warmLease.pid;
      expect(alive(warmPid)).toBe(true);
      reply.arm(info!.id);
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "hello through OpenCode",
      });
      await measure("first reply delivery", () => reply.wait());
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === "OpenCode real tracer reply."),
      ).toBe(true);
      expect(warmLease.pid).toBe(warmPid);
      expect(alive(warmPid)).toBe(true);
      warmLease.release();
      expect(mgr.listSessions(info!.id)[0]?.agentType).toBe("opencode");
      expect(mgr.getAgent(info!.id)?.state).toBe("waiting_for_response");
      expect(supervisor.profileDir).not.toBe(
        openCodeProfilePaths(environmentSourceKeyForUserId(null)).profileDir,
      );
      // This test creates the session in an injected supervisor profile, while
      // demotion checks durability in dataHome derived from the environment-key
      // profile. That test-only mismatch makes the session non-demotable.
      expect(await mgr.demoteToLazy(info!.id)).toBe(false);
      // Change only that storage fact. The same quiescent agent must now
      // demote, which proves the mismatch caused the false result above.
      reportStoredSessionAsDurable = true;
      expect(await mgr.demoteToLazy(info!.id)).toBe(true);
    } finally {
      await teardown();
    }
  },
  25_000,
);

it.skipIf(!LIVE)(
  "shows a real provider refusal without the provider key or headers in logs, agent JSONL or server logs",
  async () => {
    // Task 1a963907: the member reads the provider's own words, redacted.
    // The mock echoes the key it received, as some providers do.
    const canary = "OPENCODE_PROVIDER_ERROR_SECRET_CANARY";
    // No digits: OpenCode 1.18.35 retried any error, even a 400, whose text
    // holds 429, 500, 502, 503, 504 or 524, and the mock echoes the key. A
    // UUID with "500" in it stalled this test past 25 s (task 55fb66d8).
    const apiKey = `opencode-live-key-${crypto
      .randomUUID()
      .replace(/\d/g, (d) => "ghijklmnop"[Number(d)])}`;
    expect(apiKey).toMatch(/^opencode-live-key-[a-z-]+$/);
    const plain = "ProviderPlainMarker7";
    const authorizations: string[] = [];
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname === "/v1/chat/completions") {
          const authorization = request.headers.get("authorization") ?? "";
          authorizations.push(authorization);
          return Response.json(
            {
              error: {
                message: `${plain} rejected ${authorization}`,
                type: "provider_error",
              },
            },
            { status: 400, headers: { "x-provider-secret": canary } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = new OpenCodeSupervisor({
      profileDir: `${STATE_ROOT}/opencode-error-profile`,
      serverCwd: STATE_ROOT,
      launchEnv: openCodeLiveLaunchEnv(`${STATE_ROOT}/opencode-error-profile`),
      idleShutdownMs: 100,
      config: openCodeLiveConfig("gate/gate-model", {
        gate: openCodeMockProvider(`http://127.0.0.1:${mock.port}/v1`, {
          apiKey,
        }),
      }),
    });
    reaper.track(supervisor);
    const teardown = reaper.add(async () => {
      await measure("provider error teardown", () => supervisor.shutdown());
      await mock.stop(true);
    });
    try {
      const reply = expectedLog("provider error", (content) =>
        content.includes(plain),
      );
      const mgr = createAgentManager({
        eventSink: reply.sink,
        resolveBackend: () => createOpenCodeBackend({ supervisor }),
        officeState: new OfficeState({ rooms: rooms("room-opencode-error") }),
        initialRooms: [],
      });
      mgr.configureAgentTurnDeps();
      const info = await mgr.spawn(
        "OpenCode error tracer",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-opencode-error",
        undefined,
        "gate/gate-model",
        "high",
        undefined,
        "opencode",
      );
      const warmLease = await measure("provider error server start", () =>
        supervisor.acquire(),
      );
      const warmPid = warmLease.pid;
      expect(alive(warmPid)).toBe(true);
      reply.arm(info!.id);
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "trigger provider error",
      });
      await measure("provider error delivery", () => reply.wait());
      const normalized = JSON.stringify(mgr.getAgentLogs(info!.id));
      expect(warmLease.pid).toBe(warmPid);
      expect(alive(warmPid)).toBe(true);
      warmLease.release();
      // The echoed key reached the provider's message.
      expect(authorizations).toContain(`Bearer ${apiKey}`);
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some(
            (entry) => entry.kind === "error" && entry.content.includes(plain),
          ),
      ).toBe(true);
      expect(normalized).not.toContain(canary);
      expect(normalized).not.toContain(apiKey);
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.kind === "terminal-command"),
      ).toBe(false);
      let scannedFiles = 0;
      for await (const path of new Bun.Glob("**/*.jsonl").scan(STATE_ROOT)) {
        scannedFiles++;
        const text = await Bun.file(`${STATE_ROOT}/${path}`).text();
        expect(text).not.toContain(canary);
        expect(text).not.toContain(apiKey);
      }
      expect(
        scannedFiles,
        "Provider-error canary sweep must read persisted logs",
      ).toBeGreaterThan(0);
      for (const name of ["server.stdout.log", "server.stderr.log"]) {
        const file = Bun.file(`${supervisor.profileDir}/${name}`);
        const text = (await file.exists()) ? await file.text() : "";
        expect(text).not.toContain(canary);
        expect(text).not.toContain(apiKey);
      }
      await mgr.kill(info!.id);
    } finally {
      await teardown();
    }
  },
  25_000,
);

// ---------------------------------------------------------------------------
// Native steer against the real pinned 2.2.5 server (steer-delivery-design.md
// §3.5, probed 2026-11-11): a steer folded into a running turn at the step
// boundary, a steer that misses the run's last boundary check (cancelled,
// then delivered once by the flush), and an abort with a parked steer. Mock
// provider, no model tokens. The cancel race of the miss case is a real
// millisecond window: the test sweeps steer delays until one attempt lands
// in it, asserting the invariants (delivered exactly once, inbox drained,
// no unowned run) on every attempt.
// ---------------------------------------------------------------------------

const STEER_SENDER = {
  kind: "agent" as const,
  agentId: "agent-live-sender",
  agentName: "Sender",
  roomName: "room-live-steer",
};

interface SteerMockState {
  // Resolved when the mock starts streaming a FAST-ANSWER reply: the run's
  // last boundary checks are milliseconds away.
  onFinal?: () => void;
}

// The tool ran to its end: its stdout, echoed in the tool result. (The
// session's cwd is the state root, where the safety plugin denies writes, so
// completion is proven through stdout, not a file.)
const SLEPT_TO_END = "SLEPT-TO-END";

// The deterministic provider mock: keyed on the LAST user message, so one
// session's accumulated history never changes a later turn's answer. A
// LONG-SHELL prompt gets one shell tool call (sleep 4, then the stdout
// marker); anything holding steer text gets a fixed reply; the rest a plain
// answer. The shell tool asks (Isomux's BASE_RULES), as in production.
function steerMock(state: SteerMockState) {
  // topic: the session's asynchronous topic-label generation, which can
  // outlive the turn that triggered it; the quiescence checks ignore it.
  const requests: {
    messages: Array<Record<string, unknown>>;
    topic: boolean;
  }[] = [];
  let callId = 0;
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models")
        return Response.json({
          object: "list",
          data: [{ id: "gate-model", object: "model" }],
        });
      if (url.pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 });
      const body = (await request.json()) as {
        messages?: Array<Record<string, unknown>>;
      };
      const messages = body.messages ?? [];
      const lastUser = [...messages]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const prompt =
        typeof lastUser === "string"
          ? lastUser
          : JSON.stringify(lastUser ?? "");
      requests.push({ messages, topic: prompt.includes("topic label") });
      const hasToolResult = messages.some((message) => message.role === "tool");
      const id = `gate-${requests.length}`;
      const stream = new ReadableStream({
        start(controller) {
          const send = (value: unknown) =>
            controller.enqueue(
              `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
            );
          const chunk = (delta: unknown, finish: string | null) => ({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: "gate-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          send(chunk({ role: "assistant" }, null));
          if (prompt.includes("LONG-SHELL") && !hasToolResult) {
            send(
              chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${++callId}`,
                      type: "function",
                      function: {
                        name: "shell",
                        arguments: JSON.stringify({
                          command: `sleep 4; echo ${SLEPT_TO_END}`,
                        }),
                      },
                    },
                  ],
                },
                null,
              ),
            );
            send(chunk({}, "tool_calls"));
          } else {
            if (prompt.includes("FAST-ANSWER")) state.onFinal?.();
            const text = prompt.includes("STEER-")
              ? "STEER-ACK-REPLY"
              : `REPLY:${prompt.replaceAll("\n", " ").slice(0, 60)}`;
            send(chunk({ content: text }, null));
            send(chunk({}, "stop"));
          }
          send("[DONE]");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { mock, requests };
}

// Conversation requests only: a turn's asynchronous topic-label generation
// can outlive it and is not run activity.
const conversationCount = (requests: { topic: boolean }[]) =>
  requests.filter((request) => !request.topic).length;

type SteerManager = ReturnType<typeof createAgentManager>;

function bootSteerOffice(room: string, profile: string, mockPort: number) {
  const events: unknown[] = [];
  const supervisor = new OpenCodeSupervisor({
    profileDir: `${STATE_ROOT}/${profile}`,
    serverCwd: STATE_ROOT,
    launchEnv: openCodeLiveLaunchEnv(`${STATE_ROOT}/${profile}`),
    // Long enough that the server stays warm between a test's turns.
    idleShutdownMs: 30_000,
    config: openCodeLiveConfig("gate/gate-model", {
      gate: openCodeMockProvider(`http://127.0.0.1:${mockPort}/v1`),
    }),
  });
  reaper.track(supervisor);
  const backend = createOpenCodeBackend({ supervisor });
  const sink: EventHandler = (event) => {
    events.push(event);
  };
  const mgr = createAgentManager({
    eventSink: sink,
    resolveBackend: () => backend,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms: [],
  });
  mgr.configureAgentTurnDeps();
  return { mgr, supervisor, events };
}

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
  onTimeout?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) {
      if (onTimeout)
        console.info(
          `live steer timeout diagnostics:`,
          JSON.stringify(onTimeout(), null, 1),
        );
      throw new Error(`live steer: timed out waiting for ${label}`);
    }
    await Bun.sleep(20);
  }
}

function settled(
  mgr: SteerManager,
  agentId: string,
  extra: () => boolean = () => true,
): boolean {
  const queue = mgr.getAllAgents().find((a) => a.id === agentId)?.queue ?? [];
  return (
    mgr.getAgent(agentId)?.state === "waiting_for_response" &&
    queue.length === 0 &&
    extra()
  );
}

function steerEntries(mgr: SteerManager, agentId: string, text: string) {
  return mgr
    .getAgentLogs(agentId)
    .filter(
      (entry) =>
        entry.kind === "user_message" &&
        typeof entry.content === "string" &&
        entry.content.includes(text),
    );
}

// Answers the shell permission with "allow once" (choice 1: OpenCode offers
// no persistent label, so allow_once is first).
async function allowNextPermission(
  mgr: SteerManager,
  events: unknown[],
  agentId: string,
  answered: Set<string>,
): Promise<void> {
  await waitUntil(
    () =>
      events.some(
        (event) =>
          (event as { type?: string }).type === "interaction_added" &&
          (event as { interaction?: { kind?: string; agentId?: string } })
            .interaction?.kind === "permission" &&
          (event as { interaction?: { agentId?: string } }).interaction
            ?.agentId === agentId &&
          !answered.has(
            (event as { interaction: { id: string } }).interaction.id,
          ),
      ),
    "permission interaction",
    60_000,
    () => ({
      eventTypes: [
        ...new Set(events.map((e) => (e as { type?: string }).type)),
      ],
      state: mgr.getAgent(agentId)?.state,
      logs: mgr
        .getAgentLogs(agentId)
        .map(
          (entry) => `${entry.kind}: ${String(entry.content).slice(0, 100)}`,
        ),
    }),
  );
  const event = events.find(
    (candidate) =>
      (candidate as { type?: string }).type === "interaction_added" &&
      (candidate as { interaction?: { kind?: string; agentId?: string } })
        .interaction?.kind === "permission" &&
      (candidate as { interaction?: { agentId?: string } }).interaction
        ?.agentId === agentId &&
      !answered.has(
        (candidate as { interaction: { id: string } }).interaction.id,
      ),
  ) as { interaction: { id: string } };
  answered.add(event.interaction.id);
  const result = mgr.respondToChoiceInteraction(
    agentId,
    event.interaction.id,
    "1",
    "tester",
  );
  expect(result.ok).toBe(true);
}

// The session's pending inbox rows, read straight from the real server.
async function liveInbox(
  supervisor: OpenCodeSupervisor,
  sessionId: string,
): Promise<unknown[]> {
  const lease = await supervisor.acquire();
  try {
    const response = await fetch(
      `${lease.baseUrl}/api/session/${encodeURIComponent(sessionId)}/inbox`,
      { headers: { authorization: lease.authHeader } },
    );
    const body = (await response.json()) as { data?: unknown[] };
    return body.data ?? [];
  } finally {
    lease.release();
  }
}

async function spawnReceiver(mgr: SteerManager, room: string): Promise<string> {
  const info = await mgr.spawn(
    "Steer Receiver",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    "gate/gate-model",
    "high",
    undefined,
    "opencode",
  );
  if (!info) throw new Error("live steer: spawn returned null");
  return info.id;
}

it.skipIf(!LIVE)(
  "steer during a long shell call folds into the running turn on the real server",
  async () => {
    const { mock, requests } = steerMock({});
    const { mgr, supervisor, events } = bootSteerOffice(
      "room-live-steer-c1",
      "opencode-steer-c1-profile",
      mock.port ?? 0,
    );
    const teardown = reaper.add(async () => {
      await supervisor.shutdown();
      await mock.stop(true);
    });
    try {
      const agentId = await spawnReceiver(mgr, "room-live-steer-c1");
      const answered = new Set<string>();
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "tester" },
        text: "Please run LONG-SHELL now.",
      });
      await allowNextPermission(mgr, events, agentId, answered);
      // The tool now runs its sleep 4: the run has no boundary until it ends.
      await waitUntil(
        () =>
          ["thinking", "tool_executing"].includes(
            mgr.getAgent(agentId)?.state ?? "",
          ),
        "tool running",
        60_000,
      );
      const steerText = "STEER-C1 FYI from Sender while the shell runs.";
      const ack = mgr.enqueueMessage(
        agentId,
        { sender: STEER_SENDER, text: steerText },
        { steer: true },
      );
      expect(ack).toMatchObject({ ok: true, queued: false, steered: true });
      await waitUntil(() => settled(mgr, agentId), "turn settled", 60_000);

      // Logged exactly once, as a tool-boundary delivery (steer_delivered),
      // before the turn's final reply.
      const entries = steerEntries(mgr, agentId, "STEER-C1");
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.delivery).toBe("tool_boundary");
      const logs = mgr.getAgentLogs(agentId);
      expect(logs.indexOf(entries[0]!)).toBeLessThan(
        logs.findIndex((entry) => entry.content?.includes("STEER-ACK-REPLY")),
      );
      // The tool ran to its end (the sleep was not cut) and the next model
      // request carried its result plus the steer text: OpenCode promoted
      // the row at the boundary, inside the same run. Keyed on the last
      // user message, since the topic-label request also holds the history.
      const lastUserOf = (request: {
        messages: Array<Record<string, unknown>>;
      }) => {
        const last = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        return typeof last === "string" ? last : JSON.stringify(last ?? "");
      };
      const postTool = requests.find(
        (request) =>
          lastUserOf(request).includes("STEER-C1") &&
          request.messages.some((message) => message.role === "tool"),
      );
      expect(postTool).toBeDefined();
      // The marker in the tool role's own content is the sleep's stdout (the
      // command text also names it, in the call's arguments).
      expect(
        postTool!.messages.some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content ?? "").includes(SLEPT_TO_END),
        ),
      ).toBe(true);
      // The inbox is drained and nothing runs on its own after the turn.
      const sessionId = mgr.getCurrentSessionId(agentId);
      expect(sessionId).toBeTruthy();
      expect(await liveInbox(supervisor, sessionId!)).toEqual([]);
      const before = conversationCount(requests);
      await Bun.sleep(2_000);
      expect(conversationCount(requests)).toBe(before);
    } finally {
      await teardown();
    }
  },
  90_000,
);

it.skipIf(!LIVE)(
  "a steer that misses the run is cancelled and the flush delivers it exactly once",
  async () => {
    const mockState: SteerMockState = {};
    const { mock, requests } = steerMock(mockState);
    const { mgr, supervisor } = bootSteerOffice(
      "room-live-steer-c2",
      "opencode-steer-c2-profile",
      mock.port ?? 0,
    );
    const teardown = reaper.add(async () => {
      await supervisor.shutdown();
      await mock.stop(true);
    });
    try {
      const agentId = await spawnReceiver(mgr, "room-live-steer-c2");
      const classifications: string[] = [];
      // Swept delays after the mock started streaming the run's final
      // answer: the miss window (admit after the run's last boundary check,
      // before the turn's end cancels) is milliseconds wide, so attempts
      // land folded, missed, or after the flip to idle. Every outcome must
      // deliver exactly once; the test requires at least one real miss.
      const offsets = [0, 3, 6, 10, 15, 25, 40, 70];
      for (
        let attempt = 0;
        attempt < offsets.length && !classifications.includes("miss");
        attempt++
      ) {
        const steerText = `STEER-C2-${attempt} note from Sender.`;
        let signal!: () => void;
        const finalStarted = new Promise<void>((resolve) => {
          signal = resolve;
        });
        mockState.onFinal = signal;
        mgr.enqueueMessage(agentId, {
          sender: { kind: "user", username: "tester" },
          text: `FAST-ANSWER-${attempt} please reply.`,
        });
        await Promise.race([
          finalStarted,
          Bun.sleep(30_000).then(() => {
            throw new Error("live steer: final answer never streamed");
          }),
        ]);
        await Bun.sleep(offsets[attempt]!);
        const ack = mgr.enqueueMessage(
          agentId,
          { sender: STEER_SENDER, text: steerText },
          { steer: true },
        );
        expect(ack.ok).toBe(true);
        await waitUntil(
          () =>
            settled(
              mgr,
              agentId,
              () => steerEntries(mgr, agentId, steerText).length > 0,
            ),
          `attempt ${attempt} settled`,
          60_000,
        );
        // Delivered exactly once, whichever path took it.
        const entries = steerEntries(mgr, agentId, steerText);
        expect(entries).toHaveLength(1);
        if ((ack as { steered?: boolean }).steered !== true)
          classifications.push("idle-late");
        else if (entries[0].metadata?.delivery === "tool_boundary")
          classifications.push("folded");
        else classifications.push("miss");
        // The inbox is drained and no unowned run starts after the turn.
        expect(
          await liveInbox(supervisor, mgr.getCurrentSessionId(agentId)!),
        ).toEqual([]);
        const before = conversationCount(requests);
        await Bun.sleep(1_200);
        expect(conversationCount(requests)).toBe(before);
      }
      console.info(
        "live steer race classifications",
        JSON.stringify(classifications),
      );
      expect(classifications).toContain("miss");
    } finally {
      await teardown();
    }
  },
  240_000,
);

it.skipIf(!LIVE)(
  "an abort with a parked steer cancels its row and the flush delivers it once",
  async () => {
    const { mock, requests } = steerMock({});
    const { mgr, supervisor, events } = bootSteerOffice(
      "room-live-steer-c3",
      "opencode-steer-c3-profile",
      mock.port ?? 0,
    );
    const teardown = reaper.add(async () => {
      await supervisor.shutdown();
      await mock.stop(true);
    });
    try {
      const agentId = await spawnReceiver(mgr, "room-live-steer-c3");
      const answered = new Set<string>();
      mgr.enqueueMessage(agentId, {
        sender: { kind: "user", username: "tester" },
        text: "Please run LONG-SHELL now.",
      });
      await allowNextPermission(mgr, events, agentId, answered);
      await waitUntil(
        () =>
          ["thinking", "tool_executing"].includes(
            mgr.getAgent(agentId)?.state ?? "",
          ),
        "tool running",
        60_000,
      );
      const steerText = "STEER-C3 correction from Sender.";
      const ack = mgr.enqueueMessage(
        agentId,
        { sender: STEER_SENDER, text: steerText },
        { steer: true },
      );
      expect(ack).toMatchObject({ ok: true, queued: false, steered: true });
      // The admit lands while the sleep still runs (it is durable in the
      // inbox, and the run has no boundary until the tool ends).
      await Bun.sleep(500);
      const result = await mgr.abort(agentId);
      expect(result.ok).toBe(true);
      await waitUntil(
        () =>
          settled(
            mgr,
            agentId,
            () => steerEntries(mgr, agentId, steerText).length > 0,
          ),
        "abort settled with the flush delivered",
        60_000,
      );

      // The member's stop cut the tool: the sleep never reached its echo.
      // Checked on tool-role content only - the command text itself names
      // the marker in the call's arguments, which the history keeps.
      expect(
        requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              JSON.stringify(message.content ?? "").includes(SLEPT_TO_END),
          ),
        ),
      ).toBe(false);
      expect(
        mgr
          .getAgentLogs(agentId)
          .some(
            (entry) =>
              entry.kind === "tool_result" &&
              entry.content?.includes(SLEPT_TO_END),
          ),
      ).toBe(false);
      // The parked steer was released and the flush delivered it exactly
      // once, as an ordinary queued item (not a tool-boundary delivery).
      const entries = steerEntries(mgr, agentId, steerText);
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata?.delivery).toBeUndefined();
      // The row was cancelled: the inbox is empty and the flush's turn is
      // the only request carrying the text, exactly once in its messages
      // (a row the cancel missed would ride along as a promoted duplicate).
      const sessionId = mgr.getCurrentSessionId(agentId);
      expect(sessionId).toBeTruthy();
      expect(await liveInbox(supervisor, sessionId!)).toEqual([]);
      const carrying = requests.filter((request) =>
        JSON.stringify(
          request.messages.filter((message) => message.role === "user"),
        ).includes("STEER-C3"),
      );
      expect(carrying).toHaveLength(1);
      const occurrences = carrying[0]!.messages.filter((message) =>
        JSON.stringify(message.content ?? "").includes("STEER-C3"),
      ).length;
      expect(occurrences).toBe(1);
      const before = conversationCount(requests);
      await Bun.sleep(2_000);
      expect(conversationCount(requests)).toBe(before);
    } finally {
      await teardown();
    }
  },
  90_000,
);
