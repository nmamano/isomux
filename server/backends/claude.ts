// Claude backend implementation.
//
// Step 2b (current): the wrapper translates Claude SDK messages into the
// NormalizedEvent union at the stream boundary. The orchestrator
// (processNormalizedEvent) consumes only normalized events and no longer
// reaches into SDKMessage shapes. send/close still pass through verbatim.
//
// Step 2c will move createSession + safety-hooks + canUseTool into this module
// so agent-manager has no `@anthropic-ai/...` imports at all.

import type {
  SDKMessage,
  SDKSession,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Attachment } from "../../shared/types.ts";
import { saveFile } from "../persistence.ts";
import type { NormalizedEvent, TokenUsage } from "./types.ts";

export class ClaudeBackendSession {
  constructor(
    private readonly sdkSession: SDKSession,
    private readonly agentId: string,
  ) {}

  async *stream(): AsyncGenerator<NormalizedEvent, void> {
    for await (const msg of this.sdkSession.stream()) {
      yield* translateSDKMessage(msg, this.agentId);
    }
  }

  send(message: string | SDKUserMessage): Promise<void> {
    return this.sdkSession.send(message);
  }

  close(): void {
    this.sdkSession.close();
  }
}

// Translate one SDKMessage into 0+ NormalizedEvents. The wrapper yields these
// in order so the orchestrator's state derivation sees them per-block.
function* translateSDKMessage(
  msg: SDKMessage,
  agentId: string,
): Generator<NormalizedEvent, void> {
  switch (msg.type) {
    case "system": {
      const subtype = (msg as any).subtype;
      if (subtype === "init") {
        const sessionId = (msg as any).session_id;
        if (!sessionId) break;
        yield {
          kind: "system_init",
          sessionId,
          slashCommands: (msg as any).slash_commands ?? [],
          model: (msg as any).model,
        };
      } else if (subtype === "local_command_output") {
        const content = (msg as any).content;
        if (content) yield { kind: "system_text", text: content };
      }
      break;
    }

    case "assistant": {
      const message = (msg as any).message;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      // SDK injects synthetic assistant turns (model === "<synthetic>") for
      // things like usage-limit hits and queue-flush gaps. Map their text to
      // system breadcrumbs so they don't render as Claude-voice.
      const isSynthetic = message?.model === "<synthetic>";
      for (const block of content) {
        if (block.type === "text" && block.text) {
          yield isSynthetic
            ? { kind: "system_text", text: block.text }
            : { kind: "assistant_text", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            kind: "tool_call",
            toolUseId: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          };
        } else if (block.type === "thinking" && block.thinking) {
          yield { kind: "thinking", text: block.thinking };
        }
      }
      break;
    }

    case "user": {
      const content = (msg as any).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              : JSON.stringify(block.content);
        // Extract image blocks → save to disk → emit as attachments. Side-
        // effecting, but persistence is a backend-level concern (not
        // orchestration) and the SDK's wire shape is the only place we
        // have the base64 bytes.
        let attachments: Attachment[] | undefined;
        if (Array.isArray(block.content)) {
          const atts: Attachment[] = [];
          for (const c of block.content as any[]) {
            if (c.type === "image" && c.source?.type === "base64") {
              const decoded = Buffer.from(c.source.data, "base64");
              const ext = c.source.media_type.split("/")[1] ?? "png";
              const att = saveFile(agentId, decoded, c.source.media_type, `image.${ext}`);
              if (att) atts.push(att);
            }
          }
          if (atts.length > 0) attachments = atts;
        }
        yield {
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: resultText,
          attachments,
        };
      }
      break;
    }

    case "result": {
      const subtype = (msg as any).subtype;
      const usageField = (msg as any).usage;
      // Only trust usage from success results. Error-subtype results may omit
      // `usage`; coercing to zeros would overwrite the accurate cumulative.
      const usage: TokenUsage | undefined =
        usageField && subtype === "success"
          ? {
              inputTokens: usageField.input_tokens ?? 0,
              outputTokens: usageField.output_tokens ?? 0,
              cacheReadInputTokens: usageField.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: usageField.cache_creation_input_tokens ?? 0,
            }
          : undefined;
      const cost = (msg as any).total_cost_usd as number | undefined;
      if (subtype === "success") {
        yield { kind: "turn_completed", status: "completed", usage, cost };
      } else {
        const errors = (msg as any).errors as string[] | undefined;
        const errorText = `Agent stopped: ${subtype}. ${errors?.join(", ") || ""}`;
        yield {
          kind: "turn_completed",
          status: "failed",
          usage,
          cost,
          error: errorText,
        };
      }
      break;
    }

    // tool_progress and other SDK message types: no orchestrator-visible
    // counterpart at v1. State stays at tool_executing from the prior
    // tool_call event.
    default:
      break;
  }
}
