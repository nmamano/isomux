// Refused cards of the OpenCode transport (task fcfffe51): the safety
// plugin reports each refusal as an RPC event frame before the call's
// session.tool.failed (the order: opencode-access.live.test.ts), and the
// transport shows the refused card between the call and its result. The
// frames here are shell-allow's call, refused: no permission ask, no shell,
// a failed result.
import { afterEach, describe, expect, it } from "bun:test";
import { OpenCodeTransport } from "./transport.ts";
import {
  FAKE_CWD,
  fakeOpenCode,
  fakeSupervisor,
  fixtureTurn,
  loadFixture,
  type FakeTurn,
  type Frame,
} from "./fake-opencode-v2.ts";
import { OPENCODE_DENIAL_FRAME } from "./safety-plugin-tool.ts";
import type { NormalizedEvent } from "../types.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// One turn of `turn` on a fresh transport: its tool events, in order.
async function toolEvents(turn: FakeTurn): Promise<NormalizedEvent[]> {
  return (await turnEvents(turn)).filter(
    (e) =>
      e.kind === "tool_call" ||
      e.kind === "permission_denied" ||
      e.kind === "tool_result",
  );
}

// One turn of `turn` on a fresh transport: all its events, in order.
async function turnEvents(turn: FakeTurn): Promise<NormalizedEvent[]> {
  const fake = fakeOpenCode({ turns: [turn] });
  cleanups.push(fake.restore);
  const lease = fakeSupervisor();
  const transport = new OpenCodeTransport({
    cwd: FAKE_CWD,
    model: "provider/model",
    effort: "high",
    systemPrompt: "system",
    supervisor: lease.supervisor,
    agent: "isomux-interactive-bypass",
  });
  cleanups.push(() => transport.close());
  const events: NormalizedEvent[] = [];
  await transport.send([{ type: "text", text: "go" }], (event) =>
    events.push(event),
  );
  const deadline = Date.now() + 3_000;
  while (
    !events.some((e) => e.kind === "turn_completed") &&
    Date.now() < deadline
  )
    await Bun.sleep(2);
  expect(events.find((e) => e.kind === "turn_completed")).toMatchObject({
    status: "completed",
  });
  return events;
}

describe("OpenCode 2 refused cards", () => {
  const REASON =
    "BLOCKED by Isomux safety hooks\n\nReason: Force push can destroy remote history.\n\nCommand: git push --force";
  // `denial`: the plugin's frame for the call, given the call's frame data;
  // null for none.
  function refusedTurn(
    denial: ((call: Record<string, unknown>) => Frame | null) | null,
  ): FakeTurn {
    const recorded = fixtureTurn("shell-allow");
    return { ...recorded, frames: edit(recorded.frames) };
    function edit(frames: Frame[]): Frame[] {
      const out: Frame[] = [];
      for (const frame of frames) {
        if (
          frame.type.startsWith("permission.") ||
          frame.type === "session.tool.progress"
        )
          continue;
        if (frame.type !== "session.tool.success") {
          out.push(frame);
          continue;
        }
        const report = denial?.(frame.data);
        if (report) out.push(report);
        out.push({
          ...frame,
          type: "session.tool.failed",
          data: {
            sessionID: frame.data.sessionID,
            assistantMessageID: frame.data.assistantMessageID,
            id: frame.data.id,
            error: { type: "unknown", message: REASON },
            executed: false,
          },
        });
      }
      return out;
    }
  }
  const ours =
    (more: Record<string, unknown> = {}) =>
    (call: Record<string, unknown>): Frame => ({
      type: OPENCODE_DENIAL_FRAME,
      created: 1792890317263,
      data: {
        sessionID: call.sessionID,
        messageID: call.assistantMessageID,
        id: call.id,
        reason: REASON,
        ...more,
      },
    });
  const run = toolEvents;

  it("shows the refused card between the call and its result", async () => {
    const shown = await run(refusedTurn(ours()));
    // MUTANT: the denial frame is dropped (another session's, or not an
    // OpenCode shape), or its card goes after the result.
    expect(shown.map((ev) => ev.kind)).toEqual([
      "tool_call",
      "permission_denied",
      "tool_result",
    ]);
    const [call, card, result] = shown;
    expect(call).toMatchObject({
      name: "shell",
      input: { command: "printf allowed > ev-allow.txt" },
    });
    const id = (call as { toolUseId: string }).toolUseId;
    expect(card).toEqual({
      kind: "permission_denied",
      toolUseId: id,
      toolName: "shell",
      message: REASON.replace(/\s+/g, " ").trim(),
      decisionReason: "Force push can destroy remote history.",
    });
    expect(result).toMatchObject({
      toolUseId: id,
      content: REASON,
      isError: true,
    });
  });

  // A2: the frame proves the refusal of that call and gives the reason; the
  // tool's name is the call's own.
  it("names the tool the call has, not the one the frame says", async () => {
    const shown = await run(refusedTurn(ours({ toolName: "read" })));
    expect(shown[1]).toMatchObject({
      kind: "permission_denied",
      toolName: "shell",
    });
  });

  // No text matching: a failed call with no denial frame has no card,
  // whatever its result says.
  it("shows no card for a failed call the plugin did not report", async () => {
    const shown = await run(refusedTurn(null));
    expect(shown.map((ev) => ev.kind)).toEqual(["tool_call", "tool_result"]);
    expect(shown[1]).toMatchObject({ content: REASON, isError: true });
  });

  it("shows no card for a report of another session or another call", async () => {
    for (const [label, more] of [
      ["another session", { sessionID: "ses_someone_else" }],
      ["another call", { id: "call_other" }],
      ["another message", { messageID: "msg_other" }],
    ] as const) {
      const shown = await run(refusedTurn(ours(more)));
      expect({ label, kinds: shown.map((ev) => ev.kind) }).toEqual({
        label,
        kinds: ["tool_call", "tool_result"],
      });
    }
  });
});

// The other way in: OpenCode asks permission for a call, and the policy
// refuses it at the ask (handleOpenCodePermission). The agent's own call
// gets its card (transport.test.ts, "rejects a policy denial"). A
// subagent's call has no card in the chat, so its refusal stays a system
// line.
describe("OpenCode 2 refusals at the ask", () => {
  it("keeps a subagent's refusal as a system line", async () => {
    const recorded = fixtureTurn("probe-subagent-permission");
    const child = loadFixture("probe-subagent-permission").find(
      (f) => f.type === "session.created" && f.data.parentID,
    )!.data.sessionID;
    const asked = recorded.frames.find(
      (f) => f.type === "permission.asked" && f.data.sessionID === child,
    );
    // The condition: the ask is the child's, with a tool source.
    expect(asked?.data.source).toMatchObject({ type: "tool" });
    const events = await turnEvents({
      ...recorded,
      frames: recorded.frames.map((frame) =>
        frame === asked
          ? {
              ...frame,
              data: { ...frame.data, resources: ["git reset --hard"] },
            }
          : frame,
      ),
    });
    expect(
      events.filter(
        (e) =>
          e.kind === "system_text" &&
          JSON.stringify(e.text).includes("git reset --hard"),
      ),
    ).toHaveLength(1);
    expect(events.filter((e) => e.kind === "permission_denied")).toHaveLength(
      0,
    );
  });
});
