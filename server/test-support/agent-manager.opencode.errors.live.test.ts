// Credential-free provider controls for the pinned real OpenCode server.
import { afterAll, afterEach, expect, it } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createOpenCodeBackend } from "../backends/opencode/adapter.ts";
import { OpenCodeSupervisor } from "../backends/opencode/supervisor.ts";
import { STATE_ROOT } from "../config.ts";

import { createOpenCodeTestReaper } from "./opencode-test-reaper.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const reaper = createOpenCodeTestReaper();
afterEach(reaper.afterEach);
afterAll(reaper.afterAll);
// Observed from OpenCode Zen on 2026-10-17, as a 403.
const REFUSAL =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("OpenCode control did not settle");
    await Bun.sleep(10);
  }
}

for (const scenario of [
  "overflow",
  "busy-peer",
  "terminal",
  "retry",
  "refused",
] as const) {
  it.skipIf(!LIVE)(
    `keeps real OpenCode ${scenario} answers on their own turn`,
    async () => {
      let requests = 0;
      const bodies: { messages: { role: string; content: unknown }[] }[] = [];
      const releaseSummary = Promise.withResolvers<void>();
      let summaryHeld = false;
      const rawErrors: string[] = [];
      // No compaction summary is held: the second request ends the turn.
      const single =
        scenario === "terminal" ||
        scenario === "retry" ||
        scenario === "refused";
      const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push(await request.json());
          const n = ++requests;
          console.info("OpenCode error control", scenario, "request", n);
          if (n === 2 && scenario === "retry")
            return Response.json(
              { error: { message: "rate limit", type: "rate_limit_error" } },
              { status: 429, headers: { "retry-after-ms": "10" } },
            );
          if (n === 2 && scenario === "refused")
            return Response.json(
              { error: { message: REFUSAL, type: "permission_error" } },
              { status: 403 },
            );
          if (n === 2)
            return Response.json(
              {
                error: {
                  message: "context_length_exceeded",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            );
          if (n === 3 && !single) {
            summaryHeld = true;
            await releaseSummary.promise;
          }
          const answer =
            n === 1
              ? "BASELINE_REPLY"
              : n === 3 && !single
                ? "INTERNAL_SUMMARY"
                : n === 4 && !single
                  ? "ORIGINAL_REPLY"
                  : "FOLLOWUP_REPLY";
          const chunk = (delta: object, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: "control", object: "chat.completion.chunk", created: 1, model: "control", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            chunk({ role: "assistant", content: answer }, null) +
              chunk({}, "stop") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const supervisor = new OpenCodeSupervisor({
        profileDir: `${STATE_ROOT}/opencode-errors-${scenario}`,
        serverCwd: STATE_ROOT,
        config: {
          autoupdate: false,
          share: "disabled",
          compaction: { auto: scenario !== "terminal" },
          model: "control/control",
          small_model: "control/control",
          provider: {
            control: {
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                control: {
                  name: "control",
                  limit: { context: 100000, output: 1000 },
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
      const backend = createOpenCodeBackend({
        supervisor,
        safeErrorSink: (error) => rawErrors.push(error.name ?? "unknown"),
      });
      backend.oneShotPrompt = async () => "Control";
      const mgr = createAgentManager({
        resolveBackend: () => backend,
        initialRooms: [],
        officeState: new OfficeState({
          rooms: [{ id: "error-control", name: "Control", prompt: null }],
        }),
        eventSink: () => {},
      });
      mgr.configureAgentTurnDeps();
      let id: string | undefined;
      reaper.track(supervisor);
      const teardown = reaper.add(async () => {
        releaseSummary.resolve();
        if (id) await mgr.abort(id);
        await supervisor.shutdown();
        await mock.stop(true);
      });
      try {
        const agent = await mgr.spawn(
          "Error control",
          STATE_ROOT,
          "default",
          undefined,
          undefined,
          "error-control",
          undefined,
          "control/control",
          "high",
          undefined,
          "opencode",
        );
        id = agent!.id;
        const logs = () => mgr.getAgentLogs(id!);
        const has = (content: string) =>
          logs().some((e) => e.kind === "text" && e.content === content);
        const settled = () =>
          ["waiting_for_response", "error"].includes(mgr.getAgent(id!)!.state);
        await mgr.sendMessage(id, "BASELINE_PROMPT", "tester");
        await until(() => has("BASELINE_REPLY") && settled());
        const session = mgr.listSessions(id)[0]?.sessionId;
        const originalSend = mgr.sendMessage(id, "ORIGINAL_PROMPT", "tester");
        if (scenario === "retry") {
          await until(() => has("FOLLOWUP_REPLY") && settled());
          expect(
            logs().some(
              (e) =>
                e.kind === "system" &&
                /rate limit.*retrying 1 of 5/i.test(e.content),
            ),
          ).toBe(true);
          expect(logs().filter((e) => e.kind === "error")).toHaveLength(0);
          expect(rawErrors).toEqual([]);
          expect(requests).toBe(3);
        } else if (scenario === "refused") {
          // Task 1a963907: the member reads the provider's own words.
          await until(
            () => logs().some((e) => e.kind === "error") && settled(),
          );
          const error = logs().find((e) => e.kind === "error")!.content;
          expect(error).toContain("`control`");
          expect(error).toContain(`"${REFUSAL}"`);
          expect(requests).toBe(2);
        } else if (scenario === "terminal") {
          await until(
            () => logs().some((e) => e.kind === "error") && settled(),
          );
          expect(logs().find((e) => e.kind === "error")?.content).toMatch(
            /conversation.*long/i,
          );
          expect(requests).toBe(2);
        } else {
          await until(
            () => summaryHeld && rawErrors.includes("ContextOverflowError"),
          );
          expect(rawErrors).toContain("ContextOverflowError");
          expect(settled()).toBe(false);
          expect(logs().filter((e) => e.kind === "error")).toHaveLength(0);
          if (scenario === "busy-peer") {
            const result = mgr.enqueueMessage(id, {
              sender: {
                kind: "agent",
                agentId: "control-peer",
                agentName: "Peer",
                roomName: "Control",
              },
              text: "PEER_PROMPT",
            });
            expect(result).toMatchObject({ ok: true, queued: true });
            expect(requests).toBe(3);
          }
          releaseSummary.resolve();
          await until(
            () =>
              has("ORIGINAL_REPLY") &&
              settled() &&
              (scenario !== "busy-peer" || has("FOLLOWUP_REPLY")),
          );
          expect(has("INTERNAL_SUMMARY")).toBe(false);
          expect(logs().filter((e) => e.kind === "error")).toHaveLength(0);
          if (scenario === "busy-peer") {
            const originalIndex = logs().findIndex(
              (e) => e.kind === "text" && e.content === "ORIGINAL_REPLY",
            );
            const peerIndex = logs().findIndex(
              (e) =>
                e.kind === "user_message" && e.content.includes("PEER_PROMPT"),
            );
            const peerAnswerIndex = logs().findIndex(
              (e) => e.kind === "text" && e.content === "FOLLOWUP_REPLY",
            );
            expect(peerIndex).toBeGreaterThan(originalIndex);
            expect(peerAnswerIndex).toBeGreaterThan(peerIndex);
            expect(JSON.stringify(bodies[3])).not.toContain("PEER_PROMPT");
            expect(JSON.stringify(bodies[4])).toContain("PEER_PROMPT");
            expect(requests).toBe(5);
          }
        }
        await originalSend;
        const repliesBefore = logs().filter(
          (e) => e.kind === "text" && e.content === "FOLLOWUP_REPLY",
        ).length;
        await mgr.sendMessage(id, "RECOVERY_PROMPT", "tester");
        await until(
          () =>
            logs().filter(
              (e) => e.kind === "text" && e.content === "FOLLOWUP_REPLY",
            ).length > repliesBefore && settled(),
        );
        expect(mgr.listSessions(id)[0]?.sessionId).toBe(session);
      } finally {
        await teardown();
      }
    },
    60_000,
  );
}
