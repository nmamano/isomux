// Run with Bun, a fresh ISOMUX_HOME, and a MemoryMax=2G user scope.
// Default: local provider only. DIAG_LIVE=1: up to three short paid turns.
import { readFile, mkdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { OpenCodeSupervisor } from "../../../server/backends/opencode/supervisor.ts";
import { OpenCodeTransport, discoverOpenCodeModels } from "../../../server/backends/opencode/transport.ts";

const root = process.env.ISOMUX_HOME;
if (!root || !root.includes("opencode-diag-")) throw new Error("Use a fresh diagnostic ISOMUX_HOME");
const live = process.env.DIAG_LIVE === "1";
const log = (event, fields = {}) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
let mode = "ok";
let requestSeen;
const mock = live ? null : Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
  await req.json();
  requestSeen?.();
  if (mode === "hold") await Bun.sleep(3000);
  if (mode === "timeout") await Bun.sleep(10000);
  if (mode === "error") return Response.json({ error: { message: "DIAG_LOCAL_PROVIDER_ERROR", type: "invalid_request_error" } }, { status: 400 });
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "diag", object: "chat.completion.chunk", created: 1, model: "diag", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "DIAG_OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
const config = live ? { autoupdate: false, share: "disabled" } : {
  autoupdate: false, share: "disabled", model: "diag/diag", small_model: "diag/diag",
  provider: { diag: { name: "Local diagnostic", npm: "@ai-sdk/openai-compatible", env: [], models: { diag: { name: "diag", limit: { context: 100000, output: 1000 }, cost: { input: 0, output: 0 } } }, options: { apiKey: "local-dummy", baseURL: `http://127.0.0.1:${mock.port}/v1` } } },
};
const supervisor = new OpenCodeSupervisor({ profileDir: `${root}/profile`, serverCwd: root, config,
  launchEnv: live ? {} : { OPENCODE_API_KEY: undefined, OPENCODE_DISABLE_MODELS_FETCH: "1" },
});
const transports = [];
let model = "diag/diag";
const make = (sessionId) => {
  const transport = new OpenCodeTransport({ cwd: root, model, supervisor, sessionId,
    systemPrompt: "Reply with DIAG_OK. Do not use tools.",
    // Do not persist provider message strings, which can contain credentials.
    safeErrorSink: (e) => log("safe-error", { name: e.name, code: e.code, statusCode: e.statusCode, isRetryable: e.isRetryable, hasMessage: Boolean(e.message) }),
  });
  transports.push(transport);
  return transport;
};
const record = async () => { const r = JSON.parse(await readFile(supervisor.recordPath, "utf8")); return { pid: r.pid, port: r.port }; };
async function turn(transport, label) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  let sessionId;
  const timer = setTimeout(() => resolve({ status: "harness-timeout" }), 45000);
  await transport.send([{ type: "text", text: "Reply with DIAG_OK." }], (e) => {
    if (e.kind === "system_init") sessionId = e.sessionId;
    if (e.kind === "turn_completed") resolve({ status: e.status, error: e.error });
  });
  const terminal = await done;
  clearTimeout(timer);
  log("turn", { label, ...terminal, ...await record() });
  return { ...terminal, sessionId };
}
async function kill(label) {
  const r = await record();
  log("kill", { label, command: `kill -KILL ${r.pid}`, ...r, source: "server.lock pid" });
  process.kill(r.pid, "SIGKILL");
  await Bun.sleep(200);
}
await mkdir(root, { recursive: true });
log("start", { root, live, load: loadavg(), mockPort: mock?.port });
try {
  const started = performance.now();
  const lease = await supervisor.acquire();
  log("startup", { ms: Math.round(performance.now() - started), load: loadavg(), ...await record() });
  lease.release();
  if (process.env.DIAG_STARTUP_ONLY === "1") {
    const beforeEvents = performance.now();
    const response = await fetch(`${lease.baseUrl}/event?directory=${encodeURIComponent(root)}`, {
      headers: { authorization: lease.authHeader }, signal: AbortSignal.timeout(20000),
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    log("event-ready", { ms: Math.round(performance.now() - beforeEvents), status: response.status, bytes: first.value?.length, load: loadavg(), ...await record() });
    await reader.cancel();
  } else if (live) {
    const models = await discoverOpenCodeModels(supervisor, root);
    const preferred = ["opencode/gpt-5-nano", "opencode/gemini-2.5-flash", "opencode/claude-haiku-4-5"];
    model = preferred.find((id) => models.some((m) => m.id === id && !m.isFree));
    if (!model) throw new Error("No preferred paid model is available");
    log("selected-model", { model });
    const t = make();
    let failed = false;
    for (let i = 1; i <= 3; i++) {
      const result = await turn(t, `paid-${i}`);
      if (result.status !== "completed") { failed = true; break; }
    }
    if (!failed) {
      // Controlled real-vendor auth error, not a claim about the customer's error.
      supervisor.updateLaunchEnvironment({ OPENCODE_API_KEY: "diagnostic-invalid-key" }, "invalid-key-control");
      await turn(t, "controlled-real-provider-auth-error");
      const health = await fetch(`${lease.baseUrl}/global/health`, { headers: { authorization: lease.authHeader } });
      log("health-after-provider-error", { status: health.status, ...await record() });
    }
  } else if (process.env.DIAG_TIMEOUT === "1") {
    const { createOpenCodeBackend } = await import("../../../server/backends/opencode/adapter.ts");
    const main = make();
    await turn(main, "before-topic-timeout");
    const before = await record();
    const backend = createOpenCodeBackend({ supervisor, oneShotTimeoutMs: 3000 });
    let providerRequested = false;
    requestSeen = () => { providerRequested = true; };
    mode = "timeout";
    let timedOut = false;
    const began = performance.now();
    try {
      await backend.oneShotPrompt("Return one label.", { cwd: root, modelFamily: model, systemPrompt: "Return one label. Do not use tools." });
    } catch (error) {
      timedOut = error instanceof Error && /timed out/i.test(error.message);
      if (timedOut) log("topic-timeout", { error: error.message, ms: Math.round(performance.now() - began), providerRequested, timeoutMs: 3000, providerDelayMs: 10000, ...await record() });
    }
    requestSeen = undefined;
    mode = "ok";
    if (!timedOut || !providerRequested) throw new Error("Delayed-provider control did not reach the expected path");
    const health = await fetch(`${lease.baseUrl}/global/health`, { headers: { authorization: lease.authHeader } });
    log("health-after-timeout", { status: health.status, samePid: (await record()).pid === before.pid, ...await record() });
    if (health.status !== 200 || (await record()).pid !== before.pid) throw new Error("Timeout changed server health or identity");
    const next = await turn(main, "main-turn-after-topic-timeout");
    if (next.status !== "completed" || (await record()).pid !== before.pid) throw new Error("Main session did not survive topic timeout");
  } else if (process.env.DIAG_MANAGER === "1") {
    const { createOpenCodeBackend } = await import("../../../server/backends/opencode/adapter.ts");
    const { createAgentManager } = await import("../../../server/agent-manager.ts");
    const { OfficeState } = await import("../../../shared/office-state.ts");
    const backend = createOpenCodeBackend({ supervisor });
    // Topic generation is unrelated to the turn under test.
    backend.oneShotPrompt = async () => "Diagnostic";
    const mgr = createAgentManager({ resolveBackend: () => backend, initialRooms: [],
      officeState: new OfficeState({ rooms: [{ id: "diag", name: "diag", prompt: null, canCloseWhenEmpty: false }] }),
      eventSink: (e) => { if (e.type === "log_entry" && e.entry.kind === "error") log("member-error", { text: e.entry.content }); },
    });
    mgr.configureAgentTurnDeps();
    const info = await mgr.spawn("Diagnostic", root, "default", undefined, undefined, "diag", undefined, model, "high", undefined, "opencode");
    try {
      const send = async (label) => {
        await mgr.sendMessage(info.id, "Reply with DIAG_OK.", "tester");
        log("manager-turn", { label, ...await record() });
      };
      await send("baseline");
      mode = "error";
      await send("local-provider-400");
      mode = "ok";
      await kill("manager-between-turns-after-provider-error");
      await send("next-member-turn-1");
      await send("next-member-turn-2");
      // Force a fresh acquisition via the production model-list method.
      await backend.listModels({ cwd: root });
      await send("after-model-list-recovery");
    } finally {
      await mgr.kill(info.id);
      const { openCodeAuthorityBroker } = await import("../../../server/backends/opencode/authority-broker.ts");
      openCodeAuthorityBroker.close();
    }
  } else {
    const t = make();
    await turn(t, "baseline");
    mode = "error";
    await turn(t, "local-provider-400");
    mode = "ok";
    await turn(t, "after-provider-error");
    await kill("between-turns");
    await turn(t, "after-between-kill-1");
    await turn(t, "after-between-kill-2");
    await Bun.sleep(2000);
    log("waited", { ms: 2000, ...await record() });
    const recovery = make();
    await turn(recovery, "new-session-recovery");
    await turn(t, "old-session-after-recovery");
    mode = "hold";
    const seen = new Promise((r) => { requestSeen = r; });
    const mid = turn(t, "mid-kill-active-turn");
    await seen;
    await kill("mid-turn-after-provider-request");
    await mid;
    requestSeen = undefined;
    mode = "ok";
    await turn(t, "after-mid-kill-1");
    await turn(t, "after-mid-kill-2");
    const resumedId = await t.initialize(() => {});
    t.close();
    await turn(make(resumedId), "resume-recovery");
  }
} finally {
  for (const transport of transports) transport.close();
  await supervisor.shutdown();
  await mock?.stop(true);
  log("shutdown");
}
