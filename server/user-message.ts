import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { Attachment } from "../shared/types.ts";
import { readFileSync, statSync } from "fs";
import { getFilePath } from "./persistence.ts";

// Extensions that should be sent as text content blocks
const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "cfg",
  "sh", "bash", "py", "js", "ts", "go", "rs", "c", "h", "cpp", "java", "rb",
  "html", "css", "sql", "env", "conf",
]);

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function buildUserMessage(agentId: string, text: string, attachments: Attachment[]): SDKUserMessage {
  const content: ContentBlockParam[] = [];

  // Text block first (if non-empty)
  if (text) {
    content.push({ type: "text", text });
  }

  // Attachment blocks
  for (const att of attachments) {
    const filePath = getFilePath(agentId, att.filename);
    if (!filePath) continue;

    if (IMAGE_MEDIA_TYPES.has(att.mediaType)) {
      const data = readFileSync(filePath).toString("base64");
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data,
        },
      });
    } else if (att.mediaType === "application/pdf") {
      // Claude API limits: 100 pages, ~32MB base64. Check file size as a proxy.
      const stats = statSync(filePath);
      if (stats.size > 10 * 1024 * 1024) {
        // Too large to send inline — give the agent the file path instead
        content.push({
          type: "text",
          text: `Attached PDF "${att.originalName}" (${(stats.size / 1024 / 1024).toFixed(1)}MB) is too large to display inline. The file is saved at: ${filePath}`,
        });
      } else {
        const data = readFileSync(filePath).toString("base64");
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data,
          },
        });
      }
    } else {
      const ext = att.originalName.includes(".") ? att.originalName.split(".").pop()!.toLowerCase() : "";
      if (TEXT_FILE_EXTENSIONS.has(ext)) {
        const fileContent = readFileSync(filePath, "utf-8");
        content.push({
          type: "text",
          text: `--- File: ${att.originalName} ---\n${fileContent}\n---`,
        });
      } else {
        content.push({
          type: "text",
          text: `Attached file ${att.originalName} (unable to see content) [Reminder: do not pretend that you can see it or infer its content]`,
        });
      }
    }
  }

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}
