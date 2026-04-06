import { useState, useCallback } from "react";
import type { LogEntry } from "../../shared/types.ts";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { SpeakButton } from "../components/SpeakButton.tsx";

/** Serialize entries for clipboard (text + tool_call only) */
export function serializeEntries(entries: LogEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind === "user_message") {
      parts.push(e.content);
    } else if (e.kind === "text") {
      parts.push(e.content);
    } else if (e.kind === "tool_call") {
      const input = e.metadata?.input;
      const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      parts.push(`**${e.content}**\n${inputStr}`);
    }
  }
  return parts.join("\n\n");
}

function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function DurationLabel({ ms, isMobile }: { ms: number; isMobile?: boolean }) {
  return (
    <span style={{
      marginLeft: "auto",
      fontSize: isMobile ? 12 : 10,
      fontFamily: "'JetBrains Mono',monospace",
      color: "var(--text-ghost)",
      flexShrink: 0,
    }}>
      {formatDuration(ms)}
    </span>
  );
}

export function LogEntryCard({
  entry,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  entry: LogEntry;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  switch (entry.kind) {
    case "user_message": {
      const username = entry.metadata?.username as string | undefined;
      return <UserMessage content={entry.content} isMobile={isMobile} username={username} />;
    }
    case "text":
      return (
        <AssistantText
          content={entry.content}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    case "thinking": {
      const durationMs = entry.metadata?.duration_ms as number | undefined;
      return (
        <ThinkingBlock
          content={entry.content}
          durationMs={durationMs}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    }
    case "tool_call": {
      // Find matching tool_result to get duration
      const toolId = entry.metadata?.toolId;
      const matchingResult = turnEntries?.find(
        (e) => e.kind === "tool_result" && e.metadata?.toolUseId === toolId
      );
      const durationMs = matchingResult?.metadata?.duration_ms as number | undefined;
      return (
        <ToolCall
          name={entry.content}
          input={entry.metadata?.input}
          durationMs={durationMs}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    }
    case "tool_result":
      return (
        <ToolResult
          entry={entry}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    case "error":
      return (
        <ErrorBlock
          content={entry.content}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    case "system":
      return <SystemMessage content={entry.content} isMobile={isMobile} />;
    default:
      return <div style={{ padding: "4px 0", color: "var(--text-muted)", fontSize: isMobile ? 14 : 12 }}>{entry.content}</div>;
  }
}

function TurnCopyButton({ turnEntries }: { turnEntries?: LogEntry[] }) {
  const getText = useCallback(
    () => (turnEntries ? serializeEntries(turnEntries) : ""),
    [turnEntries],
  );
  if (!turnEntries) return null;
  return (
    <div style={{ position: "absolute", top: 8, right: 8 }}>
      <CopyButton getText={getText} />
    </div>
  );
}

function UserMessage({ content, isMobile, username }: { content: string; isMobile?: boolean; username?: string }) {
  const getText = useCallback(() => content, [content]);
  return (
    <div style={{ margin: "12px 0", padding: "10px 14px", paddingRight: 40, borderRadius: 10, background: "var(--user-msg-bg)", borderLeft: "3px solid var(--accent)", position: "relative" }}>
      <div style={{ fontSize: isMobile ? 12 : 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4, fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>{(username ?? "You").toUpperCase()}</div>
      <div style={{ color: "var(--text-secondary)", fontFamily: "'JetBrains Mono',monospace", fontSize: isMobile ? 15 : 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>{content}</div>
      <div style={{ position: "absolute", top: 8, right: 8 }}>
        <CopyButton getText={getText} />
      </div>
    </div>
  );
}

function AssistantText({ content, isLastInTurn, turnEntries, isMobile }: { content: string; isLastInTurn?: boolean; turnEntries?: LogEntry[]; isMobile?: boolean }) {
  const getText = useCallback(() => content, [content]);
  return (
    <div style={{ margin: "8px 0", padding: "10px 14px", paddingRight: 40, borderRadius: 10, background: "var(--bg-subtle)", position: "relative", fontSize: isMobile ? 15 : undefined }}>
      <Markdown content={content} />
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        <SpeakButton getText={getText} />
        {isLastInTurn && turnEntries && <CopyButton getText={() => serializeEntries(turnEntries)} />}
      </div>
    </div>
  );
}

function ThinkingBlock({ content, durationMs, isLastInTurn, turnEntries, isMobile }: { content: string; durationMs?: number; isLastInTurn?: boolean; turnEntries?: LogEntry[]; isMobile?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "4px 0", position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px", border: "none", background: "transparent",
          color: "var(--text-faint)", fontSize: isMobile ? 13 : 11, cursor: "pointer",
          fontFamily: "'DM Sans',sans-serif", width: "100%", textAlign: "left",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block" }}>&#9654;</span>
        Thinking...
        {durationMs != null && <DurationLabel ms={durationMs} isMobile={isMobile} />}
      </button>
      {open && (
        <div style={{
          margin: "4px 0 4px 20px", padding: "8px 12px",
          borderRadius: 8, background: "var(--thinking-bg)",
          borderLeft: "2px solid var(--thinking-border)",
          color: "var(--text-faint)", fontSize: isMobile ? 14 : 12, fontFamily: "'JetBrains Mono',monospace",
          lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 300, overflowY: "auto", overflowWrap: "break-word", wordBreak: "break-word",
        }}>
          {content}
        </div>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function ToolCall({ name, input, durationMs, isLastInTurn, turnEntries, isMobile }: { name: string; input: unknown; durationMs?: number; isLastInTurn?: boolean; turnEntries?: LogEntry[]; isMobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const summary = extractToolSummary(name, input);

  return (
    <div style={{ margin: "4px 0", position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 10px", paddingRight: isLastInTurn ? 40 : 10,
          border: "1px solid var(--green-border)",
          borderRadius: 6, background: "var(--tool-call-bg)",
          color: "var(--green)", fontSize: isMobile ? 14 : 12, cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace", width: "100%", textAlign: "left",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", display: "inline-block", fontSize: 8 }}>&#9654;</span>
        <span style={{ fontWeight: 600 }}>{name}</span>
        {summary && <span style={{ color: "var(--text-faint)", marginLeft: 4, fontSize: isMobile ? 13 : 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{summary}</span>}
        {durationMs != null && <DurationLabel ms={durationMs} isMobile={isMobile} />}
      </button>
      {open && (
        <div style={{
          margin: "2px 0 2px 20px", padding: "8px 10px",
          borderRadius: 6, background: "var(--tool-open-bg)",
          fontSize: isMobile ? 13 : 11, fontFamily: "'JetBrains Mono',monospace",
          color: "var(--text-dim)", lineHeight: 1.5, whiteSpace: "pre-wrap",
          maxHeight: 200, overflowY: "auto", overflowX: "auto", maxWidth: "100%",
        }}>
          {inputStr}
        </div>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function ToolResult({ entry, isLastInTurn, turnEntries, isMobile }: { entry: LogEntry; isLastInTurn?: boolean; turnEntries?: LogEntry[]; isMobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const content = entry.content;
  const imageAttachments = entry.attachments?.filter((a) => a.mediaType.startsWith("image/"));
  const isLong = content.length > 200;
  const preview = isLong ? content.slice(0, 150) + "..." : content;

  return (
    <div style={{
      margin: "2px 0 8px 20px", padding: "6px 10px",
      borderRadius: 6, background: "var(--tool-result-bg)",
      borderLeft: "2px solid var(--green-border)",
      fontSize: isMobile ? 13 : 11, fontFamily: "'JetBrains Mono',monospace",
      color: "var(--text-dim)", lineHeight: 1.5, position: "relative",
    }}>
      {content && <div style={{ whiteSpace: "pre-wrap", overflowX: "auto", maxWidth: "100%" }}>{open ? content : preview}</div>}
      {isLong && (
        <button
          onClick={() => setOpen(!open)}
          style={{
            marginTop: 4, padding: "2px 6px", border: "none",
            background: "var(--expand-btn)", borderRadius: 4,
            color: "var(--text-faint)", fontSize: isMobile ? 12 : 10, cursor: "pointer",
            fontFamily: "'DM Sans',sans-serif",
          }}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
      {imageAttachments && imageAttachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: content ? 8 : 0 }}>
          {imageAttachments.map((att) => {
            const src = `/api/files/${entry.agentId}/${att.filename}`;
            return (
              <img
                key={att.filename}
                src={src}
                alt={att.originalName}
                onClick={() => setLightboxSrc(src)}
                style={{
                  maxWidth: isMobile ? "100%" : 300, maxHeight: 200, borderRadius: 4,
                  cursor: "pointer", border: "1px solid var(--green-border)",
                }}
              />
            );
          })}
        </div>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
      {lightboxSrc && (
        <div
          tabIndex={0}
          ref={(el) => el?.focus()}
          onClick={() => setLightboxSrc(null)}
          onKeyDown={(e) => e.key === "Escape" && setLightboxSrc(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img src={lightboxSrc} alt="Full size" style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

function ErrorBlock({ content, isLastInTurn, turnEntries, isMobile }: { content: string; isLastInTurn?: boolean; turnEntries?: LogEntry[]; isMobile?: boolean }) {
  return (
    <div style={{
      margin: "8px 0", padding: "10px 14px",
      borderRadius: 8, background: "var(--red-bg)",
      borderLeft: "3px solid var(--red)",
      color: "var(--red)", fontSize: isMobile ? 14 : 12, fontFamily: "'JetBrains Mono',monospace",
      lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word", position: "relative",
    }}>
      {content}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function SystemMessage({ content, isMobile }: { content: string; isMobile?: boolean }) {
  const isMultiline = content.includes("\n");
  return (
    <div style={{
      margin: "8px 0", padding: "6px 0",
      textAlign: isMultiline ? "left" : "center",
      color: isMultiline ? "var(--text-dim)" : "var(--text-ghost)",
      fontSize: isMultiline ? (isMobile ? 15 : 13) : (isMobile ? 13 : 11),
      fontFamily: isMultiline ? "'JetBrains Mono',monospace" : "'DM Sans',sans-serif",
      fontStyle: isMultiline ? "normal" : "italic",
      ...(!isMultiline && { whiteSpace: "pre-wrap" }),
    }}>
      {isMultiline ? <Markdown content={content} /> : content}
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
