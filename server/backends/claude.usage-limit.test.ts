// Usage-limit stops on Claude, for the resume after the reset
// (server/limit-resume.ts). Driven through ClaudeSession, so the test also
// pins where the stop event lands in the session's stream.
//
// Fixture sources:
// - LIMIT_TEXT is a real limit message from an isomux conversation log
//   (~/.isomux/logs/agent-1774982211503-c244/3c59f1e7-f0c7-436a-bbb2-abe0a1e71515.jsonl,
//   2026-07-11). isomux logs keep only its text; error "rate_limit" and
//   model "<synthetic>" are how the CLI bundled with SDK 0.3.293 sends it
//   (SDKAssistantMessage.error).
// - rateLimitEvent() is a real rate_limit_event, captured 2026-10-18 from a
//   one-shot SDK query on the office account. Its status was "allowed"; the
//   tests set the status they need, and only the status.
import { describe, expect, it } from "bun:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type SdkClient, type SdkConversation } from "./claude";
import type { NormalizedEvent } from "./types";

const LIMIT_TEXT =
  "You've hit your limit · resets Jul 11, 5pm (America/Los_Angeles)";
const RESETS_AT = 1792361400;

function rateLimitEvent(status: "allowed" | "rejected", resetsAt = RESETS_AT) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: 1792361400 },
        seven_day: { utilization: 0.11, resetsAt: 1792886400 },
      },
    },
    uuid: "979fd73c-dfee-4123-a6b2-051644707b6a",
    session_id: "s-1",
  };
}

function limitMessage(parentToolUseId: string | null = null) {
  return {
    type: "assistant",
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: LIMIT_TEXT }],
    },
    parent_tool_use_id: parentToolUseId,
    error: "rate_limit",
    uuid: "u-limit",
    session_id: "s-1",
  };
}

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: LIMIT_TEXT,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  total_cost_usd: 0,
};

class Conversation implements SdkConversation {
  private queue: SDKMessage[] = [];
  private waiter: (() => void) | null = null;
  private done = false;
  async *messages(): AsyncIterable<SDKMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
  send(_msg: string | SDKUserMessage): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.done = true;
    this.wake();
  }
  getContextUsage() {
    return Promise.resolve(null);
  }
  getSubscriptionUsage() {
    return Promise.resolve({ kind: "unknown" as const });
  }
  setPermissionMode(): Promise<void> {
    return Promise.resolve();
  }
  emit(msg: unknown) {
    this.queue.push(msg as SDKMessage);
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}

function makeSession() {
  let conv: Conversation | null = null;
  const client: SdkClient = {
    createSession: () => (conv = new Conversation()),
    resumeSession: () => (conv = new Conversation()),
    oneShotPrompt: () => Promise.resolve(""),
    forkSession: () => Promise.resolve({ sessionId: "f" }),
    getSessionMessages: () => Promise.resolve([]),
  };
  const session = new ClaudeSession("agent-x", client, {
    model: "claude-opus-4-8",
    pathToClaudeCodeExecutable: "/bin/echo",
    cwd: "/tmp",
    permissionMode: "default",
  });
  const events = session.stream()[Symbol.asyncIterator]();
  // The events up to and including the next turn_completed.
  async function turn(msgs: unknown[]): Promise<NormalizedEvent[]> {
    for (const m of msgs) conv!.emit(m);
    const out: NormalizedEvent[] = [];
    for (;;) {
      const r = await events.next();
      if (r.done) return out;
      out.push(r.value);
      if (r.value.kind === "turn_completed") return out;
    }
  }
  return { turn, close: () => session.close() };
}

const kinds = (evs: NormalizedEvent[]) => evs.map((e) => e.kind);
const stops = (evs: NormalizedEvent[]) =>
  evs.filter((e) => e.kind === "usage_limit_stop");

describe("Claude usage-limit stop", () => {
  it("a rejected limit and the limit message report the reset, ahead of the turn's end", async () => {
    const s = makeSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("rejected"),
        limitMessage(),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([
        { kind: "usage_limit_stop", resetsAtMs: RESETS_AT * 1000 },
      ]);
      // The message still reaches the chat, and the stop comes right before
      // the turn ends.
      expect(evs).toContainEqual({ kind: "system_text", text: LIMIT_TEXT });
      expect(kinds(evs).slice(-2)).toEqual([
        "usage_limit_stop",
        "turn_completed",
      ]);
    } finally {
      s.close();
    }
  });

  it("does not depend on the order of the event and the message", async () => {
    const s = makeSession();
    try {
      const evs = await s.turn([
        limitMessage(),
        rateLimitEvent("rejected"),
        RESULT,
      ]);
      expect(stops(evs)).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("an error rate_limit with the limit allowed is not a usage limit (a plain 429)", async () => {
    const s = makeSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("allowed"),
        limitMessage(),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("a rejected limit with no limit message did not stop the turn", async () => {
    const s = makeSession();
    try {
      const evs = await s.turn([rateLimitEvent("rejected"), RESULT]);
      expect(stops(evs)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("a subagent's limit message alone is not the main thread's stop", async () => {
    const s = makeSession();
    try {
      const evs = await s.turn([
        rateLimitEvent("rejected"),
        limitMessage("toolu_parent"),
        RESULT,
      ]);
      expect(stops(evs)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("an unknown reset time reports no stop", async () => {
    const s = makeSession();
    try {
      const event = rateLimitEvent("rejected") as {
        rate_limit_info: Record<string, unknown>;
      };
      delete event.rate_limit_info.resetsAt;
      const evs = await s.turn([event, limitMessage(), RESULT]);
      expect(stops(evs)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("keeps the session's latest info: a later stop with no new event reports it again, and only that turn", async () => {
    const s = makeSession();
    try {
      await s.turn([rateLimitEvent("rejected"), limitMessage(), RESULT]);
      // The CLI emits rate_limit_event only when the info changes.
      expect(stops(await s.turn([limitMessage(), RESULT]))).toEqual([
        { kind: "usage_limit_stop", resetsAtMs: RESETS_AT * 1000 },
      ]);
      // A turn with no limit message reports nothing.
      expect(
        stops(
          await s.turn([
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "ok" }] },
            },
            RESULT,
          ]),
        ),
      ).toEqual([]);
    } finally {
      s.close();
    }
  });
});
