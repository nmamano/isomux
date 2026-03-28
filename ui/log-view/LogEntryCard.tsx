import { useState } from "react";
import type { LogEntry } from "../../shared/types.ts";
import { Markdown } from "./Markdown.tsx";

export function LogEntryCard({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case "user_message":
      return <UserMessage content={entry.content} />;
    case "text":
      return <AssistantText content={entry.content} />;
    case "thinking":
      return <ThinkingBlock content={entry.content} />;
    case "tool_call":
      return <ToolCall name={entry.content} input={entry.metadata?.input} />;
    case "tool_result":
      return <ToolResult content={entry.content} />;
    case "error":
      return <ErrorBlock content={entry.content} />;
    case "system":
      return <SystemMessage content={entry.content} />;
    default:
      return <div style={{ padding: "4px 0", color: "var(--text-muted)", fontSize: 12 }}>{entry.content}</div>;
  }
}

function UserMessage({ content }: { content: string }) {
  return (
    <div style={{ margin: "12px 0", padding: "10px 14px", borderRadius: 10, background: "var(--user-msg-bg)", borderLeft: "3px solid var(--accent)" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4, fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>You</div>
      <div style={{ color: "var(--text-secondary)", fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{content}</div>
    </div>
  );
}

function AssistantText({ content }: { content: string }) {
  return (
    <div style={{ margin: "8px 0", padding: "10px 14px", borderRadius: 10, background: "var(--bg-subtle)" }}>
      <Markdown content={content} />
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "4px 0" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px", border: "none", background: "transparent",
          color: "var(--text-faint)", fontSize: 11, cursor: "pointer",
          fontFamily: "'DM Sans',sans-serif",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block" }}>&#9654;</span>
        Thinking...
      </button>
      {open && (
        <div style={{
          margin: "4px 0 4px 20px", padding: "8px 12px",
          borderRadius: 8, background: "var(--thinking-bg)",
          borderLeft: "2px solid var(--thinking-border)",
          color: "var(--text-faint)", fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
          lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 300, overflowY: "auto",
        }}>
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCall({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  // Extract a short summary from the input
  const summary = extractToolSummary(name, input);

  return (
    <div style={{ margin: "4px 0" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 10px", border: "1px solid var(--green-border)",
          borderRadius: 6, background: "var(--tool-call-bg)",
          color: "var(--green)", fontSize: 12, cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace", width: "100%", textAlign: "left",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block", fontSize: 8 }}>&#9654;</span>
        <span style={{ fontWeight: 600 }}>{name}</span>
        {summary && <span style={{ color: "var(--text-faint)", marginLeft: 4, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{summary}</span>}
      </button>
      {open && (
        <div style={{
          margin: "2px 0 2px 20px", padding: "8px 10px",
          borderRadius: 6, background: "var(--tool-open-bg)",
          fontSize: 11, fontFamily: "'JetBrains Mono',monospace",
          color: "var(--text-dim)", lineHeight: 1.5, whiteSpace: "pre-wrap",
          maxHeight: 200, overflowY: "auto",
        }}>
          {inputStr}
        </div>
      )}
    </div>
  );
}

function ToolResult({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const isLong = content.length > 200;
  const preview = isLong ? content.slice(0, 150) + "..." : content;

  return (
    <div style={{
      margin: "2px 0 8px 20px", padding: "6px 10px",
      borderRadius: 6, background: "var(--tool-result-bg)",
      borderLeft: "2px solid var(--green-border)",
      fontSize: 11, fontFamily: "'JetBrains Mono',monospace",
      color: "var(--text-dim)", lineHeight: 1.5,
    }}>
      <div style={{ whiteSpace: "pre-wrap" }}>{open ? content : preview}</div>
      {isLong && (
        <button
          onClick={() => setOpen(!open)}
          style={{
            marginTop: 4, padding: "2px 6px", border: "none",
            background: "var(--expand-btn)", borderRadius: 4,
            color: "var(--text-faint)", fontSize: 10, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif",
          }}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ErrorBlock({ content }: { content: string }) {
  return (
    <div style={{
      margin: "8px 0", padding: "10px 14px",
      borderRadius: 8, background: "var(--red-bg)",
      borderLeft: "3px solid var(--red)",
      color: "var(--red)", fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
      lineHeight: 1.5, whiteSpace: "pre-wrap",
    }}>
      {content}
    </div>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <div style={{
      margin: "8px 0", padding: "6px 0",
      textAlign: "center", color: "var(--text-ghost)", fontSize: 11,
      fontFamily: "'DM Sans',sans-serif", fontStyle: "italic",
    }}>
      {content}
    </div>
  );
}

function extractToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case "Bash":
      return typeof obj.command === "string" ? obj.command.slice(0, 80) : "";
    case "Read":
      return typeof obj.file_path === "string" ? obj.file_path : "";
    case "Write":
    case "Edit":
      return typeof obj.file_path === "string" ? obj.file_path : "";
    case "Glob":
      return typeof obj.pattern === "string" ? obj.pattern : "";
    case "Grep":
      return typeof obj.pattern === "string" ? obj.pattern : "";
    case "WebSearch":
      return typeof obj.query === "string" ? obj.query : "";
    default:
      return typeof obj.description === "string" ? obj.description.slice(0, 60) : "";
  }
}
