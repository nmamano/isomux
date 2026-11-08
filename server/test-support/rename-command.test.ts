// /rename over the real command path (task 3ffe7841). With text it sets the
// session topic; bare, it labels the conversation again, or says there is
// nothing to label yet. The topic labeller reads only real user messages,
// never the echo of a slash command.
import { afterEach, describe, expect, it } from "bun:test";
import { autocompleteCommands } from "../../shared/commands.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type {
  AgentBackendType,
  LogEntry,
  RoomWire,
} from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import type { AgentEvent } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";
import { listAgentSessions } from "../persistence.ts";
import { buildSummaryPrompt } from "../session-summary.ts";
import { FakeBackend } from "./fake-backend.ts";

const USER = "Morgan";
// The conversation summary shares the one-shot backend with the topic; its
// calls are told apart by their system prompt and not counted.
const SUMMARY_SYSTEM_PROMPT = buildSummaryPrompt(null, []).systemPrompt;

const fakes: FakeBackend[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
});

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

// Each topic one-shot takes the next reply in order. The prompt of every
// topic call is kept.
async function setup(replies: (() => string | Promise<string>)[]) {
  const prompts: string[] = [];
  let answered = 0;
  const fake = new FakeBackend({
    oneShot: async (prompt, opts) => {
      if (opts.systemPrompt === SUMMARY_SYSTEM_PROMPT)
        return "Summary paragraph";
      const reply = replies[prompts.length];
      prompts.push(prompt);
      try {
        if (!reply) throw new Error("unexpected topic call");
        return await reply();
      } finally {
        answered++;
      }
    },
    session: {
      onSend: (_text, _attachments, session) =>
        session.completeTurn({ text: "ok" }),
    },
  });
  fakes.push(fake);
  const roomId = `rename-${crypto.randomUUID()}`;
  const room: RoomWire = {
    id: roomId,
    name: roomId,
    prompt: null,
    canCloseWhenEmpty: true,
  };
  const officeState = new OfficeState({ rooms: [room] });
  const events: AgentEvent[] = [];
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState,
    initialRooms: [],
    findUser: () => ({ id: "user-a", role: "member" }),
    eventSink: (event) => events.push(event),
  });
  mgr.configureAgentTurnDeps();
  const agent = await mgr.spawn(
    "A",
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    USER,
    // An engine whose sign-in check passes in a test home (as in
    // topic-backoff.di.test.ts), so the labeller runs.
    "opencode",
    undefined,
    "user-a",
  );
  if (!agent) throw new Error("spawn returned null");
  const agentId = agent.id;
  const topic = () => mgr.getAgent(agentId)?.topic;
  const generating = () =>
    officeState.getAgent(agentId)?.topicState === "generating";
  // Every topic call so far has its reply, and the flag is down.
  const idle = () =>
    waitFor(
      () => answered === prompts.length && generating() !== true,
      "topic generation settles",
    );
  const stored = () => {
    const sessionId = mgr.getCurrentSessionId(agentId);
    return listAgentSessions(agentId).find((s) => s.sessionId === sessionId)
      ?.topic;
  };
  const logs = (): LogEntry[] => mgr.getAgentLogs(agentId);
  // The catalog keys of the system lines, in order.
  const systemKeys = () =>
    logs()
      .filter((e) => e.kind === "system")
      .flatMap((e) =>
        (e.message ?? []).flatMap((p) => (typeof p === "string" ? [] : p.key)),
      );
  // Whether a generation set the topic state to "generating" after event `from`.
  const generationStartedSince = (from: number) =>
    events
      .slice(from)
      .some(
        (e) =>
          e.type === "agent_updated" &&
          e.agentId === agentId &&
          e.changes.topicState === "generating",
      );
  const send = (text: string) => mgr.sendMessage(agentId, text, USER);
  return {
    mgr,
    agentId,
    prompts,
    events,
    topic,
    generating,
    idle,
    stored,
    logs,
    systemKeys,
    generationStartedSince,
    send,
  };
}

describe("/rename", () => {
  it("/rename <text> sets the topic, saves it for /resume, and wins over a generation in flight", async () => {
    const late = Promise.withResolvers<string>();
    const h = await setup([() => late.promise]);
    // The first message starts a generation, held open by `late`.
    await h.send("fix the login page");
    await waitFor(() => h.prompts.length === 1, "first topic call");
    expect(h.generating()).toBe(true);

    await h.send("/rename   Login   page\n  fix ");
    expect(h.topic()).toBe("Login page fix");
    expect(h.stored()).toBe("Login page fix");
    expect(h.generating()).toBe(false);
    expect(h.systemKeys()).toContain("commands.rename.done");
    // The command line is not kept in the conversation.
    const echo = h.logs().find((e) => e.content.startsWith("/rename"));
    expect(echo?.ephemeral).toBe(true);

    // The dropped generation's late label does not replace the typed one.
    late.resolve("Late label");
    await h.idle();
    expect(h.topic()).toBe("Login page fix");
    expect(h.stored()).toBe("Login page fix");
  });

  it("a typed topic is one line", async () => {
    const h = await setup([() => "Generated label"]);
    await h.send("hello");
    await h.idle();
    // The PUT /api/agents/:id/topic path.
    h.mgr.setTopic(h.agentId, "  two\n\tlines  ");
    expect(h.topic()).toBe("two lines");
    expect(h.stored()).toBe("two lines");
  });

  it("bare /rename labels the conversation again from real user messages only", async () => {
    const h = await setup([() => "First label", () => "Second label"]);
    await h.send("fix the login page");
    await h.idle();
    expect(h.topic()).toBe("First label");
    // An unsupported command leaves an echo in the chat.
    await h.send("/compact");

    const from = h.events.length;
    await h.send("/rename");
    await waitFor(() => h.prompts.length === 2, "second topic call");
    await h.idle();
    expect(h.generationStartedSince(from)).toBe(true);
    expect(h.topic()).toBe("Second label");
    expect(h.systemKeys()).toContain("commands.rename.generating");

    // The chat holds both echoes as user messages; the labeller sees neither.
    const echoes = h
      .logs()
      .filter((e) => e.kind === "user_message" && e.ephemeral)
      .map((e) => e.content);
    expect(echoes).toEqual(["/compact", "/rename"]);
    expect(h.prompts[1]).toContain("fix the login page");
    expect(h.prompts[1]).not.toContain("/compact");
    expect(h.prompts[1]).not.toContain("/rename");
  });

  it("bare /rename with only command echoes in the chat starts no generation", async () => {
    const h = await setup([]);
    await h.send("/compact");
    // The enabling condition: the chat holds a user_message, an echo.
    expect(h.logs().some((e) => e.kind === "user_message" && e.ephemeral)).toBe(
      true,
    );

    const from = h.events.length;
    await h.send("/rename");
    expect(h.systemKeys()).toContain("commands.rename.noContext");
    expect(h.systemKeys()).not.toContain("commands.rename.generating");
    expect(h.generationStartedSince(from)).toBe(false);
    expect(h.prompts).toEqual([]);
    expect(h.topic()).toBeNull();
  });

  it("is offered in autocomplete on every engine, as a command that waits for its text", () => {
    const engines: AgentBackendType[] = ["claude", "codex", "opencode"];
    for (const engine of engines)
      expect(
        autocompleteCommands(engine).filter((c) => c.name === "rename"),
      ).toEqual([{ name: "rename" }]);
  });
});
