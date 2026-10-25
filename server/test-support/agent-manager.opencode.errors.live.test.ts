// Credential-free provider controls for the pinned real OpenCode server.
import { afterAll, afterEach, expect, it } from "bun:test";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { createOpenCodeBackend } from "../backends/opencode/adapter.ts";
import { OpenCodeSupervisor } from "../backends/opencode/supervisor.ts";
import { openCodeLogPath } from "../backends/opencode/profile-paths.ts";
import { STATE_ROOT } from "../config.ts";
import { providerRefusal } from "../backends/provider-text.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { renderLogText, type LogText } from "../../shared/i18n/log-message.ts";

import {
  openCodeLiveConfig,
  openCodeLiveLaunchEnv,
  openCodeMockProvider,
} from "./opencode-live-config.ts";
import { createOpenCodeTestReaper } from "./opencode-test-reaper.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const english = (text: LogText) => renderLogText(translatorFor("en"), text);

const reaper = createOpenCodeTestReaper();
afterEach(reaper.afterEach);
afterAll(reaper.afterAll);
// Observed from OpenCode Zen on 2026-10-17, as a 403.
const REFUSAL =
  "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.";

async function until(condition: () => boolean, stalled: () => string) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`OpenCode control did not settle: ${stalled()}`);
    await Bun.sleep(10);
  }
}

// The end of a scenario's OpenCode log, for a failure report. The mock
// provider's key is "test-only", so the log holds nothing secret.
async function logTail(profileDir: string): Promise<string> {
  const file = Bun.file(openCodeLogPath(profileDir));
  if (!(await file.exists())) return "(no OpenCode log)";
  return (await file.text()).split("\n").slice(-40).join("\n");
}

// Below the 60 s test timeout, which equals OpenCode's startup timeout: a
// stall anywhere, a server start included, then fails with what it waited
// for rather than as a bare bun timeout (task 55fb66d8).
const SCENARIO_DEADLINE_MS = 45_000;

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
                ? // 2.1.4 takes a summary only in its template's headings.
                  "## Objective\n- INTERNAL_SUMMARY"
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
      const profileDir = `${STATE_ROOT}/opencode-errors-${scenario}`;
      const supervisor = new OpenCodeSupervisor({
        profileDir,
        serverCwd: STATE_ROOT,
        launchEnv: openCodeLiveLaunchEnv(profileDir),
        config: openCodeLiveConfig(
          "control/control",
          {
            control: openCodeMockProvider(`http://127.0.0.1:${mock.port}/v1`, {
              name: "control",
              model: "control",
              modelConfig: {
                name: "control",
                limit: { context: 100000, output: 1000 },
              },
            }),
          },
          { compaction: { auto: scenario !== "terminal" } },
        ),
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
      let phase = "spawn";
      const state = () =>
        `${phase}; provider requests ${requests}; agent ${id ? mgr.getAgent(id)?.state : "not spawned"}`;
      const wait = (label: string, condition: () => boolean) => {
        phase = label;
        return until(condition, state);
      };
      const scenarioBody = async () => {
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
        phase = "the baseline turn (the server start included)";
        await mgr.sendMessage(id, "BASELINE_PROMPT", "tester");
        await wait(
          "the baseline reply",
          () => has("BASELINE_REPLY") && settled(),
        );
        const session = mgr.listSessions(id)[0]?.sessionId;
        const originalSend = mgr.sendMessage(id, "ORIGINAL_PROMPT", "tester");
        if (scenario === "retry") {
          await wait(
            "the reply after the retry",
            () => has("FOLLOWUP_REPLY") && settled(),
          );
          // The retry line carries the provider's words, before the answer.
          const retryIndex = logs().findIndex(
            (e) => e.kind === "system" && e.content.includes('"rate limit"'),
          );
          expect(retryIndex).toBeGreaterThan(-1);
          expect(retryIndex).toBeLessThan(
            logs().findIndex(
              (e) => e.kind === "text" && e.content === "FOLLOWUP_REPLY",
            ),
          );
          expect(logs().filter((e) => e.kind === "error")).toHaveLength(0);
          expect(rawErrors).toEqual([]);
          expect(requests).toBe(3);
        } else if (scenario === "refused") {
          // Task 1a963907: the member reads the provider's own words.
          await wait(
            "the refusal error",
            () => logs().some((e) => e.kind === "error") && settled(),
          );
          const error = logs().find((e) => e.kind === "error")!.content;
          expect(error).toContain(english(providerRefusal("control", REFUSAL)));
          expect(error).toContain(
            translatorFor("en").t("systemEntries.openCodeFreeTierHint"),
          );
          expect(requests).toBe(2);
        } else if (scenario === "terminal") {
          await wait(
            "the terminal error",
            () => logs().some((e) => e.kind === "error") && settled(),
          );
          // 2.1.4 sends an overflow as provider.invalid-request, with no
          // overflow mark, so the member reads the provider's words.
          expect(logs().find((e) => e.kind === "error")?.content).toContain(
            english(providerRefusal("control", "context_length_exceeded")),
          );
          expect(rawErrors).toEqual(["provider.invalid-request"]);
          expect(requests).toBe(2);
        } else {
          // 2.1.4 compacts on the overflow and does not report it to the
          // turn: the summary request is the only sign.
          await wait("the held summary request", () => summaryHeld);
          expect(rawErrors).toEqual([]);
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
          await wait(
            "the original reply after the summary",
            () =>
              has("ORIGINAL_REPLY") &&
              settled() &&
              (scenario !== "busy-peer" || has("FOLLOWUP_REPLY")),
          );
          expect(
            logs().some((e) => e.content.includes("INTERNAL_SUMMARY")),
          ).toBe(false);
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
        await wait(
          "the recovery reply",
          () =>
            logs().filter(
              (e) => e.kind === "text" && e.content === "FOLLOWUP_REPLY",
            ).length > repliesBefore && settled(),
        );
        expect(mgr.listSessions(id)[0]?.sessionId).toBe(session);
      };
      const stalled = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        void logTail(profileDir).then((tail) =>
          stalled.reject(
            new Error(
              `OpenCode ${scenario} stalled for ${SCENARIO_DEADLINE_MS} ms at ${state()}\n${tail}`,
            ),
          ),
        );
      }, SCENARIO_DEADLINE_MS);
      try {
        const run = scenarioBody();
        // After a stall the abandoned body may still fail; that is reported
        // above, not as an error between tests.
        run.catch(() => {});
        await Promise.race([run, stalled.promise]);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("OpenCode control"))
          err.message += `\n${await logTail(profileDir)}`;
        throw err;
      } finally {
        clearTimeout(timer);
        // Bounded, so a teardown stuck on the stalled turn cannot hide the
        // error above; afterAll still shuts the server down.
        await Promise.race([teardown(), Bun.sleep(10_000)]);
      }
    },
    60_000,
  );
}
