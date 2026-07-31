// Standalone smoke test for the V1 SDK adapter.
//
// Exercises `realV1SdkClient` against the real Claude Code subprocess without
// going through the isomux orchestrator. Run before restarting the office to
// validate the migration path.
//
// Usage:  bun run scripts/v1-smoke.ts
//
// Costs: each `query()` spawns Claude Code, which counts against the user's
// subscription. Tests use Haiku + short prompts to keep this minimal.

import { realV1SdkClient } from "../server/backends/claude";
import { CLAUDE_NATIVE_BIN } from "../server/cwd-utils";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type TestResult = { name: string; ok: boolean; detail: string };
const results: TestResult[] = [];

function pass(name: string, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` - ${detail}` : ""}`);
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`✗ ${name} - ${detail}`);
}

function baseOpts() {
  return {
    model: "claude-haiku-4-5-20251001",
    pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    // Typed options, mirroring buildSdkOpts: the prompt travels over stdin
    // (initialize control request), never argv (task e6a0387a).
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "You answer in <=5 words.",
    } as const,
    effort: "low" as const,
    cwd: "/tmp",
    permissionMode: "default" as const,
    disallowedTools: ["AskUserQuestion"],
  };
}

async function drainUntilResult(
  it: AsyncIterable<SDKMessage>,
  timeoutMs = 60_000,
): Promise<{ result: SDKMessage | null; assistant: string[] }> {
  const assistant: string[] = [];
  let result: SDKMessage | null = null;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`drain timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );
  await Promise.race([
    (async () => {
      for await (const msg of it) {
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) {
            if (b.type === "text" && typeof b.text === "string") {
              assistant.push(b.text);
            }
          }
        }
        if (msg.type === "result") {
          result = msg;
          break;
        }
      }
    })(),
    timeout,
  ]);
  return { result, assistant };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

// ---------- Test 1: single-turn createSession + messages + send ----------

async function test1_singleTurn() {
  const name = "single-turn session: send → assistant_text → result(success)";
  try {
    const conv = realV1SdkClient.createSession(baseOpts());
    const messagesPromise = drainUntilResult(conv.messages());
    await conv.send(userMessage("Say only OK"));
    const { result, assistant } = await messagesPromise;
    conv.close();
    if (!result) {
      fail(name, "no result message");
      return;
    }
    if (result.type !== "result") {
      fail(name, `unexpected last message type: ${result.type}`);
      return;
    }
    const r = result as { subtype: string; result?: string };
    if (r.subtype !== "success") {
      fail(name, `result subtype: ${r.subtype}`);
      return;
    }
    const text = assistant.join("").trim() || (r.result ?? "").trim();
    if (!text) {
      fail(name, "empty assistant + empty result.result");
      return;
    }
    pass(name, `assistant="${text.slice(0, 40)}"`);
  } catch (err) {
    fail(name, (err as Error).message);
  }
}

// ---------- Test 2: multi-turn (two sends, single Query) ----------

async function test2_multiTurn() {
  const name = "multi-turn: two sends on same conversation, context preserved";
  try {
    const conv = realV1SdkClient.createSession(baseOpts());
    const it = conv.messages()[Symbol.asyncIterator]();

    // Turn 1
    await conv.send(userMessage("Remember the number 42. Then say READY."));
    let result1Found = false;
    while (!result1Found) {
      const r = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("turn 1 timeout")), 60_000),
        ),
      ]);
      if (r.done) {
        fail(name, "stream ended before turn 1 result");
        return;
      }
      if (r.value.type === "result") result1Found = true;
    }

    // Turn 2: ask back. If context was preserved we should see "42".
    await conv.send(
      userMessage("What number did I tell you? Reply with just the number."),
    );
    const replies: string[] = [];
    let result2 = null as null | { subtype: string };
    while (!result2) {
      const r = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("turn 2 timeout")), 60_000),
        ),
      ]);
      if (r.done) {
        fail(name, "stream ended before turn 2 result");
        return;
      }
      const msg = r.value;
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const b of msg.message.content) {
          if (b.type === "text" && typeof b.text === "string")
            replies.push(b.text);
        }
      }
      if (msg.type === "result") {
        result2 = msg as { subtype: string };
      }
    }
    conv.close();
    if (result2.subtype !== "success") {
      fail(name, `turn 2 result subtype: ${result2.subtype}`);
      return;
    }
    const reply = replies.join("").trim();
    if (!reply.includes("42")) {
      fail(name, `turn 2 reply lacked '42': "${reply.slice(0, 60)}"`);
      return;
    }
    pass(name, `turn 2 reply="${reply.slice(0, 40)}"`);
  } catch (err) {
    fail(name, (err as Error).message);
  }
}

// ---------- Test 3: oneShotPrompt (used for topic generation) ----------

async function test3_oneShotPrompt() {
  const name = "oneShotPrompt: returns non-empty text on success";
  try {
    const text = await realV1SdkClient.oneShotPrompt({
      prompt: "Summarize 'fix login bug' in exactly 3 words.",
      model: "claude-haiku-4-5-20251001",
      pathToClaudeCodeExecutable: CLAUDE_NATIVE_BIN,
    });
    if (!text || text.length === 0) {
      fail(name, "empty result");
      return;
    }
    pass(name, `result="${text.slice(0, 40)}"`);
  } catch (err) {
    fail(name, (err as Error).message);
  }
}

// ---------- Test 4: close() during active session is safe ----------

async function test4_closeDuringActive() {
  const name =
    "close() mid-conversation: close() is sync-safe, iterator terminates";
  // Two invariants:
  //   1. close() itself must not throw synchronously
  //   2. The iterator must terminate (done OR throw - production swallows the
  //      throw via `if (!this.closed)` in feedSDKMessages). Hang would be bad.
  try {
    const conv = realV1SdkClient.createSession(baseOpts());
    const it = conv.messages()[Symbol.asyncIterator]();
    void conv.send(userMessage("Count slowly to 50"));
    await new Promise((r) => setTimeout(r, 200));
    // Invariant 1
    try {
      conv.close();
    } catch (err) {
      fail(name, `close() threw synchronously: ${(err as Error).message}`);
      return;
    }
    // Invariant 2: drain (accept done OR thrown error)
    let terminated: "done" | "throw" | null = null;
    let safety = 0;
    while (safety++ < 200 && terminated === null) {
      try {
        const r = await Promise.race([
          it.next(),
          new Promise<{ done: true }>((res) =>
            setTimeout(() => res({ done: true } as { done: true }), 5_000),
          ),
        ]);
        if (r.done) terminated = "done";
      } catch {
        terminated = "throw";
      }
    }
    if (terminated === null) {
      fail(name, "iterator did not terminate after close()");
      return;
    }
    pass(name, `iterator terminated via ${terminated}`);
  } catch (err) {
    fail(name, (err as Error).message);
  }
}

// ---------- Run ----------

console.log("V1 SDK adapter smoke test\n");
await test1_singleTurn();
await test2_multiTurn();
await test3_oneShotPrompt();
await test4_closeDuringActive();

const failed = results.filter((r) => !r.ok);
console.log(
  "\n" + (failed.length === 0 ? "ALL PASSED" : `${failed.length} FAILED`),
);
process.exit(failed.length === 0 ? 0 : 1);
