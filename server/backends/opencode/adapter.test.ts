import { describe, expect, it } from "bun:test";
import { getBackend } from "../index.ts";
import type { CreateSessionOptions, NormalizedEvent } from "../types.ts";
import { createOpenCodeTracerBackend } from "./adapter.ts";

const opts: CreateSessionOptions = {
  agentId: "agent-opencode-tracer",
  cwd: "/tmp",
  systemPrompt: "test",
  modelFamily: "opencode/fake",
  effort: "high",
  permissionMode: "default",
};

async function collect(
  stream: AsyncIterable<NormalizedEvent>,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenCode Slice 1A tracer", () => {
  it("is registered with only the capabilities this tracer proves", () => {
    const backend = getBackend("opencode");
    expect(backend.capabilities).toEqual({
      fork: false,
      hooks: false,
      skills: false,
      oneShot: false,
      canUseTool: false,
      topicGen: false,
      edit: false,
      mcp: false,
    });
    expect(backend.inspectStoredSession("stored", opts)).toBe("durable");
  });

  it("emits one deterministic reply through the normalized event contract", async () => {
    const backend = createOpenCodeTracerBackend();
    const session = backend.createSession(opts);
    await session.send("hello");
    session.close();
    expect(await collect(session.stream())).toEqual([
      {
        kind: "system_init",
        sessionId: "opencode-tracer-1",
        model: "opencode/fake",
      },
      { kind: "assistant_text", text: "OpenCode tracer reply." },
      { kind: "turn_completed", status: "completed" },
    ]);
  });

  it("reports missing auth as plain text with no runnable command", async () => {
    const backend = createOpenCodeTracerBackend({ failAuth: true });
    const session = backend.createSession(opts);
    await session.send("hello");
    session.close();
    const events = await collect(session.stream());
    expect(events.at(-1)).toEqual({
      kind: "turn_completed",
      status: "failed",
      error: "OpenCode authentication is not configured.",
    });
    expect(backend.getLoginInstructions()).toEqual({
      text: "OpenCode is not configured. Login instructions are not available in this slice.",
    });
  });
});
