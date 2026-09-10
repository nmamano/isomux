import { afterEach, expect, it, spyOn } from "bun:test";
import { createOpenCodeBackend } from "./adapter.ts";
import { OpenCodeTransport, type SafeOpenCodeError } from "./transport.ts";
import type { OpenCodeSupervisor } from "./supervisor.ts";
import type { NormalizedEvent } from "../types.ts";
import { createAgentManager } from "../../agent-manager.ts";
import { OfficeState } from "../../../shared/office-state.ts";
import { STATE_ROOT } from "../../config.ts";
import { join } from "node:path";

const CANARY = "LOCAL_FAILURE_HEADER_SECRET_CANARY";
const failure = Object.assign(new Error(`Authorization: Bearer ${CANARY}`), {
  code: "ConnectionRefused",
  headers: { authorization: CANARY },
});
type Stage = "acquire" | "session" | "session-json" | "begin" | "events" | "body" | "reader" | "prompt" | "end" | "idle" | "race" | "close" | "late-permission";
let restoreFetch: (() => void) | undefined;
afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });

function fixture(stage: Stage, onPrompt = () => {}) {
  let ended = 0;
  let prompts = 0;
  let eventStream: ReadableStreamDefaultController | undefined;
  const permissionReplies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "http://127.0.0.1:1") return originalFetch(input, init);
    if (url.pathname === "/session") {
      if (stage === "session") return new Response(CANARY, { status: 503 });
      if (stage === "session-json") return new Response("{");
      return Response.json({ id: "failure-session" });
    }
    if (url.pathname === "/event") {
      if (stage === "events") return new Response(CANARY, { status: 502 });
      if (stage === "body") return new Response(null);
      return new Response(new ReadableStream({
        start(controller) {
          eventStream = controller;
          if (stage === "reader") controller.error(failure);
          else if (stage === "end") controller.close();
          else if (stage === "idle") {
            controller.enqueue(new TextEncoder().encode('data: {"type":"session.idle","properties":{"sessionID":"failure-session"}}\n\n'));
          }
          init?.signal?.addEventListener("abort", () => {
            try { controller.close(); } catch { /* Already failed or closed. */ }
          }, { once: true });
        },
      }));
    }
    if (url.pathname.endsWith("/prompt_async")) {
      prompts++;
      if (stage === "late-permission") {
        const response = new Response(null);
        Object.defineProperty(response, "ok", { get() {
          // Queue the reader before send() catches this response failure.
          // The permission handler's await resumes after that catch settles.
          eventStream!.enqueue(new TextEncoder().encode('data: {"type":"permission.asked","properties":{"sessionID":"failure-session","id":"late","permission":"bash","patterns":["pwd"],"metadata":{"command":"pwd"}}}\n\n'));
          throw failure;
        } });
        return response;
      }
      if (stage === "race" || stage === "close") {
        if (stage === "race") eventStream!.error(failure);
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          onPrompt();
        });
      }
      return new Response(CANARY, { status: 504 });
    }
    if (url.pathname === "/permission/late/reply") {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON permission reply.");
      permissionReplies.push(JSON.parse(init.body));
    }
    if (url.pathname === "/provider") return Response.json({ all: [], connected: [] });
    return Response.json(true);
  }) as typeof fetch);
  restoreFetch = () => fetchSpy.mockRestore();
  const supervisor = {
    acquire: async () => {
      if (stage === "acquire") throw failure;
      return {
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
        authHeader: "Basic synthetic",
        beginTurn: async () => { if (stage === "begin") throw failure; },
        endTurn: () => { ended++; },
        release: () => {},
      };
    },
  } as unknown as OpenCodeSupervisor;
  return { supervisor, ended: () => ended, prompts: () => prompts, permissionReplies };
}

const cases: Array<[Stage, string, string, number | undefined]> = [
  ["acquire", "OpenCode turn failed", "Error", undefined],
  ["session", "OpenCode turn failed", "Error", 503],
  ["session-json", "OpenCode turn failed", "SyntaxError", undefined],
  ["begin", "OpenCode turn failed", "Error", undefined],
  ["events", "OpenCode turn failed", "Error", 502],
  ["body", "OpenCode turn failed", "Error", undefined],
  ["reader", "OpenCode event stream failed", "Error", undefined],
  ["prompt", "OpenCode turn failed", "Error", 504],
  ["end", "OpenCode event stream ended before turn completion", "Error", undefined],
  ["idle", "OpenCode became idle without a recorded completion", "Error", undefined],
  ["race", "OpenCode event stream failed", "Error", undefined],
];

for (const [stage, context, name, statusCode] of cases) {
  it(`reports ${stage} failure once with safe class and status`, async () => {
    const harness = fixture(stage);
    const errors: SafeOpenCodeError[] = [];
    const events: NormalizedEvent[] = [];
    const transport = new OpenCodeTransport({
      supervisor: harness.supervisor, cwd: STATE_ROOT, model: "provider/model",
      systemPrompt: "system", safeErrorSink: (error) => errors.push(error),
    });
    try {
      await transport.send([{ type: "text", text: "go" }], (event) => events.push(event));
      const code = ["acquire", "begin", "reader", "race"].includes(stage) ? "ConnectionRefused" : undefined;
      expect(errors, "safe error projection").toEqual([{ name, ...(code ? { code } : {}), ...(statusCode === undefined ? {} : { statusCode }) }]);
      expect(events.filter((event) => event.kind === "turn_completed"), "single failed completion").toEqual([{
        kind: "turn_completed", status: "failed",
        error: `${context} (${name}${code ? `/${code}` : ""}; HTTP status: ${statusCode ?? "unavailable"}).`,
      }]);
      expect(JSON.stringify({ errors, events }), "no raw error fields").not.toContain(CANARY);
      expect(harness.ended(), "balanced turn lease").toBe(["acquire", "session", "session-json", "begin"].includes(stage) ? 0 : 1);
      expect(harness.prompts(), "no prompt after early failure").toBe(stage === "prompt" || stage === "race" ? 1 : 0);
    } finally { transport.close(); }
  });
}

it("drops unreviewed exception fields and still settles if the error observer throws", async () => {
  const error = Object.assign(new Error(CANARY), { name: CANARY, code: CANARY, status: Infinity, headers: { secret: CANARY } });
  const errors: SafeOpenCodeError[] = [];
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: { acquire: async () => { throw error; } } as unknown as OpenCodeSupervisor,
    cwd: STATE_ROOT, model: "provider/model", systemPrompt: "system",
    safeErrorSink: (safe) => { errors.push(safe); throw new Error(CANARY); },
  });
  const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await transport.send([{ type: "text", text: "go" }], (event) => events.push(event));
    expect(errors).toEqual([{ name: "UnknownError", code: "UnknownCode" }]);
    expect(events).toEqual([{ kind: "turn_completed", status: "failed", error: "OpenCode turn failed (UnknownError/UnknownCode; HTTP status: unavailable)." }]);
    expect(consoleSpy.mock.calls).toEqual([["OpenCode error sink failed."]]);
  } finally { consoleSpy.mockRestore(); transport.close(); }
});

it("persists reader failure class, code and status in the agent log", async () => {
  const harness = fixture("reader");
  const errors: SafeOpenCodeError[] = [];
  const backend = createOpenCodeBackend({ supervisor: harness.supervisor, safeErrorSink: (error) => errors.push(error) });
  const settled = Promise.withResolvers<void>();
  let agentId = "";
  const streamed: string[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => ({ ...backend, oneShotPrompt: async () => "test topic" }),
    officeState: new OfficeState({ rooms: [{ id: "failure-room", name: "Failure room", prompt: null }] }),
    initialRooms: [],
    eventSink: (event) => {
      if (event.type === "log_entry" && event.entry.agentId === agentId) streamed.push(event.entry.content);
      if (event.type === "agent_updated" && event.agentId === agentId && event.changes.state === "error") settled.resolve();
    },
  });
  mgr.configureAgentTurnDeps();
  const info = await mgr.spawn("Failure tracer", STATE_ROOT, "default", undefined, undefined, "failure-room", undefined, "provider/model", "high", undefined, "opencode");
  agentId = info!.id;
  try {
    mgr.enqueueMessage(agentId, { sender: { kind: "user", username: "tester" }, text: "go" });
    await settled.promise;
    const expected = "OpenCode event stream failed (Error/ConnectionRefused; HTTP status: unavailable).";
    expect(errors, "manager safe error sink").toEqual([{ name: "Error", code: "ConnectionRefused" }]);
    expect(JSON.stringify(mgr.getAgentLogs(agentId)), "log cache omits raw exception message").not.toContain(failure.message);
    expect(streamed, "live agent error trace").toContain(expected);
    expect(mgr.getAgentLogs(agentId).filter((entry) => entry.kind === "error").map((entry) => entry.content), "cached agent error trace").toEqual([expected]);
    let persisted = "";
    for await (const path of new Bun.Glob("**/*.jsonl").scan(join(STATE_ROOT, "logs", agentId))) {
      persisted += await Bun.file(join(STATE_ROOT, "logs", agentId, path)).text();
    }
    expect(persisted, "persisted agent error trace").toContain(expected);
    expect(persisted, "JSONL omits raw exception message").not.toContain(failure.message);
    expect(persisted, "persisted trace scrubs raw message").not.toContain(CANARY);
    expect(harness.prompts(), "reader failure prevents provider prompt").toBe(0);
  } finally { await mgr.kill(agentId); }
});

it("does not report intentional closure as a turn failure", async () => {
  const harness = fixture("close", () => transport.close());
  const errors: SafeOpenCodeError[] = [];
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor, cwd: STATE_ROOT, model: "provider/model",
    systemPrompt: "system", safeErrorSink: (error) => errors.push(error),
  });
  try {
    await transport.send([{ type: "text", text: "go" }], (event) => events.push(event));
    expect(errors, "intentional close has no failure diagnostic").toEqual([]);
    expect(events.filter((event) => event.kind === "turn_completed"), "intentional close has no failed completion").toEqual([]);
  } finally { transport.close(); }
});

it("delivers and answers a late approval after the turn settles", async () => {
  const harness = fixture("late-permission");
  const events: NormalizedEvent[] = [];
  const transport = new OpenCodeTransport({
    supervisor: harness.supervisor, cwd: STATE_ROOT, model: "provider/model", systemPrompt: "system",
  });
  try {
    await transport.send([{ type: "text", text: "go" }], (event) => events.push(event));
    expect(events.map((event) => event.kind), "late approval remains visible after completion").toEqual(["system_init", "turn_completed", "approval_request"]);
    await transport.approve("late", { kind: "deny" });
    expect(harness.permissionReplies, "late approval remains answerable").toEqual([{ reply: "reject" }]);
  } finally { transport.close(); }
});
