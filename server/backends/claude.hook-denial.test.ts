import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClaudeBackend } from "./claude";
import type { NormalizedEvent } from "./types";
import { FakeSdkClient } from "../test-support/fake-sdk-client.ts";

function nextEvent<T extends { kind: string }>(
  it: AsyncIterator<T>,
): Promise<T | undefined> {
  return it.next().then((r) => (r.done ? undefined : r.value));
}

// A refusal of the safety hooks reaches the transcript as a refused card
// (task 0faacc4e): the SDK reports a PreToolUse refusal only as the tool
// result's text, so the session takes it from the hook and yields
// permission_denied before that tool result.
describe("createClaudeBackend - a safety hook refusal as a refused card", () => {
  type HookFn = NonNullable<
    NonNullable<
      FakeSdkClient["createCalls"][number]["opts"]["hooks"]
    >["PreToolUse"]
  >[number]["hooks"][number];
  function open(extra: Record<string, unknown> = {}, cwd = "/tmp") {
    const fake = new FakeSdkClient();
    const session = createClaudeBackend(fake).createSession({
      agentId: "denial-agent",
      cwd,
      systemPrompt: "prompt",
      modelFamily: "haiku",
      effort: "high",
      permissionMode: "bypassPermissions",
      ...extra,
    });
    const conv = fake.conversations.at(-1)!;
    const matchers = fake.createCalls[0].opts.hooks?.PreToolUse ?? [];
    // Every hook whose matcher takes the tool, as Claude runs them.
    const hook = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolUseId: string,
    ): Promise<string | null> => {
      let reason: string | null = null;
      for (const matcher of matchers) {
        if (
          matcher.matcher !== undefined &&
          !new RegExp(`^(?:${matcher.matcher})$`).test(toolName)
        )
          continue;
        for (const fn of matcher.hooks as HookFn[]) {
          const out = await fn(
            {
              hook_event_name: "PreToolUse",
              tool_name: toolName,
              tool_input: toolInput,
              tool_use_id: toolUseId,
              cwd,
            } as unknown as Parameters<HookFn>[0],
            toolUseId,
            { signal: new AbortController().signal },
          );
          const specific = (
            out as {
              hookSpecificOutput?: {
                permissionDecision?: string;
                permissionDecisionReason?: string;
              };
            }
          ).hookSpecificOutput;
          if (specific?.permissionDecision === "deny")
            reason ??= String(specific.permissionDecisionReason);
        }
      }
      return reason;
    };
    const toolResult = (toolUseId: string, text: string) =>
      conv.emit({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: text,
              is_error: true,
            },
          ],
        },
      });
    const events = session.stream()[Symbol.asyncIterator]();
    // The events up to and including the tool result for `toolUseId`.
    const until = async (toolUseId: string) => {
      const seen: NormalizedEvent[] = [];
      for (;;) {
        const ev = await Promise.race([
          nextEvent(events),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
        ]);
        if (ev === "timeout" || ev === undefined)
          throw new Error(`no tool result for ${toolUseId}`);
        seen.push(ev);
        if (
          ev.kind === "tool_result" &&
          (ev as { toolUseId?: string }).toolUseId === toolUseId
        )
          return seen;
      }
    };
    return { conv, hook, toolResult, until };
  }
  const kinds = (events: NormalizedEvent[]) => events.map((e) => e.kind);

  it("yields permission_denied for the refused call, then its tool result", async () => {
    const s = open();
    const reason = await s.hook("Bash", { command: "rm -rf ~" }, "toolu-1");
    expect(reason).not.toBeNull();
    s.toolResult("toolu-1", `PreToolUse:Bash hook error: ${reason}`);
    const events = await s.until("toolu-1");
    expect(kinds(events)).toEqual(["permission_denied", "tool_result"]);
    const denial = events[0] as {
      toolUseId: string;
      toolName: string;
      message: string;
      decisionReason?: string;
    };
    expect(denial.toolUseId).toBe("toolu-1");
    expect(denial.toolName).toBe("Bash");
    // One line each, as the card shows them; the reason is the hook's own.
    expect(denial.message).not.toMatch(/[\r\n]/);
    expect(denial.decisionReason ?? "").not.toMatch(/[\r\n]/);
    expect(denial.decisionReason?.length ?? 0).toBeGreaterThan(0);
    expect(reason).toContain(denial.decisionReason!);
  });

  it("yields nothing extra for an allowed call or for output that reads like a refusal", async () => {
    const s = open();
    expect(await s.hook("Bash", { command: "ls /tmp" }, "toolu-2")).toBeNull();
    s.toolResult(
      "toolu-2",
      "BLOCKED by Isomux safety hooks\n\nReason: printed by the command",
    );
    expect(kinds(await s.until("toolu-2"))).toEqual(["tool_result"]);
  });

  it("shows one card when the SDK reports the same refusal too", async () => {
    const s = open();
    const reason = await s.hook("Bash", { command: "rm -rf ~" }, "toolu-3");
    s.conv.emit({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: "toolu-3",
      message: "Permission to use Bash has been denied.",
      uuid: "u-3",
      session_id: "s-1",
    });
    s.toolResult("toolu-3", `PreToolUse:Bash hook error: ${reason}`);
    const events = await s.until("toolu-3");
    expect(kinds(events).filter((k) => k === "permission_denied").length).toBe(
      1,
    );
  });

  it("keeps each refusal to its own call", async () => {
    const s = open();
    await s.hook("Bash", { command: "rm -rf ~" }, "toolu-4");
    expect(await s.hook("Bash", { command: "ls" }, "toolu-5")).toBeNull();
    s.toolResult("toolu-5", "ok");
    expect(kinds(await s.until("toolu-5"))).toEqual(["tool_result"]);
    s.toolResult("toolu-4", "refused");
    expect(kinds(await s.until("toolu-4"))).toEqual([
      "permission_denied",
      "tool_result",
    ]);
    // Reported once: a second result for the same id brings no second card.
    s.toolResult("toolu-4", "refused");
    expect(kinds(await s.until("toolu-4"))).toEqual(["tool_result"]);
  });

  it("does the same in a session below Standard, whose hooks are built apart", async () => {
    const folder = mkdtempSync(join(tmpdir(), "denial-folder-"));
    try {
      const s = open({ access: "folder", mcpServers: [] }, folder);
      const reason = await s.hook(
        "Read",
        { file_path: "/etc/hostname" },
        "toolu-6",
      );
      expect(reason).not.toBeNull();
      s.toolResult("toolu-6", `PreToolUse:Read hook error: ${reason}`);
      const events = await s.until("toolu-6");
      expect(kinds(events)).toEqual(["permission_denied", "tool_result"]);
      expect((events[0] as { toolName?: string }).toolName).toBe("Read");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
