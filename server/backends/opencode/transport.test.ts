// The OpenCode 2.1.4 wire contract of the transport (task e47be82a): the
// requests a turn sends, how the recorded /api/event frames of fixtures/v2
// become normalized events, permissions, failures, history and the catalog.
// Lifecycle and recovery: transport-failure.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  discoverOpenCodeModels,
  OpenCodeTransport,
  OPENCODE_AUTH_FAILURE,
  OPENCODE_EFFORT_CATALOG_UNAVAILABLE,
  OPENCODE_PERMISSION_ID_WARNING,
  OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE,
  OPENCODE_SETTINGS_MISSING_FAILURE,
  openCodeEffortUnavailableNotice,
  openCodeModelGoneFailure,
  openCodeModelUnavailableFailure,
  type OpenCodeContextBreakdown,
  type OpenCodeTransportOptions,
} from "./transport.ts";
import {
  builtinPluginRow,
  configEntries,
  drivenClock,
  FAKE_CWD,
  FAKE_PROFILE,
  FAKE_SESSION,
  fakeOpenCode,
  fakeSupervisor,
  fixtureSession,
  fixtureTurn,
  fixtureTurns,
  loadFixture,
  modelRow,
  ourPluginRow,
  settleUntil,
  type FakeLeaseOptions,
  type FakeOptions,
  type FakeTurn,
  type Frame,
} from "./fake-opencode-v2.ts";
import { openCodeSafetyPluginDir } from "./profile-paths.ts";
import { openCodeAgentRules } from "./supervisor.ts";
import { openCodeMcpServerConfig } from "./config-layers.ts";
import { OPENCODE_SAFETY_PLUGIN_ID } from "./safety-plugin-tool.ts";
import type { OpenCodeAuthorityBroker } from "./authority-broker.ts";
import { OPENCODE_TURN_HANDLE_PLACEHOLDER } from "./office-proxy-shared.ts";
import { SAFETY_WARNING } from "../codex/safety-hook.ts";
import type { NormalizedEvent } from "../types.ts";
import { providerRefusal } from "../provider-text.ts";
import { translatorFor } from "../../../shared/i18n/translate.ts";
import {
  renderLogText,
  type LogText,
} from "../../../shared/i18n/log-message.ts";
import { EFFORT_LEVELS } from "../../../shared/types.ts";
import { expectRejection } from "../../test-support/expect-rejection.ts";

// Isomux's own lines are messages each reader words (task c37a7365); these
// checks read the English render.
const english = (text: LogText) => renderLogText(translatorFor("en"), text);

type Completion = Extract<NormalizedEvent, { kind: "turn_completed" }>;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Real time, bounded: the fake plays its frames on event-loop turns.
async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
}

function setup(
  options: {
    fake?: FakeOptions;
    lease?: FakeLeaseOptions;
    transport?: Partial<OpenCodeTransportOptions>;
  } = {},
) {
  const fake = fakeOpenCode(options.fake);
  cleanups.push(fake.restore);
  const lease = fakeSupervisor(options.lease);
  const contexts: OpenCodeContextBreakdown[] = [];
  const transport = new OpenCodeTransport({
    cwd: FAKE_CWD,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    supervisor: lease.supervisor,
    completedStepSink: (breakdown) => contexts.push(breakdown),
    ...options.transport,
  });
  cleanups.push(() => transport.close());
  const events: NormalizedEvent[] = [];
  const completions = () =>
    events.filter(
      (event): event is Completion => event.kind === "turn_completed",
    );
  // One turn: its events, from send() to its turn_completed.
  const turn = async (
    parts: { type: "text"; text: string }[] = [{ type: "text", text: "go" }],
    onEvent?: (event: NormalizedEvent) => void,
  ) => {
    const from = events.length;
    const ended = completions().length;
    await transport.send(parts, (event) => {
      events.push(event);
      onEvent?.(event);
    });
    await until(() => completions().length > ended);
    const own = events.slice(from);
    return { events: own, end: own.find((e) => e.kind === "turn_completed") };
  };
  return { fake, lease, transport, events, contexts, completions, turn };
}

const kinds = (
  events: NormalizedEvent[],
  ...wanted: NormalizedEvent["kind"][]
) => events.filter((event) => wanted.includes(event.kind));
const textOf = (events: NormalizedEvent[]) =>
  events.flatMap((e) => (e.kind === "assistant_text" ? [e.text] : [])).join("");
const toolCalls = (events: NormalizedEvent[]) =>
  events.filter(
    (e): e is Extract<NormalizedEvent, { kind: "tool_call" }> =>
      e.kind === "tool_call",
  );
const toolResults = (events: NormalizedEvent[]) =>
  events.filter(
    (e): e is Extract<NormalizedEvent, { kind: "tool_result" }> =>
      e.kind === "tool_result",
  );
const approvals = (events: NormalizedEvent[]) =>
  events.filter(
    (e): e is Extract<NormalizedEvent, { kind: "approval_request" }> =>
      e.kind === "approval_request",
  );

// A recorded turn whose frames a test edits.
function editedTurn(
  name: string,
  edit: (frames: Frame[]) => Frame[],
  index = 0,
  options: Omit<FakeTurn, "frames" | "session"> = {},
): FakeTurn {
  const recorded = fixtureTurn(name, index, options);
  return { ...recorded, frames: edit(recorded.frames) };
}

// The turn's streamed parts, in the order they reached the chat.
const parts = (events: NormalizedEvent[]) =>
  events.filter((e) => e.kind === "thinking" || e.kind === "assistant_text");

const DELTAS = new Set(["session.text.delta", "session.reasoning.delta"]);
// Each text and reasoning delta cut into deltas of `size` characters, as
// 2.1.4 streams a real model's answer.
function chunked(frames: Frame[], size = 3): Frame[] {
  return frames.flatMap((frame) => {
    if (!DELTAS.has(frame.type)) return [frame];
    const delta = String(frame.data.delta);
    const out: Frame[] = [];
    for (let at = 0; at < delta.length; at += size)
      out.push({
        ...frame,
        data: { ...frame.data, delta: delta.slice(at, at + size) },
      });
    return out;
  });
}

// A second reasoning part with no text after the first one ends, as a model
// that keeps its reasoning to itself streams it.
function withEmptyReasoning(frames: Frame[]): Frame[] {
  const ended = frames.findIndex((f) => f.type === "session.reasoning.ended");
  const started = frames.find((f) => f.type === "session.reasoning.started")!;
  const part = (type: string, offset: number, data = {}): Frame => ({
    ...frames[ended],
    id: `${frames[ended].id}_empty_${offset}`,
    type,
    created: frames[ended].created! + offset,
    data: { ...started.data, ordinal: 1, ...data },
  });
  return [
    ...frames.slice(0, ended + 1),
    part("session.reasoning.started", 1),
    part("session.reasoning.ended", 3, { text: "" }),
    ...frames.slice(ended + 1),
  ];
}

const terminalIndex = (frames: Frame[]) =>
  frames.findIndex(
    (frame) =>
      frame.type.startsWith("session.execution.") &&
      frame.type !== "session.execution.started",
  );

// A turn that ends with this failure instead of its recorded end.
function failingTurn(error: Record<string, unknown>): FakeTurn {
  return editedTurn("text-reasoning", (frames) => {
    const session = frames.find((f) => f.type === "session.inbox.enqueued")!
      .data.sessionID;
    const delivered = frames.findIndex(
      (frame) => frame.type === "session.inbox.delivered",
    );
    return [
      ...frames.slice(0, delivered + 1),
      {
        type: "session.execution.failed",
        created: frames[delivered].created! + 10,
        data: { sessionID: session, error },
      },
    ];
  });
}

describe("OpenCode 2 turn requests", () => {
  it("checks the plugin, sets the instructions, selects the model and sends the prompt, in that order, on every turn", async () => {
    const handle = "session-handle";
    const authorityBroker = {
      bind: () => ({
        handle,
        activate: () => "turn-handle",
        deactivate: () => {},
        unbind: () => {},
      }),
    } as unknown as OpenCodeAuthorityBroker;
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      transport: {
        systemPrompt: `office ${OPENCODE_TURN_HANDLE_PLACEHOLDER}`,
        agentId: "agent-1",
        agentToken: "token-1",
        authorityBroker,
      },
    });
    const first = await h.turn([
      { type: "text", text: "first part" },
      { type: "text", text: "second part" },
    ]);
    const second = await h.turn();
    expect(first.end?.status).toBe("completed");
    expect(second.end?.status).toBe("completed");

    const session = h.fake.sessionId;
    const turnRequests = h.fake.requests
      .filter((request) =>
        [
          "/api/plugin",
          `/api/experimental/session/${session}/instructions/entries/isomux`,
          `/api/session/${session}/model`,
          `/api/session/${session}/prompt`,
        ].includes(request.path),
      )
      .map((request) => `${request.method} ${request.path.split("/").at(-1)}`);
    // MUTANT: a plugin check on the first turn only, or a model selected
    // after the prompt.
    expect(turnRequests).toEqual([
      "GET plugin",
      "PUT isomux",
      "POST model",
      "POST prompt",
      "GET plugin",
      "PUT isomux",
      "POST model",
      "POST prompt",
    ]);
    // The 2.1.4 prompt route takes text only: parts join with a blank line.
    const prompts = h.fake.calls("POST", /\/prompt$/).map((r) => r.body);
    expect(prompts).toEqual([
      { text: "first part\n\nsecond part" },
      { text: "go" },
    ]);
    // One authority handle per transport, byte-identical across turns, so
    // OpenCode sees no instruction change.
    const instructions = h.fake
      .calls("PUT", /instructions\/entries\/isomux$/)
      .map((r) => r.body);
    expect(instructions).toEqual([
      { value: `office ${handle}` },
      { value: `office ${handle}` },
    ]);
    // E4: an explicit model, with the effort's variant, on every prompt.
    expect(h.fake.calls("POST", /\/model$/).map((r) => r.body)).toEqual([
      { model: { providerID: "provider", id: "model", variant: "high" } },
      { model: { providerID: "provider", id: "model", variant: "high" } },
    ]);
    // Folder routes name the folder.
    for (const request of h.fake.requests.filter((r) =>
      ["/api/plugin", "/api/model", "/api/provider"].includes(r.path),
    ))
      expect(request.query.get("location[directory]")).toBe(FAKE_CWD);
  });

  it("creates its session in the folder with the agent and that agent's full rule list (C1)", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("text-reasoning")] },
      transport: { sessionId: undefined, agent: "isomux-interactive-bypass" },
    });
    await h.turn();
    // The whole body: a location with a workspace would make 2.1.4 ignore
    // the session's environment (core/src/shell.ts:268-272).
    expect(h.fake.calls("POST", /^\/api\/session$/).map((r) => r.body)).toEqual(
      [
        {
          title: expect.any(String),
          location: { directory: FAKE_CWD },
          agent: "isomux-interactive-bypass",
          permissions: openCodeAgentRules("isomux-interactive-bypass"),
        },
      ],
    );
    // Created with its agent: no switch and no rule change.
    expect(h.fake.calls("PATCH", /^\/api\/session\/[^/]+$/)).toEqual([]);
    expect(h.fake.calls("POST", /\/agent$/)).toEqual([]);
    expect(h.events[0]).toEqual({
      kind: "system_init",
      sessionId: h.fake.sessionId,
      model: "provider/model",
    });
  });

  it("refuses a turn whose model is not in provider/model form before it sends a model or a prompt", async () => {
    const h = setup({ transport: { model: "no-provider" } });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    // MUTANT: a prompt sent with no model selected runs on OpenCode's default.
    expect(h.fake.calls("POST", /\/(model|prompt)$/)).toEqual([]);
  });

  // Task 30dd196e: a /skill body reaches the turn with its office calls in
  // the proxy form, which names the turn handle by its placeholder, as the
  // system prompt does. The transport fills in its bound handle everywhere.
  it("sends the bound handle in place of each turn handle placeholder in the turn text", async () => {
    const handle = "session-handle";
    const authorityBroker = {
      bind: () => ({
        handle,
        activate: () => "turn-handle",
        deactivate: () => {},
        unbind: () => {},
      }),
    } as unknown as OpenCodeAuthorityBroker;
    const h = setup({
      fake: { turns: [fixtureTurn("text-reasoning")] },
      transport: {
        systemPrompt: `office ${OPENCODE_TURN_HANDLE_PLACEHOLDER}`,
        agentId: "agent-1",
        agentToken: "token-1",
        authorityBroker,
      },
    });
    const { end } = await h.turn([
      { type: "text", text: `first ${OPENCODE_TURN_HANDLE_PLACEHOLDER}` },
      { type: "text", text: `second ${OPENCODE_TURN_HANDLE_PLACEHOLDER}` },
    ]);
    expect(end?.status).toBe("completed");
    expect(h.fake.calls("POST", /\/prompt$/).map((r) => r.body)).toEqual([
      { text: `first ${handle}\n\nsecond ${handle}` },
    ]);
  });

  it("refuses a turn whose text names the turn handle when it has no authority binding, before it sends a prompt", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("text-reasoning")] },
    });
    const { end } = await h.turn([
      { type: "text", text: `call ${OPENCODE_TURN_HANDLE_PLACEHOLDER}` },
    ]);
    expect(end?.status).toBe("failed");
    // MUTANT: a prompt sent with the placeholder makes every office call in
    // it fail at the proxy.
    expect(h.fake.calls("POST", /\/prompt$/)).toEqual([]);
    // The same transport sends a turn without the placeholder: the refusal
    // came from the placeholder, not from the setup.
    expect((await h.turn()).end?.status).toBe("completed");
    expect(h.fake.calls("POST", /\/prompt$/).map((r) => r.body)).toEqual([
      { text: "go" },
    ]);
  });

  it("selects no variant for a model without one, and names the effort it cannot honor", async () => {
    const h = setup({
      fake: {
        models: () => [
          modelRow("provider", "plain", { variants: [] }),
          modelRow("provider", "model", {
            variants: [{ id: "low", settings: {} }],
          }),
        ],
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      transport: { model: "provider/plain", effort: "high" },
    });
    const plain = await h.turn();
    expect(h.fake.calls("POST", /\/model$/).at(-1)?.body).toEqual({
      model: { providerID: "provider", id: "plain" },
    });
    expect(kinds(plain.events, "system_text")).toEqual([]);

    const other = new OpenCodeTransport({
      cwd: FAKE_CWD,
      model: "provider/model",
      effort: "high",
      systemPrompt: "system",
      supervisor: h.lease.supervisor,
      sessionId: "ses_other",
    });
    cleanups.push(() => other.close());
    const events: NormalizedEvent[] = [];
    h.fake.queue(fixtureTurn("text-reasoning"));
    await other.send([{ type: "text", text: "go" }], (e) => events.push(e));
    await until(() => events.some((e) => e.kind === "turn_completed"));
    expect(h.fake.calls("POST", /\/model$/).at(-1)?.body).toEqual({
      model: { providerID: "provider", id: "model" },
    });
    expect(kinds(events, "system_text")).toEqual([
      {
        kind: "system_text",
        text: openCodeEffortUnavailableNotice("provider/model", "high"),
      },
    ]);
  });

  it("switches a resumed session to the agent of this mode once, before its instructions (R7)", async () => {
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      transport: { sessionId: FAKE_SESSION, agent: "isomux-cron" },
    });
    await h.turn();
    await h.turn();
    // MUTANT: no switch, so a cron run keeps the agent the session was
    // created with (2.1.4's prompt has no agent field).
    expect(h.fake.promptLog.map((p) => p.agent)).toEqual([
      "isomux-cron",
      "isomux-cron",
    ]);
    const label = (r: { method: string; path: string }) =>
      r.method === "GET" && r.path === "/api/plugin"
        ? "plugin"
        : r.method === "POST" && r.path.endsWith("/agent")
          ? "agent"
          : r.method === "PUT" && r.path.endsWith("/isomux")
            ? "instructions"
            : r.method === "POST" &&
                /\/session\/[^/]+\/(model|prompt)$/.test(r.path)
              ? r.path.split("/").at(-1)
              : null;
    expect(
      h.fake.requests
        .map(label)
        .filter((step) => step !== null)
        .slice(0, 5),
    ).toEqual(["plugin", "agent", "instructions", "model", "prompt"]);
    // The transport knows the agent it set: the next turn does not switch.
    expect(h.fake.calls("POST", /\/agent$/).map((r) => r.body)).toEqual([
      { agent: "isomux-cron" },
    ]);
  });

  it("refuses a turn whose agent switch OpenCode refuses, before the prompt", async () => {
    const steps: (string | undefined)[] = [];
    const h = setup({
      fake: { status: { "session.agent": 503 } },
      transport: {
        sessionId: FAKE_SESSION,
        safeErrorSink: (_error, context) => steps.push(context?.step),
      },
    });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    expect(h.fake.prompts()).toBe(0);
    expect(steps).toEqual(["agent"]);
  });

  it("refuses a turn whose instructions OpenCode will not take, before the prompt, in words of its own (R6)", async () => {
    // 2.1.4 answers 413 above 256 KiB of instructions (2026-10-25).
    const h = setup({ fake: { status: { instructions: 413 } } });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    expect(h.fake.prompts()).toBe(0);
    // MUTANT: the generic "OpenCode turn failed (Error; HTTP status: 413)."
    expect(english(end!.error!)).not.toMatch(/^OpenCode turn failed \(/);
  });
});

// Task 4b354a81: the session's rules (C1), Isomux's top layer (C3) and the
// environment of the session's shell commands (1010dd4b).
describe("OpenCode 2 session settings", () => {
  // Never a real secret: the transport sends what the adapter gives it.
  const environment = {
    PATH: "/usr/bin:/bin",
    MEMBER_VARIABLE: "member-value",
  };

  it("creates a normal session with the build agent and its rules", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("text-reasoning")] },
      transport: { sessionId: undefined },
    });
    await h.turn();
    expect(h.fake.calls("POST", /^\/api\/session$/).map((r) => r.body)).toEqual(
      [
        {
          title: expect.any(String),
          location: { directory: FAKE_CWD },
          agent: "build",
          permissions: openCodeAgentRules("build"),
        },
      ],
    );
  });

  it("sends the environment, checks the settings and the plugin, replaces the rules and switches the agent before the instructions, in that order (R3)", async () => {
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      transport: {
        sessionId: FAKE_SESSION,
        agent: "isomux-cron",
        toolEnvironment: environment,
      },
    });
    expect((await h.turn()).end?.status).toBe("completed");
    expect((await h.turn()).end?.status).toBe("completed");
    const session = `/api/session/${FAKE_SESSION}`;
    const label = (r: { method: string; path: string }) =>
      r.method === "PUT" && r.path === `${session}/environment`
        ? "environment"
        : r.method === "GET" && r.path === "/api/mcp"
          ? "mcp"
          : r.method === "GET" && r.path === "/api/config"
            ? "config"
            : r.method === "GET" && r.path === "/api/plugin"
              ? "plugin"
              : r.method === "PATCH" && r.path === session
                ? "permissions"
                : r.method === "POST" && r.path === `${session}/agent`
                  ? "agent"
                  : r.method === "PUT" && r.path.endsWith("/entries/isomux")
                    ? "instructions"
                    : r.method === "POST" &&
                        (r.path === `${session}/model` ||
                          r.path === `${session}/prompt`)
                      ? r.path.split("/").at(-1)
                      : null;
    // MUTANT: the environment sent once per transport, so a replaced server
    // runs the next turn's shell commands with its own environment.
    expect(h.fake.requests.map(label).filter((step) => step !== null)).toEqual([
      "environment",
      "mcp",
      "config",
      "plugin",
      "permissions",
      "agent",
      "instructions",
      "model",
      "prompt",
      "environment",
      "mcp",
      "plugin",
      "instructions",
      "model",
      "prompt",
    ]);
    expect(h.fake.calls("PUT", /\/environment$/).map((r) => r.body)).toEqual([
      { variables: environment },
      { variables: environment },
    ]);
    // Rules set at create beat the agent's own: a switch replaces them.
    // MUTANT: no PATCH, so a session created for another mode keeps its rules.
    expect(
      h.fake.calls("PATCH", /^\/api\/session\/[^/]+$/).map((r) => r.body),
    ).toEqual([{ permissions: openCodeAgentRules("isomux-cron") }]);
    // C3: early answers of GET /api/agent are empty, so Isomux never reads it.
    expect(
      h.fake.requests.filter((r) => r.path.startsWith("/api/agent")),
    ).toEqual([]);
    // R6: plugin updates stay off; only this route installs one.
    expect(
      h.fake.requests.filter((r) => r.path === "/api/plugin/update"),
    ).toEqual([]);
  });

  it("gives a subagent's session the turn's environment when it adopts the session", async () => {
    const recorded = loadFixture("probe-subagent-permission");
    const child = recorded.find(
      (f) => f.type === "session.created" && f.data.parentID,
    )!.data.sessionID as string;
    const h = setup({
      fake: { turns: [fixtureTurn("probe-subagent-permission")] },
      transport: { toolEnvironment: environment },
    });
    const { end } = await h.turn([{ type: "text", text: "go" }], (event) => {
      if (event.kind === "approval_request")
        void h.transport.approve(event.approvalId, { kind: "allow_once" });
    });
    expect(end?.status).toBe("completed");
    // A child does not inherit its parent's environment (probe p10).
    // MUTANT: the agent's session only.
    expect(
      h.fake
        .calls("PUT", new RegExp(`^/api/session/${child}/environment$`))
        .map((r) => r.body),
    ).toEqual([{ variables: environment }]);
  });

  const docs = {
    name: "isomux-docs",
    url: "https://docs.example.com/mcp",
    headers: { authorization: "Bearer fake-header-value" },
  };
  const mcpCalls = (h: ReturnType<typeof setup>, method: string) =>
    h.fake.calls(method, /^\/api\/experimental\/mcp\/[^/]+$/).map((r) => ({
      name: decodeURIComponent(r.path.split("/").at(-1)!),
      directory: r.query.get("location[directory]"),
      ...(r.body === undefined ? {} : { body: r.body }),
    }));

  it("makes the folder's Isomux MCP servers the current list before every prompt, and leaves the member's alone", async () => {
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
        // A server Isomux added before this process, and one of the member's.
        mcpServers: () => ["isomux-removed", "member-tool"],
      },
      lease: { mcpServers: () => [docs] },
    });
    expect((await h.turn()).end?.status).toBe("completed");
    expect((await h.turn()).end?.status).toBe("completed");
    // MUTANT: removals kept in memory, so a server removed while another
    // Isomux process ran keeps its headers in the folder.
    expect(mcpCalls(h, "DELETE")).toEqual([
      { name: "isomux-removed", directory: FAKE_CWD },
    ]);
    // The second turn sends no PUT: the same config again costs OpenCode a
    // state reload, up to 0.94 s per server (probe, 2026-10-25).
    expect(mcpCalls(h, "PUT")).toEqual([
      {
        name: "isomux-docs",
        directory: FAKE_CWD,
        body: { config: openCodeMcpServerConfig(docs) },
      },
    ]);
    expect(
      h.fake
        .calls("GET", /^\/api\/mcp$/)
        .map((r) => r.query.get("location[directory]")),
    ).toEqual([FAKE_CWD, FAKE_CWD]);
  });

  it("sends a server's config again when its headers change, when the folder lost it, and on a new server", async () => {
    let servers = [docs];
    let serverKey = "server-1";
    const h = setup({
      fake: {
        turns: Array.from({ length: 5 }, () => fixtureTurn("text-reasoning")),
      },
      lease: { mcpServers: () => servers, serverKey: () => serverKey },
    });
    const puts = () => mcpCalls(h, "PUT").map((call) => call.body);
    await h.turn();
    await h.turn();
    expect(puts(), "one PUT for an unchanged config").toHaveLength(1);
    // A refreshed OAuth access token, for example.
    const rotated = {
      ...docs,
      headers: { authorization: "Bearer rotated-value" },
    };
    servers = [rotated];
    await h.turn();
    // MUTANT: the cache keyed by name only.
    expect(puts().at(-1)).toEqual({ config: openCodeMcpServerConfig(rotated) });
    expect(puts()).toHaveLength(2);
    // The folder's location was rebuilt: GET no longer lists the server.
    h.fake.forgetMcp(FAKE_CWD);
    await h.turn();
    // MUTANT: a cache hit trusted over the folder's own list.
    expect(puts(), "a PUT for a server the folder lost").toHaveLength(3);
    // A replacement server has none of the folder's run-time adds.
    serverKey = "server-2";
    await h.turn();
    expect(puts(), "a PUT on a new server").toHaveLength(4);
  });

  it("takes a change of the list at the next prompt", async () => {
    let servers = [docs];
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      lease: { mcpServers: () => servers },
    });
    await h.turn();
    const mail = {
      ...docs,
      name: "isomux-mail",
      url: "https://mail.example.com/mcp",
    };
    servers = [mail];
    await h.turn();
    // MUTANT: the list read once per transport.
    expect(mcpCalls(h, "PUT").map((call) => call.name)).toEqual([
      "isomux-docs",
      "isomux-mail",
    ]);
    expect(mcpCalls(h, "DELETE").map((call) => call.name)).toEqual([
      "isomux-docs",
    ]);
  });

  for (const route of ["mcp.add", "mcp.remove"] as const)
    it(`fails a turn whose MCP servers OpenCode does not take (${route}), before the prompt`, async () => {
      const h = setup({
        fake: {
          status: { [route]: 500 },
          mcpServers: () => ["isomux-removed"],
        },
        lease: { mcpServers: () => [docs] },
      });
      const { end } = await h.turn();
      expect(end?.status).toBe("failed");
      // MUTANT: the failure ignored, so a removed server stays in the folder.
      expect(h.fake.prompts()).toBe(0);
    });

  it("fails a turn whose rules OpenCode does not take before the switch, and names the step", async () => {
    const steps: (string | undefined)[] = [];
    const h = setup({
      fake: { status: { "session.patch": 500 } },
      transport: {
        sessionId: FAKE_SESSION,
        agent: "isomux-cron",
        safeErrorSink: (_error, context) => steps.push(context?.step),
      },
    });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    expect(steps).toEqual(["permissions"]);
    // MUTANT: the agent switched anyway, on the rules of another mode.
    expect(h.fake.calls("POST", /\/agent$/)).toEqual([]);
    expect(h.fake.prompts()).toBe(0);
  });

  it("fails a turn whose environment OpenCode does not take, before the prompt", async () => {
    const h = setup({
      fake: { status: { "session.environment": 500 } },
      transport: { toolEnvironment: environment },
    });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    // MUTANT: the failure ignored, so the shell runs with the server's
    // environment, its password included.
    expect(h.fake.prompts()).toBe(0);
  });

  for (const [why, entries] of [
    ["no document without a path", () => configEntries(null)],
    [
      "a document without a path that is not Isomux's",
      () => configEntries({ instructions: ["remote.md"] }),
    ],
  ] as const)
    it(`refuses a turn when OpenCode lists ${why} (C3)`, async () => {
      const h = setup({ fake: { config: entries } });
      const { end } = await h.turn();
      // MUTANT: any document without a path passes, or no check at all.
      expect(end).toMatchObject({
        status: "failed",
        error: OPENCODE_SETTINGS_MISSING_FAILURE,
      });
      expect(h.fake.prompts()).toBe(0);
      expect(
        h.fake
          .calls("GET", /^\/api\/config$/)[0]
          .query.get("location[directory]"),
      ).toBe(FAKE_CWD);
    });

  it("checks Isomux's top layer once per server and folder (C3)", async () => {
    let serverKey = "server-1";
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
      lease: { serverKey: () => serverKey },
    });
    await h.turn();
    await h.turn();
    const checks = () => h.fake.calls("GET", /^\/api\/config$/).length;
    expect(checks(), "two turns, one check").toBe(1);
    const another = (cwd: string) => {
      const transport = new OpenCodeTransport({
        cwd,
        model: "provider/model",
        systemPrompt: "system",
        supervisor: h.lease.supervisor,
        sessionId: FAKE_SESSION,
      });
      cleanups.push(() => transport.close());
      return transport;
    };
    const run = async (transport: OpenCodeTransport) => {
      h.fake.queue(fixtureTurn("text-reasoning"));
      const events: NormalizedEvent[] = [];
      await transport.send([{ type: "text", text: "go" }], (e) =>
        events.push(e),
      );
      await until(() => events.some((e) => e.kind === "turn_completed"));
      return events.find((e) => e.kind === "turn_completed");
    };
    expect(await run(another(FAKE_CWD))).toMatchObject({ status: "completed" });
    expect(checks(), "another agent in the same folder").toBe(1);
    expect(await run(another("/work/other"))).toMatchObject({
      status: "completed",
    });
    expect(checks(), "another folder").toBe(2);
    serverKey = "server-2";
    await h.turn();
    // MUTANT: one check per process of Isomux, so a server started later
    // with a dropped top layer runs turns.
    expect(checks(), "a new server").toBe(3);
  });
});

describe("OpenCode 2 turn end (T1)", () => {
  it("ends the turn at its own terminal frame, not at a late one of the previous busy period", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("text-reasoning", (frames) => [
            // The interrupt of the previous busy period, late.
            {
              type: "session.execution.interrupted",
              created: frames[0].created! - 1,
              data: {
                sessionID: frames[0].data.sessionID,
                reason: "user",
              },
            },
            ...frames,
          ]),
        ],
      },
    });
    const { events, end } = await h.turn();
    // MUTANT: the first terminal frame of the session ends the turn.
    expect(end?.status).toBe("completed");
    expect(textOf(events)).toBe("ANSWER:EV text streaming check");
    expect(h.completions()).toHaveLength(1);
  });

  it("ends the turn when every frame, its end included, comes before the prompt answer", async () => {
    const recorded = fixtureTurn("text-reasoning");
    const h = setup({
      fake: {
        turns: [{ ...recorded, beforeAnswer: recorded.frames.length - 1 }],
      },
    });
    const events: NormalizedEvent[] = [];
    let answered = false;
    let textBeforeAnswer = false;
    await h.transport.send([{ type: "text", text: "go" }], (event) => {
      events.push(event);
      if (event.kind === "assistant_text" && !answered) textBeforeAnswer = true;
    });
    answered = true;
    const ended = () => events.filter((e) => e.kind === "turn_completed");
    await until(() => ended().length > 0);
    // The condition this case is about: the stream handled the turn's frames
    // while the prompt answer was still out.
    expect(textBeforeAnswer, "frames handled before the prompt answer").toBe(
      true,
    );
    // MUTANT: frames that come before the input id is known are dropped, and
    // the turn never ends.
    expect(ended()).toMatchObject([{ status: "completed" }]);
    expect(textOf(events)).toBe("ANSWER:EV text streaming check");
  });

  it("does not take session.idle or session.status as the end", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("text-reasoning", (frames) => {
            const delivered = frames.findIndex(
              (f) => f.type === "session.inbox.delivered",
            );
            const sessionID = frames[0].data.sessionID;
            return [
              ...frames.slice(0, delivered + 1),
              { type: "session.idle", data: { sessionID } },
              {
                type: "session.status",
                data: { sessionID, status: { type: "idle" } },
              },
              ...frames.slice(delivered + 1),
            ];
          }),
        ],
      },
    });
    const { events, end } = await h.turn();
    // MUTANT: an idle frame ends the turn before its answer.
    expect(textOf(events)).toBe("ANSWER:EV text streaming check");
    expect(end?.status).toBe("completed");
  });
});

describe("OpenCode 2 event translation", () => {
  // Task 3cb130ad: 2.1.4 sends a delta every few tokens (one GLM turn of
  // 2026-10-25 had 343 reasoning deltas), and each one was a chat row.
  it("shows each part once and whole, however many deltas stream it, with the reasoning's duration", async () => {
    const frames = withEmptyReasoning(
      chunked(fixtureTurn("text-reasoning").frames),
    );
    expect(
      frames.filter((f) => f.type === "session.text.delta").length,
      "the answer streams in many deltas",
    ).toBeGreaterThan(5);
    expect(
      frames.filter((f) => f.type === "session.reasoning.delta").length,
      "the reasoning streams in many deltas",
    ).toBeGreaterThan(2);
    const h = setup({
      fake: { turns: [{ ...fixtureTurn("text-reasoning"), frames }] },
    });
    const { events } = await h.turn();
    // MUTANT: a delta is an entry. MUTANT: an empty reasoning part is a
    // "Thinking" row with a timer.
    // reasoning.started at ...539, reasoning.ended at ...564.
    expect(parts(events)).toEqual([
      { kind: "thinking", text: "gate-reasoning", durationMs: 25 },
      { kind: "assistant_text", text: "ANSWER:EV text streaming check" },
    ]);
  });

  it("takes the whole part from the ended frame when the deltas missed some of it", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("text-reasoning", (frames) =>
            frames.flatMap((frame) =>
              frame.type === "session.text.delta"
                ? [{ ...frame, data: { ...frame.data, delta: "ANSWER:" } }]
                : frame.type === "session.reasoning.delta"
                  ? []
                  : [frame],
            ),
          ),
        ],
      },
    });
    const { events } = await h.turn();
    // MUTANT: the ended frame's text is dropped, sent whole a second time, or
    // sent as its own entry after the deltas' one.
    expect(parts(events)).toEqual([
      { kind: "thinking", text: "gate-reasoning", durationMs: 25 },
      { kind: "assistant_text", text: "ANSWER:EV text streaming check" },
    ]);
  });

  // A stop, or a failure, before the part's ended frame keeps what the model
  // wrote, as one entry before the turn's end.
  for (const [where, cut, open] of [
    [
      "its reasoning",
      (frames: Frame[]) =>
        frames.findIndex((f) => f.type === "session.reasoning.delta") + 2,
      [{ kind: "thinking", text: "gate-r" }],
    ],
    [
      "its answer",
      (frames: Frame[]) =>
        frames.findIndex((f) => f.type === "session.text.delta") + 4,
      [
        { kind: "thinking", text: "gate-reasoning", durationMs: 25 },
        { kind: "assistant_text", text: "ANSWER:EV te" },
      ],
    ],
  ] as const)
    for (const [end, frame, status] of [
      ["stopped", { reason: "user" }, "interrupted"],
      ["failed", { error: { message: "boom" } }, "failed"],
    ] as const)
      it(`keeps the open part once when the turn is ${end} in the middle of ${where}`, async () => {
        const turn = editedTurn("text-reasoning", (frames) => {
          const chunks = chunked(frames);
          const session = chunks.find(
            (f) => f.type === "session.inbox.enqueued",
          )!.data.sessionID;
          const at = cut(chunks);
          return [
            ...chunks.slice(0, at),
            {
              type:
                end === "stopped"
                  ? "session.execution.interrupted"
                  : "session.execution.failed",
              created: chunks[at - 1].created! + 1,
              data: { sessionID: session, ...frame },
            },
          ];
        });
        expect(
          turn.frames.some(
            (f) =>
              f.type === "session.text.ended" ||
              (where === "its reasoning" &&
                f.type === "session.reasoning.ended"),
          ),
          "the open part has no ended frame",
        ).toBe(false);
        const h = setup({ fake: { turns: [turn] } });
        const { events, end: completion } = await h.turn();
        expect(completion?.status).toBe(status);
        // MUTANT: an open part is dropped at the end, or each delta is an
        // entry.
        expect(parts(events)).toEqual([...open]);
        const order = events.map((e) => e.kind);
        expect(order.lastIndexOf(open.at(-1)!.kind)).toBeLessThan(
          order.indexOf("turn_completed"),
        );
      });

  it("pairs a tool call and its result, with the run's duration, and leaves exit 0 a success", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("shell-allow")] },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events, end } = await h.turn();
    const [call] = toolCalls(events);
    expect(toolCalls(events)).toHaveLength(1);
    expect(call).toMatchObject({
      name: "shell",
      input: { command: "printf allowed > ev-allow.txt" },
    });
    // tool.called at ...111, tool.success at ...264.
    expect(toolResults(events)).toEqual([
      {
        kind: "tool_result",
        toolUseId: call.toolUseId,
        content: "(no output)",
        durationMs: 153,
      },
    ]);
    expect(textOf(events)).toBe("RECOVERED_AFTER_TOOL");
    expect(end?.status).toBe("completed");
  });

  it("marks a shell command that exits non-zero as an error result (T3)", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("tool-fail")] },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events, end } = await h.turn();
    const [result] = toolResults(events);
    expect(toolResults(events)).toHaveLength(1);
    // MUTANT: session.tool.success read as a success whatever its exit.
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("failed-before-exit");
    expect(result?.content).toContain("Exited with code 7");
    expect(end?.status).toBe("completed");
  });

  it("gives a provider call id that repeats across turns a new tool id, and ignores another session's tools (T6)", async () => {
    // fixed-ids: two sessions in one stream, and three turns that all call
    // call_gate_001.
    const recorded = loadFixture("fixed-ids");
    const turns = fixtureTurns(recorded);
    const session = fixtureSession(recorded);
    const h = setup({
      fake: {
        turns: [
          { frames: turns[0], session },
          { frames: turns[1], session },
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const first = await h.turn();
    const second = await h.turn();
    // MUTANT: frames of the other session in the stream reach this turn.
    expect(toolCalls(first.events)).toHaveLength(1);
    expect(toolResults(first.events)).toHaveLength(1);
    expect(toolCalls(second.events)).toHaveLength(1);
    expect(toolResults(second.events)).toHaveLength(1);
    expect(toolResults(first.events)[0].toolUseId).toBe(
      toolCalls(first.events)[0].toolUseId,
    );
    expect(toolResults(second.events)[0].toolUseId).toBe(
      toolCalls(second.events)[0].toolUseId,
    );
    // MUTANT: the provider's call id as the tool id.
    expect(toolCalls(second.events)[0].toolUseId).not.toBe(
      toolCalls(first.events)[0].toolUseId,
    );
  });

  it("bills each step and compaction once, and reports each answer step's context", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("shell-allow", (frames) => {
            const end = terminalIndex(frames);
            const failed = loadFixture("compaction").find(
              (f) => f.type === "session.compaction.failed",
            )!;
            return [
              ...frames.slice(0, end),
              {
                ...failed,
                data: {
                  ...failed.data,
                  sessionID: frames[end].data.sessionID,
                  cost: 0.5,
                },
              },
              frames[end],
            ];
          }),
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { end } = await h.turn();
    // Two steps of 9/4/3/2/0 and a failed compaction of 18/8/6/4/0.
    expect(end).toMatchObject({
      status: "completed",
      usage: {
        inputTokens: 36,
        outputTokens: 16,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 0,
      },
      cost: 0.5,
      costMode: "turn",
      usageId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // The context of each answer step: 9 + 4 + 3 + 2 + 0. A compaction is
    // no answer step.
    expect(h.contexts.map((c) => c.totalTokens)).toEqual([18, 18]);
  });

  it("shows a failed compaction and lets the turn finish (T4)", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("text-reasoning", (frames) => {
            const end = terminalIndex(frames);
            const compaction = loadFixture("compaction").filter((f) =>
              f.type.startsWith("session.compaction."),
            );
            return [
              ...frames.slice(0, end),
              ...compaction.map((f) => ({
                ...f,
                data: { ...f.data, sessionID: frames[end].data.sessionID },
              })),
              frames[end],
            ];
          }),
        ],
      },
    });
    const { events, end } = await h.turn();
    // MUTANT: compaction.failed fails the turn, or is not shown.
    expect(end?.status).toBe("completed");
    expect(kinds(events, "system_text")).toHaveLength(1);
    // The summary the compaction wrote is OpenCode's, not an answer.
    expect(textOf(events)).toBe("ANSWER:EV text streaming check");
  });

  it("shows OpenCode's question as an input request and ends as stopped when the member stops it", async () => {
    const h = setup({ fake: { turns: [fixtureTurn("probe-question-form")] } });
    const done = h.turn([{ type: "text", text: "go" }], (event) => {
      if (event.kind === "input_request") void h.transport.abort();
    });
    const { events, end } = await done;
    expect(kinds(events, "input_request")).toEqual([
      {
        kind: "input_request",
        inputType: "question",
        requestId: "frm_1729753080012gS3us7JPQ5J8Q",
      },
    ]);
    expect(h.fake.interrupts()).toBe(1);
    expect(end?.status).toBe("interrupted");
  });

  it("stops a running tool with an error result and ends as stopped (T5)", async () => {
    const h = setup({
      fake: {
        turns: [
          fixtureTurn("probe-interrupt-tool", 0, {
            interruptBefore: (frame) => frame.type === "session.tool.failed",
          }),
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "tool_call") void h.transport.abort();
      },
    );
    expect(h.fake.calls("POST", /\/interrupt$/)).toHaveLength(1);
    // Abort is /interrupt with no resume.
    expect(
      h.fake.calls("POST", /\/interrupt$/)[0].body ?? {},
    ).not.toMatchObject({
      resume: true,
    });
    const results = toolResults(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolUseId: toolCalls(events)[0].toolUseId,
      isError: true,
    });
    expect(end?.status).toBe("interrupted");
  });

  it("shows the provider's retries with their number of ten, then its refusal", async () => {
    const h = setup({ fake: { turns: [fixtureTurn("probe-retry-429")] } });
    const { events, end } = await h.turn();
    const retries = kinds(events, "system_text").map((e) =>
      english((e as { text: LogText }).text),
    );
    // attempt 2..11 in the frames: retries 1..10 of 10.
    expect(retries).toHaveLength(10);
    for (const [i, line] of retries.entries())
      expect(line).toMatch(new RegExp(`\\b${i + 1}\\b.*\\b10\\b`));
    expect(retries[0]).toContain("probe rate limited");
    expect(end?.status).toBe("failed");
    expect(english(end!.error!)).toContain(
      english(providerRefusal("provider", "probe rate limited")),
    );
  });
});

describe("OpenCode 2 permissions", () => {
  it("asks the member, answers once on the session's route, and never sends always (C2)", async () => {
    const h = setup({ fake: { turns: [fixtureTurn("shell-allow")] } });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request")
          void h.transport.approve(event.approvalId, { kind: "allow_once" });
      },
    );
    expect(approvals(events)).toEqual([
      expect.objectContaining({
        approvalId: "per_1709729a3001fxEYGmonee55g9",
        toolName: "shell",
        input: { patterns: ["printf allowed > ev-allow.txt"] },
      }),
    ]);
    expect(h.fake.replies).toEqual([
      {
        session: h.fake.sessionId,
        id: "per_1709729a3001fxEYGmonee55g9",
        body: { decision: "once" },
      },
    ]);
    expect(JSON.stringify(h.fake.requests.map((r) => r.body))).not.toContain(
      "always",
    );
    expect(end?.status).toBe("completed");
  });

  it("ends a turn the member denied as completed, with the declined tool as an error (T3, R1)", async () => {
    const h = setup({ fake: { turns: [fixtureTurn("shell-deny")] } });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request")
          void h.transport.approve(event.approvalId, { kind: "deny" });
      },
    );
    expect(h.fake.replies.map((r) => r.body)).toEqual([{ decision: "reject" }]);
    // OpenCode ends the busy period as interrupted/shutdown. MUTANT: that
    // read as a stop or a failure; 1.18.35 ended this turn completed.
    expect(end?.status).toBe("completed");
    expect(toolResults(events)).toEqual([
      expect.objectContaining({
        toolUseId: toolCalls(events)[0].toolUseId,
        isError: true,
      }),
    ]);
  });

  it("sends the deny's reason, and the turn goes on to its answer", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("probe-reject-with-message")] },
    });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request")
          void h.transport.approve(event.approvalId, {
            kind: "deny",
            reason: "PROBE_POLICY_REASON blocked",
          });
      },
    );
    // MUTANT: the reason dropped, as 1.18.35's transport did.
    expect(h.fake.replies.map((r) => r.body)).toEqual([
      { decision: "reject", message: "PROBE_POLICY_REASON blocked" },
    ]);
    expect(textOf(events)).toBe("RECOVERED_AFTER_TOOL");
    expect(end?.status).toBe("completed");
  });

  it("fails a turn that OpenCode shut down when Isomux rejected nothing", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("text-reasoning", (frames) => {
            const end = terminalIndex(frames);
            return [
              ...frames.slice(0, end),
              {
                ...frames[end],
                type: "session.execution.interrupted",
                data: {
                  sessionID: frames[end].data.sessionID,
                  reason: "shutdown",
                },
              },
            ];
          }),
        ],
      },
    });
    const { end } = await h.turn();
    // MUTANT: every shutdown read as the end of a denied turn.
    expect(end?.status).toBe("failed");
  });

  it("rejects a policy denial with its reason before the member sees it, and the turn goes on", async () => {
    for (const agent of [undefined, "isomux-interactive-bypass"]) {
      const h = setup({
        fake: {
          turns: [
            editedTurn("probe-reject-with-message", (frames) =>
              frames.map((frame) =>
                frame.type === "permission.asked"
                  ? {
                      ...frame,
                      data: { ...frame.data, resources: ["git reset --hard"] },
                    }
                  : frame,
              ),
            ),
          ],
        },
        transport: { agent },
      });
      const { events, end } = await h.turn();
      expect(approvals(events)).toEqual([]);
      expect(h.fake.replies).toHaveLength(1);
      const reply = h.fake.replies[0].body as {
        decision: string;
        message?: string;
      };
      expect(reply.decision).toBe("reject");
      expect(reply.message).toContain("git reset --hard");
      expect(JSON.stringify(kinds(events, "system_text"))).toContain(
        "git reset --hard",
      );
      expect(end?.status).toBe("completed");
      h.transport.close();
      h.fake.restore();
    }
  });

  it("answers an edit request under bypass and asks the member for it otherwise", async () => {
    const bypass = setup({
      fake: { turns: [fixtureTurn("probe-edit-permission")] },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const auto = await bypass.turn();
    expect(bypass.fake.replies.map((r) => r.body)).toEqual([
      { decision: "once" },
    ]);
    expect(approvals(auto.events)).toEqual([]);
    expect(auto.end?.status).toBe("completed");
    bypass.fake.restore();

    const member = setup({
      fake: { turns: [fixtureTurn("probe-edit-permission")] },
    });
    const asked = await member.turn([{ type: "text", text: "go" }], (event) => {
      if (event.kind === "approval_request")
        void member.transport.approve(event.approvalId, { kind: "allow_once" });
    });
    expect(approvals(asked.events)).toEqual([
      expect.objectContaining({
        toolName: "edit",
        input: { patterns: ["b.txt"] },
      }),
    ]);
    expect(asked.end?.status).toBe("completed");
  });

  it("asks for a subagent's request and answers it on the subagent's route", async () => {
    const recorded = loadFixture("probe-subagent-permission");
    const child = recorded.find(
      (f) => f.type === "session.created" && f.data.parentID,
    )!.data.sessionID as string;
    const h = setup({
      fake: { turns: [fixtureTurn("probe-subagent-permission")] },
    });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request")
          void h.transport.approve(event.approvalId, { kind: "allow_once" });
      },
    );
    expect(approvals(events)).toHaveLength(1);
    // MUTANT: the reply under the agent's session, which 2.1.4 answers 404.
    expect(h.fake.replies.map((r) => r.session)).toEqual([child]);
    expect(end?.status).toBe("completed");
  });

  it("goes on after the member denies a subagent's request: only the subagent ends", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("probe-subagent-reject")] },
    });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request")
          void h.transport.approve(event.approvalId, { kind: "deny" });
      },
    );
    // The subagent's execution.interrupted/shutdown comes first. MUTANT: a
    // shutdown after an Isomux reject ends the turn whatever its session.
    expect(textOf(events)).toBe("RECOVERED_AFTER_TOOL");
    expect(end?.status).toBe("completed");
  });

  it("leaves another session's request alone", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn(
            "text-reasoning",
            (frames) => {
              const end = terminalIndex(frames);
              return [
                ...frames.slice(0, end),
                {
                  type: "permission.asked",
                  created: frames[end].created,
                  data: {
                    id: "per_other",
                    sessionID: "ses_other",
                    action: "shell",
                    resources: ["printf other"],
                    source: {
                      type: "tool",
                      messageID: "msg_other",
                      id: "call_1",
                    },
                  },
                },
                frames[end],
              ];
            },
            0,
            { waitForReplies: false },
          ),
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events, end } = await h.turn();
    expect(approvals(events)).toEqual([]);
    expect(h.fake.replies).toEqual([]);
    expect(end?.status).toBe("completed");
  });

  it("fails a request with no id visibly without claiming an allow", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn(
            "shell-allow",
            (frames) =>
              frames.map((frame) =>
                frame.type === "permission.asked"
                  ? { ...frame, data: { ...frame.data, id: undefined } }
                  : frame,
              ),
            0,
            { waitForReplies: false },
          ),
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events, end } = await h.turn();
    expect(h.fake.replies).toEqual([]);
    expect(events).toContainEqual({
      kind: "system_text",
      text: OPENCODE_PERMISSION_ID_WARNING,
    });
    expect(end).toMatchObject({
      status: "failed",
      error: OPENCODE_PERMISSION_ID_WARNING,
    });
  });

  it("answers a request the policy cannot read once under bypass, with the warning", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn("shell-allow", (frames) =>
            frames.map((frame) =>
              frame.type === "permission.asked"
                ? { ...frame, data: { ...frame.data, resources: [] } }
                : frame,
            ),
          ),
        ],
      },
      transport: { agent: "isomux-interactive-bypass" },
    });
    const { events } = await h.turn();
    expect(h.fake.replies.map((r) => r.body)).toEqual([{ decision: "once" }]);
    expect(events).toContainEqual({
      kind: "system_text",
      text: SAFETY_WARNING,
    });
  });

  // Probe of 2026-10-25: a reject closes every open request of its session,
  // with a permission.replied frame for each, and a later reply gets 404.
  function twoOpenRequests() {
    const turn = editedTurn(
      "shell-deny",
      (frames) => {
        const asked = frames.findIndex((f) => f.type === "permission.asked");
        const second = {
          ...frames[asked],
          data: {
            ...frames[asked].data,
            id: "per_second",
            resources: ["printf second"],
            source: { type: "tool", messageID: "msg_x", id: "call_second" },
          },
        };
        return [...frames.slice(0, asked + 1), second];
      },
      0,
      { waitForReplies: false },
    );
    const session = turn.session!;
    return { turn, session };
  }

  it("withdraws the session's other request when the member denies one, and ends the turn as completed", async () => {
    const { turn } = twoOpenRequests();
    const h = setup({ fake: { turns: [turn] } });
    const events: NormalizedEvent[] = [];
    void h.transport.send([{ type: "text", text: "go" }], (e) =>
      events.push(e),
    );
    await until(() => approvals(events).length === 2);
    const [first, second] = approvals(events);
    await h.transport.approve(first.approvalId, { kind: "deny" });
    const sid = h.fake.sessionId;
    h.fake.emit(
      {
        type: "permission.replied",
        created: 2,
        data: { sessionID: sid, requestID: first.approvalId, reply: "reject" },
      },
      {
        type: "permission.replied",
        created: 3,
        data: { sessionID: sid, requestID: second.approvalId, reply: "reject" },
      },
      {
        type: "session.execution.interrupted",
        created: 4,
        data: { sessionID: sid, reason: "shutdown" },
      },
    );
    const ended = () => events.filter((e) => e.kind === "turn_completed");
    await until(() => ended().length > 0);
    expect(events).toContainEqual({
      kind: "approval_withdrawn",
      approvalId: second.approvalId,
    });
    await h.transport.approve(second.approvalId, { kind: "allow_once" });
    expect(h.fake.replies.map((r) => [r.id, r.body])).toEqual([
      [first.approvalId, { decision: "reject" }],
    ]);
    expect(ended()).toMatchObject([{ status: "completed" }]);
  });

  it("takes a 404 for a request another reject already closed as closed", async () => {
    const { turn } = twoOpenRequests();
    const h = setup({
      fake: {
        turns: [turn],
        override: (route, { url }) =>
          route === "reply" && url.pathname.includes("per_second")
            ? Response.json(
                { _tag: "PermissionNotFoundError" },
                { status: 404 },
              )
            : undefined,
      },
    });
    const events: NormalizedEvent[] = [];
    void h.transport.send([{ type: "text", text: "go" }], (e) =>
      events.push(e),
    );
    await until(() => approvals(events).length === 2);
    // The member's Allow lost the race to the other request's reject.
    // MUTANT: the 404 thrown to the member as a failed answer.
    await h.transport.approve("per_second", { kind: "allow_once" });
    expect(
      h.fake.calls("POST", /per_second\/reply$/).map((r) => r.body),
    ).toEqual([{ decision: "once" }]);
  });

  it("withdraws a request that OpenCode closed without a member answer", async () => {
    const h = setup({
      fake: {
        turns: [
          editedTurn(
            "shell-allow",
            (frames) => {
              const asked = frames.findIndex(
                (f) => f.type === "permission.asked",
              );
              return [
                ...frames.slice(0, asked + 1),
                {
                  type: "permission.replied",
                  created: frames[asked].created! + 1,
                  data: {
                    sessionID: frames[asked].data.sessionID,
                    requestID: frames[asked].data.id,
                    reply: "reject",
                  },
                },
                ...frames.slice(asked + 2),
              ];
            },
            0,
            { waitForReplies: false },
          ),
        ],
      },
    });
    const { events } = await h.turn();
    const asked = approvals(events)[0];
    expect(events).toContainEqual({
      kind: "approval_withdrawn",
      approvalId: asked.approvalId,
    });
    // No answer goes out for a closed request.
    await h.transport.approve(asked.approvalId, { kind: "allow_once" });
    expect(h.fake.replies).toEqual([]);
  });

  it("rejects an open request when the member stops the turn, before the interrupt", async () => {
    const h = setup({
      fake: {
        turns: [
          fixtureTurn("shell-deny", 0, {
            waitForReplies: false,
            interruptBefore: (frame) => frame.type === "permission.replied",
          }),
        ],
      },
    });
    const { events, end } = await h.turn(
      [{ type: "text", text: "go" }],
      (event) => {
        if (event.kind === "approval_request") void h.transport.abort();
      },
    );
    expect(h.fake.replies.map((r) => r.body)).toEqual([{ decision: "reject" }]);
    const reply = h.fake.requests.findIndex((r) => r.path.endsWith("/reply"));
    const interrupt = h.fake.requests.findIndex((r) =>
      r.path.endsWith("/interrupt"),
    );
    expect(reply).toBeGreaterThan(-1);
    expect(interrupt).toBeGreaterThan(reply);
    expect(kinds(events, "approval_withdrawn")).toHaveLength(1);
    expect(end?.status).toBe("interrupted");
  });
});

describe("OpenCode 2 failures (T10)", () => {
  it("quotes the provider's refusal for a 4xx other than 401", async () => {
    const h = setup({
      fake: { turns: [fixtureTurn("probe-invalid-request-400")] },
    });
    const { end } = await h.turn();
    expect(end?.status).toBe("failed");
    expect(english(end!.error!)).toContain(
      english(providerRefusal("provider", "probe bad request 500 tokens")),
    );
  });

  it("never reads the provider's response body", async () => {
    const sunk: string[] = [];
    const h = setup({
      fake: {
        turns: [
          failingTurn({
            type: "provider.error",
            message: "provider says no",
            status: 422,
            response: { body: "BODY_SECRET_CANARY" },
          }),
        ],
      },
      transport: { safeErrorSink: (error) => sunk.push(JSON.stringify(error)) },
    });
    const { events } = await h.turn();
    expect(JSON.stringify(events)).not.toContain("BODY_SECRET_CANARY");
    expect(sunk.join("")).not.toContain("BODY_SECRET_CANARY");
  });

  // 2.1.4 sends a 403 as provider.auth (its classifier puts 401 and 403
  // together), with the provider's words as the message (2026-10-25).
  it("quotes the provider's words for a 403 that 2.1.4 sends as provider.auth", async () => {
    const refusal = "Model not allowed for this key.";
    const h = setup({
      fake: {
        turns: [
          failingTurn({ type: "provider.auth", status: 403, message: refusal }),
        ],
      },
    });
    const { events, end } = await h.turn();
    expect(end?.status).toBe("failed");
    expect(english(end!.error!)).toContain(
      english(providerRefusal("provider", refusal)),
    );
    expect(events.filter((e) => e.kind === "auth_needed")).toHaveLength(0);
  });

  it("keeps the model line for a 403 with no provider words, and offers the picker", async () => {
    const h = setup({
      // 2.1.4 sends a 403 as provider.auth.
      fake: { turns: [failingTurn({ type: "provider.auth", status: 403 })] },
    });
    const { end } = await h.turn();
    expect(end).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: openCodeModelUnavailableFailure("provider/model"),
      pickModel: true,
      modelUnavailable: true,
    });
  });

  it("names a model OpenCode cannot route as gone when its provider is enabled", async () => {
    const h = setup({
      fake: {
        turns: [
          failingTurn({
            type: "provider.no-route",
            message: "Model unavailable: provider/model",
          }),
        ],
      },
    });
    const { end } = await h.turn();
    expect(end).toMatchObject({
      status: "failed",
      pickModel: true,
      goneModel: "provider/model",
      modelUnavailable: true,
    });
    expect(english(end!.error!)).toContain(
      english(openCodeModelGoneFailure("provider/model")),
    );
  });

  it("offers the picker, not a gone model, when the provider is not connected", async () => {
    const h = setup({
      fake: {
        providers: () => [{ id: "other", activation: "enabled" }],
        turns: [
          failingTurn({
            type: "provider.no-route",
            message: "Model unavailable: provider/model",
          }),
        ],
      },
    });
    const { end } = await h.turn();
    expect(end).toMatchObject({ status: "failed", pickModel: true });
    expect(end?.goneModel).toBeUndefined();
    // Another model of a provider that is not connected fixes nothing.
    expect(end?.modelUnavailable).toBeUndefined();
  });

  // Task 0387b8de: the provider refuses one free model that its catalog
  // still lists. Another model of the same provider can serve the turn; a
  // free usage limit is per server and refuses every model alike.
  describe("a model the provider will not serve now", () => {
    const refused = (type: string, status: number, message: string) =>
      setup({
        fake: { turns: [failingTurn({ type, status, message })] },
        transport: { model: "opencode/withdrawn-free" },
      });

    it("marks the provider's 'Model is unavailable' refusal, and still quotes it", async () => {
      // The words @opencode/cli 2.1.4 sent for nemotron-3-ultra-free
      // (2026-10-26), in another case too.
      for (const message of [
        "Upstream request failed: Model is unavailable.",
        "model is UNAVAILABLE",
      ]) {
        const { end } = await refused(
          "provider.invalid-request",
          400,
          message,
        ).turn();
        expect({
          message,
          status: end?.status,
          flag: end?.modelUnavailable,
        }).toEqual({ message, status: "failed", flag: true });
        expect(english(end!.error!)).toContain(
          english(providerRefusal("opencode", message)),
        );
      }
    });

    it("does not mark a free usage limit or another refusal", async () => {
      for (const [type, status, message] of [
        ["provider.free-limit", 429, "Free usage limit reached"],
        ["provider.invalid-request", 400, "probe bad request 500 tokens"],
        ["provider.rate-limit", 429, "Too many requests"],
      ] as const) {
        const { end } = await refused(type, status, message).turn();
        expect({
          type,
          status: end?.status,
          flag: end?.modelUnavailable,
        }).toEqual({ type, status: "failed", flag: undefined });
      }
    });
  });

  it("waits for a provider list that is still empty instead of reading it as a provider that is not connected (R4)", async () => {
    let reads = 0;
    const h = setup({
      fake: {
        // 2.1.4 lists no provider for its first seconds.
        providers: () =>
          ++reads === 1 ? [] : [{ id: "provider", activation: "enabled" }],
        turns: [
          failingTurn({
            type: "provider.no-route",
            message: "Model unavailable: provider/model",
          }),
        ],
      },
    });
    const { end } = await h.turn();
    // MUTANT: the empty list read as "not connected" offers the picker
    // without the gone model.
    expect(end).toMatchObject({
      status: "failed",
      pickModel: true,
      goneModel: "provider/model",
    });
    expect(reads).toBe(2);
  });

  // Task 10a09ec8: the sign-in line and its OPENCODE_API_KEY guidance only
  // when that key would fix the failure: a model of OpenCode's own providers
  // that is not free, on a server started without the key.
  describe("sign-in failures", () => {
    const models = () => [
      modelRow("opencode", "free-model", {
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      }),
      modelRow("opencode", "paid-model"),
      modelRow("opencode-go", "go-model"),
      modelRow("anthropic", "claude"),
    ];
    const invalidKey = "Invalid API key for this request.";
    const auth = (message?: string) =>
      failingTurn({
        type: "provider.auth",
        status: 401,
        ...(message ? { message } : {}),
      });

    async function fail(
      turn: FakeTurn,
      model: string,
      launchVariables: string[] = [],
    ) {
      const h = setup({
        fake: { models, turns: [turn] },
        lease: { launchVariables },
        transport: { model },
      });
      const { events, end } = await h.turn();
      expect(end?.status).toBe("failed");
      return {
        end: end!,
        error: english(end!.error!),
        signIns: events.filter((e) => e.kind === "auth_needed").length,
        signalFirst: events.at(-2)?.kind === "auth_needed",
      };
    }

    it("asks for the key for a paid or unlisted model of OpenCode's providers on a server without it", async () => {
      for (const model of [
        "opencode/paid-model",
        "opencode/unlisted-model",
        "opencode-go/go-model",
      ]) {
        const result = await fail(auth(invalidKey), model);
        expect(result.signIns).toBe(1);
        expect(result.signalFirst).toBe(true);
        expect(result.error).toContain(OPENCODE_AUTH_FAILURE);
        expect(result.error).toContain(invalidKey);
        expect(result.end.pickModel).toBeUndefined();
      }
    });

    it("shows a free model's or another provider's refusal as the provider's, not as missing sign-in", async () => {
      for (const model of ["opencode/free-model", "anthropic/claude"]) {
        const result = await fail(auth(invalidKey), model);
        expect(result.signIns).toBe(0);
        expect(result.error).not.toContain(OPENCODE_AUTH_FAILURE);
        expect(result.error).toContain(
          english(providerRefusal(model.split("/")[0], invalidKey)),
        );
      }
    });

    it("shows the provider's words when the server has the key", async () => {
      const result = await fail(auth(invalidKey), "opencode/paid-model", [
        "OPENCODE_API_KEY",
      ]);
      expect(result.signIns).toBe(0);
      expect(result.error).toContain(invalidKey);
    });

    it("offers the picker for a refusal that needs no key and has no words", async () => {
      const result = await fail(auth(), "anthropic/claude");
      expect(result.signIns).toBe(0);
      expect(result.end.pickModel).toBe(true);
      expect(result.error).toContain("`anthropic/claude`");
    });

    it("classifies the recorded 2.1.4 sign-in failure as authentication", async () => {
      const recorded = fixtureTurn("auth-error");
      const result = await fail(recorded, "opencode/paid-model");
      expect(result.signIns).toBe(1);
      expect(result.error).toContain("invalid gate credential");
    });
  });
});

describe("OpenCode 2 safety plugin check (S2)", () => {
  const ourDir = openCodeSafetyPluginDir(FAKE_PROFILE);

  async function checked(plugins: () => unknown[], advanceBy?: number) {
    const clock = drivenClock();
    const h = setup({
      fake: { plugins, turns: [fixtureTurn("text-reasoning")] },
      transport: {
        eventStreamDeadlineMs: 1_000,
        deadlineScheduler: clock.scheduler,
      },
    });
    const events: NormalizedEvent[] = [];
    void h.transport.send([{ type: "text", text: "go" }], (e) =>
      events.push(e),
    );
    const done = () => events.some((e) => e.kind === "turn_completed");
    await settleUntil(done);
    if (advanceBy !== undefined) {
      for (let at = 0; at < advanceBy && !done(); at += 250) {
        // Heartbeats keep the stream deadline away from the plugin wait.
        h.fake.heartbeat();
        await settleUntil(() => false, 5);
        clock.advance(250);
        await settleUntil(done, 20);
      }
    }
    await until(done, 1_000);
    return {
      h,
      events,
      end: events.find((e) => e.kind === "turn_completed"),
    };
  }

  it("runs the turn when the Isomux plugin is active in the folder", async () => {
    const { h, end } = await checked(() => [
      builtinPluginRow("opencode.agent"),
      ourPluginRow(),
    ]);
    expect(end?.status).toBe("completed");
    expect(
      h.fake
        .calls("GET", /^\/api\/plugin$/)[0]
        .query.get("location[directory]"),
    ).toBe(FAKE_CWD);
  });

  it("refuses at once when another row claims the plugin's id", async () => {
    const { h, end } = await checked(() => [
      ourPluginRow(),
      {
        id: OPENCODE_SAFETY_PLUGIN_ID,
        source: { type: "local", path: "/work/repo/.opencode/plugin/index.js" },
        state: { status: "active" },
      },
    ]);
    // No clock advance: the refusal does not wait for the deadline.
    expect(end).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE,
    });
    expect(h.fake.prompts()).toBe(0);
  });

  it("refuses at once when the plugin failed to load", async () => {
    for (const row of [
      ourPluginRow("failed"),
      // Setup threw: the row names the entry file.
      {
        id: null,
        source: { type: "local", path: join(ourDir, "index.js") },
        state: { status: "failed", error: "Error: setup" },
      },
    ]) {
      const { h, end } = await checked(() => [row]);
      expect(end?.error).toBe(OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE);
      expect(h.fake.prompts()).toBe(0);
      h.transport.close();
      h.fake.restore();
    }
  });

  it("waits while the folder's plugins load, then runs the turn", async () => {
    let polls = 0;
    const { h, end } = await checked(() => {
      polls++;
      return polls < 3 ? [] : [ourPluginRow()];
    }, 1_000);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(end?.status).toBe("completed");
    expect(h.fake.prompts()).toBe(1);
  });

  it("refuses at the deadline when the plugin never appears", async () => {
    for (const rows of [[], [builtinPluginRow("opencode.agent")]]) {
      const { h, end } = await checked(() => rows, 2_000);
      expect(end?.error).toBe(OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE);
      expect(h.fake.prompts()).toBe(0);
      expect(h.fake.count("plugin")).toBeGreaterThan(1);
      h.transport.close();
      h.fake.restore();
    }
  });

  it("checks again before every prompt", async () => {
    let impostor = false;
    const h = setup({
      fake: {
        plugins: () => [
          ourPluginRow(),
          ...(impostor
            ? [
                {
                  id: OPENCODE_SAFETY_PLUGIN_ID,
                  source: { type: "local", path: "/elsewhere/index.js" },
                  state: { status: "active" },
                },
              ]
            : []),
        ],
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
      },
    });
    expect((await h.turn()).end?.status).toBe("completed");
    // A folder reload put a project plugin with the same id in place.
    impostor = true;
    expect((await h.turn()).end?.error).toBe(
      OPENCODE_SAFETY_PLUGIN_MISSING_FAILURE,
    );
    expect(h.fake.prompts()).toBe(1);
  });
});

describe("OpenCode 2 history, fork and delete", () => {
  const user = (id: string, text: string) => ({
    id,
    time: { created: 1 },
    type: "user",
    text,
  });
  const assistant = (id: string, text: string) => ({
    id,
    time: { created: 2, completed: 3 },
    type: "assistant",
    content: [
      { type: "reasoning", text: "PRIVATE_REASONING" },
      { type: "text", text },
      {
        type: "tool",
        id: "call_1",
        name: "shell",
        state: {
          status: "completed",
          content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
        },
      },
    ],
    cost: 0,
  });

  it("reads every page, takes the member's and the model's messages, and drops OpenCode's own items", async () => {
    const items: unknown[] = [
      { id: "m0", time: { created: 0 }, type: "model-switched", model: {} },
      user("u1", "hello one"),
      assistant("a1", "answer one"),
      { id: "i1", time: { created: 4 }, type: "idle", outcome: "succeeded" },
      {
        id: "s1",
        time: { created: 5 },
        type: "system",
        text: "instruction update",
      },
    ];
    // More than one page of 200.
    for (let n = 0; n < 200; n++) items.push(user(`u-${n}`, `text ${n}`));
    items.push(assistant("a-last", "last answer"));
    const h = setup({
      fake: { messages: () => items },
      transport: { sessionId: "ses_history" },
    });
    const messages = await h.transport.getSessionMessages();
    expect(messages.slice(0, 2)).toEqual([
      { uuid: "u1", role: "user", text: "hello one" },
      { uuid: "a1", role: "assistant", text: "answer one" },
    ]);
    expect(messages).toHaveLength(203);
    expect(messages.at(-1)).toEqual({
      uuid: "a-last",
      role: "assistant",
      text: "last answer",
    });
    expect(JSON.stringify(messages)).not.toContain("PRIVATE_");
    const pages = h.fake.calls("GET", /\/message$/);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].query.get("order")).toBe("asc");
    // T7: 2.1.4 refuses a cursor together with an order.
    for (const page of pages.slice(1)) {
      expect(page.query.get("cursor")).not.toBeNull();
      expect(page.query.has("order")).toBe(false);
    }
  });

  it("forks before a message, or the whole session, and returns the new session", async () => {
    const h = setup({ transport: { sessionId: "ses_parent" } });
    expect(await h.transport.forkAtMessage("u2")).toBe("ses_parent_fork");
    expect(await h.transport.forkAtMessage(null)).toBe("ses_parent_fork");
    expect(
      h.fake
        .calls("POST", /^\/api\/session\/ses_parent\/fork$/)
        .map((r) => r.body ?? {}),
    ).toEqual([{ before: "u2" }, {}]);
  });

  it("deletes its session", async () => {
    const h = setup({ transport: { sessionId: "ses_gone" } });
    await h.transport.deleteSession();
    expect(h.fake.calls("DELETE", /^\/api\/session\/ses_gone$/)).toHaveLength(
      1,
    );
  });
});

describe("OpenCode 2 model catalog (E4a)", () => {
  const CANARY = "CATALOG_SECRET_CANARY";

  it("lists the enabled models with their limits, free flag and supported efforts", async () => {
    const fake = fakeOpenCode({
      models: () => [
        modelRow("gate", "gate-model", {
          name: "Gate model",
          settings: { apiKey: CANARY },
          variants: [
            { id: "low", settings: {} },
            { id: "high", settings: {} },
            { id: "none", settings: {} },
            { id: "thinking", settings: {} },
          ],
          limit: { context: 262_144, input: 200_000, output: 65_536 },
        }),
        modelRow("gate", "free", {
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        }),
        modelRow("gate", "no-cost", { cost: [] }),
        modelRow("gate", "tiered", {
          cost: [
            { input: 0, output: 0, cache: { read: 0, write: 0 } },
            { input: 1, output: 2, cache: { read: 0, write: 0 } },
          ],
        }),
        modelRow("gate", "disabled", { enabled: false }),
        modelRow("gate", "deprecated", { status: "deprecated" }),
      ],
    });
    cleanups.push(fake.restore);
    const { supervisor } = fakeSupervisor();
    const models = await discoverOpenCodeModels(supervisor, FAKE_CWD);
    expect(
      fake.calls("GET", /^\/api\/model$/)[0].query.get("location[directory]"),
    ).toBe(FAKE_CWD);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect([...byId.keys()].sort()).toEqual([
      "gate/free",
      "gate/gate-model",
      "gate/no-cost",
      "gate/tiered",
    ]);
    expect(byId.get("gate/gate-model")).toMatchObject({
      contextLimit: 262_144,
      inputLimit: 200_000,
      outputLimit: 65_536,
      supportedEfforts: EFFORT_LEVELS.filter(({ level }) =>
        ["low", "high", "none"].includes(level),
      ).map(({ level }) => ({ level })),
    });
    expect(byId.get("gate/gate-model")!.label).toContain("Gate model");
    expect(byId.get("gate/free")?.isFree).toBe(true);
    expect(byId.get("gate/no-cost")?.isFree).toBeUndefined();
    expect(byId.get("gate/tiered")?.isFree).toBeUndefined();
    expect(JSON.stringify(models)).not.toContain(CANARY);
  });

  it("drops the house-provider prefix from the label and keeps providers apart", async () => {
    const fake = fakeOpenCode({
      models: () => [
        modelRow("opencode", "big-pickle", { name: "Big Pickle" }),
        modelRow("gate", "big-pickle", { name: "Big Pickle" }),
      ],
    });
    cleanups.push(fake.restore);
    const models = await discoverOpenCodeModels(
      fakeSupervisor().supervisor,
      FAKE_CWD,
    );
    const label = (id: string) => models.find((m) => m.id === id)?.label;
    expect(label("opencode/big-pickle")).toBe("Big Pickle");
    expect(label("gate/big-pickle")).toContain("Big Pickle");
    expect(label("gate/big-pickle")).not.toBe("Big Pickle");
  });

  it("keeps no empty or failed load: the next caller loads again", async () => {
    let loads = 0;
    const fake = fakeOpenCode({
      models: () => {
        loads++;
        return loads === 1 ? [] : [modelRow("provider", "model")];
      },
    });
    cleanups.push(fake.restore);
    const lease = fakeSupervisor();
    // An empty list is a server whose catalog has not loaded yet.
    await expectRejection(
      discoverOpenCodeModels(lease.supervisor, FAKE_CWD),
      /./,
    );
    expect(
      (await discoverOpenCodeModels(lease.supervisor, FAKE_CWD)).map(
        (m) => m.id,
      ),
    ).toEqual(["provider/model"]);
    // A kept load serves the next caller.
    await discoverOpenCodeModels(lease.supervisor, FAKE_CWD);
    expect(loads).toBe(2);
    expect(lease.releases()).toBe(3);
  });

  it("releases the discovery lease when the request fails", async () => {
    const fake = fakeOpenCode({ status: { catalog: 500 } });
    cleanups.push(fake.restore);
    const lease = fakeSupervisor();
    await expectRejection(
      discoverOpenCodeModels(lease.supervisor, FAKE_CWD),
      /./,
    );
    expect(lease.releases()).toBe(1);
  });

  it("loads one catalog per server and folder, and loads again after a replacement", async () => {
    let serverKey = "server-1";
    const fake = fakeOpenCode({
      turns: [
        fixtureTurn("text-reasoning"),
        fixtureTurn("text-reasoning"),
        fixtureTurn("text-reasoning"),
      ],
    });
    cleanups.push(fake.restore);
    const lease = fakeSupervisor({ serverKey: () => serverKey });
    const send = async (cwd: string) => {
      const transport = new OpenCodeTransport({
        cwd,
        model: "provider/model",
        effort: "high",
        systemPrompt: "system",
        supervisor: lease.supervisor,
        sessionId: `ses_${cwd.replaceAll("/", "")}`,
      });
      cleanups.push(() => transport.close());
      const events: NormalizedEvent[] = [];
      await transport.send([{ type: "text", text: "go" }], (e) =>
        events.push(e),
      );
      await until(() => events.some((e) => e.kind === "turn_completed"));
    };
    await send("/a");
    await discoverOpenCodeModels(lease.supervisor, "/a");
    await send("/b");
    serverKey = "server-2";
    await send("/a");
    expect(
      fake
        .calls("GET", /^\/api\/model$/)
        .map((r) => r.query.get("location[directory]")),
    ).toEqual(["/a", "/b", "/a"]);
  });

  it("runs a turn at the model's default effort with a notice when the catalog is empty, and loads again next turn", async () => {
    let failures = 1;
    const h = setup({
      fake: {
        turns: [fixtureTurn("text-reasoning"), fixtureTurn("text-reasoning")],
        models: () => (failures-- > 0 ? [] : [modelRow("provider", "model")]),
      },
    });
    const first = await h.turn();
    expect(first.end?.status).toBe("completed");
    expect(kinds(first.events, "system_text")).toEqual([
      { kind: "system_text", text: OPENCODE_EFFORT_CATALOG_UNAVAILABLE },
    ]);
    expect(h.fake.calls("POST", /\/model$/)[0].body).toEqual({
      model: { providerID: "provider", id: "model" },
    });
    const second = await h.turn();
    expect(kinds(second.events, "system_text")).toEqual([]);
    expect(h.fake.calls("POST", /\/model$/)[1].body).toEqual({
      model: { providerID: "provider", id: "model", variant: "high" },
    });
  });
});
