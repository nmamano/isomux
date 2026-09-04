// This is the only test that drives a first reply end to end through a real
// pinned OpenCode server. It uses a local provider mock and spends no model
// credits, but starting the server makes the test too costly for the default
// suite. A regression in this path is therefore caught only by the gated run:
//
//   bun run test:opencode

import { expect, it } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import { createOpenCodeBackend } from "../backends/opencode/adapter.ts";
import { openCodeProfilePaths } from "../backends/opencode/profile-paths.ts";
import { OpenCodeSupervisor } from "../backends/opencode/supervisor.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

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
      idleShutdownMs: 100,
      config: {
        autoupdate: false,
        model: "gate/gate-model",
        small_model: "gate/gate-model",
        provider: {
          gate: {
            name: "Gate mock",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "gate-model": {
                name: "Gate model",
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
              },
            },
            options: {
              apiKey: "test-only",
              baseURL: `http://127.0.0.1:${mock.port}/v1`,
            },
          },
        },
      },
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
      const mgr = createAgentManager({
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
      const warmLease = await supervisor.acquire();
      const warmPid = warmLease.pid;
      expect(alive(warmPid)).toBe(true);
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "hello through OC1",
      });
      const deadline = Date.now() + 15_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === "OpenCode real tracer reply.") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
      await supervisor.shutdown();
      await mock.stop(true);
    }
  },
  25_000,
);

it.skipIf(!LIVE)(
  "drops a real provider-error canary before normalized events and agent JSONL",
  async () => {
    const canary = "OPENCODE_PROVIDER_ERROR_SECRET_CANARY";
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
          return Response.json(
            { error: { message: canary, type: "provider_error" } },
            { status: 400, headers: { "x-provider-secret": canary } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = new OpenCodeSupervisor({
      profileDir: `${STATE_ROOT}/opencode-error-profile`,
      serverCwd: STATE_ROOT,
      idleShutdownMs: 100,
      config: {
        autoupdate: false,
        model: "gate/gate-model",
        small_model: "gate/gate-model",
        provider: {
          gate: {
            name: "Gate mock",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "gate-model": {
                name: "Gate model",
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
              },
            },
            options: {
              apiKey: "invalid-test-key",
              baseURL: `http://127.0.0.1:${mock.port}/v1`,
            },
          },
        },
      },
    });
    try {
      const mgr = createAgentManager({
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
      const warmLease = await supervisor.acquire();
      const warmPid = warmLease.pid;
      expect(alive(warmPid)).toBe(true);
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "trigger provider error",
      });
      const deadline = Date.now() + 15_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) =>
            entry.content.includes("provider or transport error"),
          ) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      const normalized = JSON.stringify(mgr.getAgentLogs(info!.id));
      expect(warmLease.pid).toBe(warmPid);
      expect(alive(warmPid)).toBe(true);
      warmLease.release();
      expect(normalized).not.toContain(canary);
      expect(normalized).toContain("provider or transport error");
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.kind === "terminal-command"),
      ).toBe(false);
      for await (const path of new Bun.Glob("**/*.jsonl").scan(STATE_ROOT)) {
        expect(await Bun.file(`${STATE_ROOT}/${path}`).text()).not.toContain(
          canary,
        );
      }
      for (const name of ["server.stdout.log", "server.stderr.log"]) {
        const file = Bun.file(`${supervisor.profileDir}/${name}`);
        expect((await file.exists()) ? await file.text() : "").not.toContain(
          canary,
        );
      }
      await mgr.kill(info!.id);
    } finally {
      await supervisor.shutdown();
      await mock.stop(true);
    }
  },
  25_000,
);
