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
