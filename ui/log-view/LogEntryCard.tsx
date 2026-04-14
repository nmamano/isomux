import { useState, useCallback, useRef, useEffect } from "react";
import type { LogEntry, Attachment } from "../../shared/types.ts";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { SpeakButton } from "../components/SpeakButton.tsx";

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 3.5L12.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

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

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileChip({ att, agentId, isMobile }: { att: Attachment; agentId: string; isMobile?: boolean }) {
  const isPdf = att.mediaType === "application/pdf";
  const icon = isPdf ? "📄" : "📎";
  const sizeStr = formatFileSize(att.size);
  const href = `/api/files/${agentId}/${att.filename}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 6,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        color: "var(--text-secondary)",
        fontSize: isMobile ? 13 : 11,
        fontFamily: "'JetBrains Mono',monospace",
        textDecoration: "none",
        cursor: "pointer",
        maxWidth: "100%",
      }}
    >
      <span>{icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.originalName}</span>
      {sizeStr && <span style={{ color: "var(--text-ghost)", flexShrink: 0 }}>{sizeStr}</span>}
    </a>
  );
}

function AttachmentDisplay({
  attachments,
  agentId,
  isMobile,
  lightboxSrc,
  setLightboxSrc,
  hasContent,
}: {
  attachments: Attachment[];
  agentId: string;
  isMobile?: boolean;
  lightboxSrc: string | null;
  setLightboxSrc: (src: string | null) => void;
  hasContent?: boolean;
}) {
  const images = attachments.filter((a) => a.mediaType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mediaType.startsWith("image/"));

  return (
    <>
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: hasContent ? 8 : 0 }}>
          {images.map((att) => {
            const src = `/api/files/${agentId}/${att.filename}`;
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
      {files.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: hasContent || images.length > 0 ? 8 : 0 }}>
          {files.map((att) => (
            <FileChip key={att.filename} att={att} agentId={agentId} isMobile={isMobile} />
          ))}
        </div>
      )}
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
    </>
  );
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
  canEdit,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  entry: LogEntry;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  canEdit?: boolean;
  isEditing?: boolean;
  onStartEdit?: (entryId: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (entryId: string, newText: string) => void;
}) {
  switch (entry.kind) {
    case "user_message": {
      const username = entry.metadata?.username as string | undefined;
      if (isEditing) {
        return <EditableUserMessage content={entry.content} entryId={entry.id} isMobile={isMobile} username={username} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />;
      }
      return <UserMessage content={entry.content} isMobile={isMobile} username={username} attachments={entry.attachments} agentId={entry.agentId} canEdit={canEdit} onEdit={onStartEdit ? () => onStartEdit(entry.id) : undefined} />;
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

function UserMessage({ content, isMobile, username, attachments, agentId, canEdit, onEdit }: { content: string; isMobile?: boolean; username?: string; attachments?: Attachment[]; agentId?: string; canEdit?: boolean; onEdit?: () => void }) {
  const getText = useCallback(() => content, [content]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <div style={{ margin: "12px 0", padding: "10px 14px", paddingRight: 40, borderRadius: 10, background: "var(--user-msg-bg)", borderLeft: "3px solid var(--accent)", position: "relative" }}>
      <div style={{ fontSize: isMobile ? 12 : 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4, fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>{(username ?? "You").toUpperCase()}</div>
      {content && <div style={{ color: "var(--text-secondary)", fontFamily: "'JetBrains Mono',monospace", fontSize: isMobile ? 15 : 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>{content}</div>}
      {attachments && attachments.length > 0 && agentId && (
        <AttachmentDisplay
          attachments={attachments}
          agentId={agentId}
          isMobile={isMobile}
          lightboxSrc={lightboxSrc}
          setLightboxSrc={setLightboxSrc}
          hasContent={!!content}
        />
      )}
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        {canEdit && onEdit && (
          <button
            onClick={onEdit}
            title="Edit & branch"
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--text-ghost)", padding: 2, borderRadius: 4,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "color 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--accent)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-ghost)")}
          >
            <EditIcon />
          </button>
        )}
        <CopyButton getText={getText} />
      </div>
    </div>
  );
}

function EditableUserMessage({ content, entryId, isMobile, username, onCancel, onSubmit }: {
  content: string;
  entryId: string;
  isMobile?: boolean;
  username?: string;
  onCancel?: () => void;
  onSubmit?: (entryId: string, newText: string) => void;
}) {
  const [text, setText] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSubmit?.(entryId, text.trim());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  }

  return (
    <div style={{
      margin: "12px 0", padding: "10px 14px", borderRadius: 10,
      background: "var(--user-msg-bg)", borderLeft: "3px solid var(--accent)",
      position: "relative",
    }}>
      <div style={{ fontSize: isMobile ? 12 : 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4, fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {(username ?? "You").toUpperCase()}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = e.target.scrollHeight + "px";
        }}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%", resize: "none", border: "1px solid var(--accent)",
          borderRadius: 6, padding: "8px 10px", fontSize: isMobile ? 15 : 13,
          fontFamily: "'JetBrains Mono',monospace", lineHeight: 1.6,
          background: "var(--bg-base)", color: "var(--text-secondary)",
          outline: "none", minHeight: 40, boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{
            padding: "4px 14px", borderRadius: 6, border: "1px solid var(--border-medium)",
            background: "transparent", color: "var(--text-muted)",
            fontSize: isMobile ? 14 : 12, fontFamily: "'DM Sans',sans-serif", cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => text.trim() && onSubmit?.(entryId, text.trim())}
          style={{
            padding: "4px 14px", borderRadius: 6, border: "none",
            background: "var(--accent)", color: "#fff",
            fontSize: isMobile ? 14 : 12, fontFamily: "'DM Sans',sans-serif", cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Send
        </button>
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
      {entry.attachments && entry.attachments.length > 0 && (
        <AttachmentDisplay
          attachments={entry.attachments}
          agentId={entry.agentId}
          isMobile={isMobile}
          lightboxSrc={lightboxSrc}
          setLightboxSrc={setLightboxSrc}
          hasContent={!!content}
        />
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
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
