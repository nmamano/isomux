import { useState, useCallback, useRef, useEffect, useMemo, memo } from "react";
import type { LogEntry, Attachment } from "../../shared/types.ts";
import { formatIdentity } from "../../shared/identity.ts";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { SpeakButton } from "../components/SpeakButton.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { EditRequestCard } from "./EditRequestCard.tsx";
import { FileViewCard } from "./FileViewCard.tsx";
import { TerminalCommandCard } from "./TerminalCommandCard.tsx";
import { parseIsomuxCurl } from "./isomux-curl.ts";
import {
  IsomuxCurlHeader,
  IsomuxCurlFields,
  isomuxUiPorts,
} from "./IsomuxCurlSummary.tsx";

function EditIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 3.5L12.5 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * True when this tool_result is paired with a tool_call in the same turn and
 * has nothing the user needs to see in its own row (no attachments). Folded
 * results are hidden — the tool_call's expand panel renders their text, and
 * errored results additionally show a compact preview inside their (red)
 * tool_call card. Errors fold too: with parallel tool calls the results
 * arrive after ALL the calls, so a standalone error row would sit under an
 * unrelated call's card instead of the one that failed.
 * Shared between LogEntryCard (skips rendering folded rows) and LogView
 * (recomputes isLastInTurn against visible entries).
 */
export function isFoldedToolResult(
  entry: LogEntry,
  turnEntries: LogEntry[] | undefined,
): boolean {
  if (entry.kind !== "tool_result") return false;
  if ((entry.attachments?.length ?? 0) > 0) return false;
  const toolUseId = entry.metadata?.toolUseId;
  if (!toolUseId || !turnEntries) return false;
  return turnEntries.some(
    (e) => e.kind === "tool_call" && e.metadata?.toolId === toolUseId,
  );
}

function findMatchingToolResult(
  toolCallEntry: LogEntry,
  turnEntries: LogEntry[] | undefined,
): LogEntry | undefined {
  const toolId = toolCallEntry.metadata?.toolId;
  if (!toolId || !turnEntries) return undefined;
  return turnEntries.find(
    (e) => e.kind === "tool_result" && e.metadata?.toolUseId === toolId,
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
      const inputStr =
        typeof input === "string" ? input : JSON.stringify(input, null, 2);
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

function FileChip({
  att,
  agentId,
  isMobile,
}: {
  att: Attachment;
  agentId: string;
  isMobile?: boolean;
}) {
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
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {att.originalName}
      </span>
      {sizeStr && (
        <span style={{ color: "var(--text-ghost)", flexShrink: 0 }}>
          {sizeStr}
        </span>
      )}
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

  // Intercept Escape at the capture phase so the global window-level handler in
  // App.tsx (which navigates back to the room view) doesn't fire while the
  // lightbox is open.
  useEffect(() => {
    if (!lightboxSrc) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightboxSrc(null);
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [lightboxSrc, setLightboxSrc]);

  return (
    <>
      {images.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: hasContent ? 8 : 0,
          }}
        >
          {images.map((att) => {
            const src = `/api/files/${agentId}/${att.filename}`;
            return (
              <img
                key={att.filename}
                src={src}
                alt={att.originalName}
                onClick={() => setLightboxSrc(src)}
                style={{
                  maxWidth: isMobile ? "100%" : 300,
                  maxHeight: 200,
                  borderRadius: 4,
                  cursor: "pointer",
                  border: "1px solid var(--green-border)",
                }}
              />
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: hasContent || images.length > 0 ? 8 : 0,
          }}
        >
          {files.map((att) => (
            <FileChip
              key={att.filename}
              att={att}
              agentId={agentId}
              isMobile={isMobile}
            />
          ))}
        </div>
      )}
      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img
            src={lightboxSrc}
            alt="Full size"
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }}
          />
        </div>
      )}
    </>
  );
}

function DurationLabel({ ms, isMobile }: { ms: number; isMobile?: boolean }) {
  return (
    <span
      style={{
        marginLeft: "auto",
        fontSize: isMobile ? 12 : 10,
        fontFamily: "'JetBrains Mono',monospace",
        color: "var(--text-ghost)",
        flexShrink: 0,
      }}
    >
      {formatDuration(ms)}
    </span>
  );
}

export const LogEntryCard = memo(function LogEntryCard({
  entry,
  isLastInTurn,
  turnEntries,
  isMobile,
  canEdit,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onOpenInEditor,
  onCopyToTerminal,
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
  onOpenInEditor?: (path: string) => void;
  onCopyToTerminal?: (command: string) => void;
}) {
  switch (entry.kind) {
    case "user_message": {
      const username = entry.metadata?.username as string | undefined;
      const device = entry.metadata?.device as string | undefined;
      const senderAgentName = entry.metadata?.sender_agent_name as
        | string
        | undefined;
      const senderAgentRoom = entry.metadata?.sender_agent_room as
        | string
        | undefined;
      // Agent-sender flushed messages carry sender_agent_* metadata; display
      // them with a different label and styling from human bosses so the
      // authority distinction stays visible after the chip lands in the log.
      const senderLabel = senderAgentName
        ? `${senderAgentName} · agent${senderAgentRoom ? ` · Room "${senderAgentRoom}"` : ""}`
        : formatIdentity({ username, device }) || undefined;
      const fromAgent = !!senderAgentName;
      if (isEditing) {
        return (
          <EditableUserMessage
            content={entry.content}
            entryId={entry.id}
            isMobile={isMobile}
            username={senderLabel}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        );
      }
      return (
        <UserMessage
          content={entry.content}
          isMobile={isMobile}
          username={senderLabel}
          fromAgent={fromAgent}
          attachments={entry.attachments}
          agentId={entry.agentId}
          canEdit={canEdit && !fromAgent}
          onEdit={onStartEdit ? () => onStartEdit(entry.id) : undefined}
        />
      );
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
      const matchingResult = findMatchingToolResult(entry, turnEntries);
      const durationMs = matchingResult?.metadata?.duration_ms as
        | number
        | undefined;
      const resultIsError = matchingResult?.metadata?.isError === true;
      return (
        <ToolCall
          name={entry.content}
          input={entry.metadata?.input}
          hasResult={matchingResult != null}
          resultContent={matchingResult?.content}
          resultIsError={resultIsError}
          durationMs={durationMs}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    }
    case "tool_result": {
      if (isFoldedToolResult(entry, turnEntries)) return null;
      return (
        <ToolResult
          entry={entry}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    }
    case "error":
      return (
        <ErrorBlock
          content={entry.content}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    case "system": {
      // Auto-denied tool calls carry metadata.permissionDenied (see
      // agent-manager's permission_denied case). Sessions from before this
      // feature (or older SDKs that never emit the event) simply have no such
      // entries; nothing else guards on it.
      const permissionDenied = entry.metadata?.permissionDenied as
        | { toolName?: string; message?: string; decisionReason?: string }
        | undefined;
      if (permissionDenied) {
        return (
          <PermissionDeniedCard denial={permissionDenied} isMobile={isMobile} />
        );
      }
      // Background-task lifecycle breadcrumbs carry metadata.taskEvent (see
      // agent-manager's task_lifecycle case). Render with a status dot so
      // settle outcomes scan at a glance; everything else stays SystemMessage.
      const taskEvent = entry.metadata?.taskEvent as
        | { phase?: string }
        | undefined;
      if (taskEvent) {
        return (
          <TaskBreadcrumb
            content={entry.content}
            phase={taskEvent.phase}
            isMobile={isMobile}
          />
        );
      }
      return <SystemMessage content={entry.content} isMobile={isMobile} />;
    }
    case "diff": {
      if (!entry.diff)
        return <SystemMessage content={entry.content} isMobile={isMobile} />;
      return <DiffCard payload={entry.diff} />;
    }
    case "edit-request": {
      if (!entry.file || !onOpenInEditor)
        return <SystemMessage content={entry.content} isMobile={isMobile} />;
      return <EditRequestCard payload={entry.file} onOpen={onOpenInEditor} />;
    }
    case "terminal-command": {
      if (!entry.terminal || !onCopyToTerminal)
        return <SystemMessage content={entry.content} isMobile={isMobile} />;
      return (
        <TerminalCommandCard
          payload={entry.terminal}
          onCopy={onCopyToTerminal}
        />
      );
    }
    case "file-view": {
      if (!entry.attachments || entry.attachments.length === 0)
        return <SystemMessage content={entry.content} isMobile={isMobile} />;
      // preview-url marks its entries with metadata.preview and sets content
      // to the captured page's sanitized URL — show it as a caption. Other
      // file-view producers (read-file) carry no marker and stay caption-free;
      // explicit contract rather than inferring from content/filename drift.
      const caption =
        entry.metadata?.preview === true && entry.content
          ? entry.content
          : undefined;
      return (
        <FileViewCard
          attachments={entry.attachments}
          agentId={entry.agentId}
          isMobile={isMobile}
          caption={caption}
        />
      );
    }
    default:
      return (
        <div
          style={{
            padding: "4px 0",
            color: "var(--text-muted)",
            fontSize: isMobile ? 14 : 12,
          }}
        >
          {entry.content}
        </div>
      );
  }
});

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

function UserMessage({
  content,
  isMobile,
  username,
  fromAgent,
  attachments,
  agentId,
  canEdit,
  onEdit,
}: {
  content: string;
  isMobile?: boolean;
  username?: string;
  fromAgent?: boolean;
  attachments?: Attachment[];
  agentId?: string;
  canEdit?: boolean;
  onEdit?: () => void;
}) {
  const getText = useCallback(() => content, [content]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const accentColor = fromAgent ? "var(--text-muted)" : "var(--accent)";
  return (
    <div
      style={{
        margin: "12px 0",
        padding: "10px 14px",
        paddingRight: 40,
        borderRadius: 10,
        background: "var(--user-msg-bg)",
        borderLeft: `3px ${fromAgent ? "dashed" : "solid"} ${accentColor}`,
        position: "relative",
      }}
    >
      <div
        style={{
          fontSize: isMobile ? 12 : 10,
          fontWeight: 600,
          color: accentColor,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontStyle: fromAgent ? "italic" : "normal",
        }}
      >
        {(username ?? "You").toUpperCase()}
      </div>
      {content && (
        <div
          style={{
            color: "var(--text-secondary)",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: isMobile ? 15 : 13,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {content}
        </div>
      )}
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
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          gap: 4,
        }}
      >
        {canEdit && onEdit && (
          <button
            onClick={onEdit}
            title="Edit & branch"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--text-ghost)",
              padding: 2,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--accent)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "var(--text-ghost)")
            }
          >
            <EditIcon />
          </button>
        )}
        <CopyButton getText={getText} />
      </div>
    </div>
  );
}

function EditableUserMessage({
  content,
  entryId,
  isMobile,
  username,
  onCancel,
  onSubmit,
}: {
  content: string;
  entryId: string;
  isMobile?: boolean;
  username?: string;
  onCancel?: () => void;
  onSubmit?: (entryId: string, newText: string) => void;
}) {
  const [text, setText] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Use `pointer: coarse` instead of viewport `isMobile` so narrow desktop
  // windows (split-screen) with a hardware keyboard still send on Enter,
  // matching the main composer in LogView.tsx.
  const isTouchPrimary = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        textareaRef.current.scrollHeight + "px";
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      !isTouchPrimary
    ) {
      e.preventDefault();
      if (text.trim()) onSubmit?.(entryId, text.trim());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel?.();
    }
  }

  return (
    <div
      style={{
        margin: "12px 0",
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--user-msg-bg)",
        borderLeft: "3px solid var(--accent)",
        position: "relative",
      }}
    >
      <div
        style={{
          fontSize: isMobile ? 12 : 10,
          fontWeight: 600,
          color: "var(--accent)",
          marginBottom: 4,
          fontFamily: "'DM Sans',sans-serif",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {(username ?? "You").toUpperCase()}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = e.target.scrollHeight + "px";
        }}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          resize: "none",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: isMobile ? 15 : 13,
          fontFamily: "'JetBrains Mono',monospace",
          lineHeight: 1.6,
          background: "var(--bg-base)",
          color: "var(--text-secondary)",
          outline: "none",
          minHeight: 40,
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 8,
          justifyContent: "flex-end",
        }}
      >
        <button
          onClick={onCancel}
          style={{
            padding: "4px 14px",
            borderRadius: 6,
            border: "1px solid var(--border-medium)",
            background: "transparent",
            color: "var(--text-muted)",
            fontSize: isMobile ? 14 : 12,
            fontFamily: "'DM Sans',sans-serif",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => text.trim() && onSubmit?.(entryId, text.trim())}
          style={{
            padding: "4px 14px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontSize: isMobile ? 14 : 12,
            fontFamily: "'DM Sans',sans-serif",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function AssistantText({
  content,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  content: string;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  const getText = useCallback(() => content, [content]);
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "10px 14px",
        paddingRight: 40,
        borderRadius: 10,
        background: "var(--bg-subtle)",
        position: "relative",
        fontSize: isMobile ? 15 : undefined,
      }}
    >
      <Markdown content={content} />
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          display: "flex",
          gap: 4,
        }}
      >
        <SpeakButton getText={getText} />
        {isLastInTurn && turnEntries && (
          <CopyButton getText={() => serializeEntries(turnEntries)} />
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({
  content,
  durationMs,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  content: string;
  durationMs?: number;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "4px 0", position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          border: "none",
          background: "transparent",
          color: "var(--text-faint)",
          fontSize: isMobile ? 13 : 11,
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
        }}
      >
        <span
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            display: "inline-block",
          }}
        >
          &#9654;
        </span>
        Thinking...
        {durationMs != null && (
          <DurationLabel ms={durationMs} isMobile={isMobile} />
        )}
      </button>
      {open && (
        <div
          style={{
            margin: "4px 0 4px 20px",
            padding: "8px 12px",
            borderRadius: 8,
            background: "var(--thinking-bg)",
            borderLeft: "2px solid var(--thinking-border)",
            color: "var(--text-faint)",
            fontSize: isMobile ? 14 : 12,
            fontFamily: "'JetBrains Mono',monospace",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            maxHeight: 300,
            overflowY: "auto",
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {content}
        </div>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function ToolCall({
  name,
  input,
  hasResult,
  resultContent,
  resultIsError,
  durationMs,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  name: string;
  input: unknown;
  hasResult?: boolean;
  resultContent?: string;
  resultIsError?: boolean;
  durationMs?: number;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputStr =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const summary = extractToolSummary(name, input);
  // Bash commands that curl the isomux API render as a structured summary
  // (method badge, route, payload fields) instead of raw shell text. The
  // expanded view still shows the raw command and output unchanged.
  const curlReq = useMemo(() => {
    if (name !== "Bash" || !input || typeof input !== "object") return null;
    const command = (input as { command?: unknown }).command;
    return typeof command === "string"
      ? parseIsomuxCurl(command, isomuxUiPorts)
      : null;
  }, [name, input]);
  // Isomux API cards get an accent tint so they read differently from
  // ordinary (green) tool calls; errors stay red either way. The tint uses
  // dedicated --isomux-card-* vars (not raw --accent-bg / --border) so light
  // themes can strengthen it — on white the plain accent tint was too faint
  // to distinguish from the green tool-call background.
  const borderColor = resultIsError
    ? "var(--red)"
    : curlReq
      ? "var(--isomux-card-border)"
      : "var(--green-border)";
  const bgColor = resultIsError
    ? "var(--red-bg)"
    : curlReq
      ? "var(--isomux-card-bg)"
      : "var(--tool-call-bg)";
  const textColor = resultIsError
    ? "var(--red)"
    : curlReq
      ? "var(--text-secondary)"
      : "var(--green)";
  // Errored results are folded (see isFoldedToolResult), so surface the
  // failure inline: first line of the result, attached to the card it
  // belongs to rather than floating at its stream position.
  const errorPreview =
    resultIsError && resultContent
      ? resultContent.trim().split("\n").slice(0, 2).join(" · ")
      : null;

  return (
    <div style={{ margin: "2px 0", position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px",
          paddingRight: isLastInTurn ? 40 : 10,
          border: `1px solid ${borderColor}`,
          borderRadius: 6,
          background: bgColor,
          color: textColor,
          fontSize: isMobile ? 14 : 12,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          width: "100%",
          textAlign: "left",
          ...((curlReq || errorPreview) && { flexWrap: "wrap" as const }),
        }}
      >
        <span
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            display: "inline-block",
            fontSize: 8,
          }}
        >
          &#9654;
        </span>
        {curlReq ? (
          <IsomuxCurlHeader req={curlReq} isMobile={isMobile} />
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>{name}</span>
            {summary && (
              <span
                style={{
                  color: "var(--text-faint)",
                  marginLeft: 4,
                  fontSize: isMobile ? 13 : 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {summary}
              </span>
            )}
          </>
        )}
        {durationMs != null && (
          <DurationLabel ms={durationMs} isMobile={isMobile} />
        )}
        {curlReq && <IsomuxCurlFields req={curlReq} isMobile={isMobile} />}
        {errorPreview && (
          <span
            style={{
              flexBasis: "100%",
              paddingLeft: 20,
              marginTop: 2,
              color: "var(--red)",
              fontSize: isMobile ? 12 : 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {errorPreview}
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            margin: "2px 0 2px 20px",
            padding: "8px 10px",
            borderRadius: 6,
            background: "var(--tool-open-bg)",
            fontSize: isMobile ? 13 : 11,
            fontFamily: "'JetBrains Mono',monospace",
            color: "var(--text-dim)",
            lineHeight: 1.5,
            maxHeight: 300,
            overflowY: "auto",
            overflowX: "auto",
            maxWidth: "100%",
          }}
        >
          <SectionLabel text="Input" isMobile={isMobile} />
          <div style={{ whiteSpace: "pre-wrap" }}>{inputStr}</div>
          {hasResult && (
            <>
              <SectionLabel
                text="Output"
                isMobile={isMobile}
                isError={resultIsError}
                marginTop={10}
              />
              {resultContent && resultContent.length > 0 ? (
                <div style={{ whiteSpace: "pre-wrap" }}>{resultContent}</div>
              ) : (
                <div
                  style={{ color: "var(--text-ghost)", fontStyle: "italic" }}
                >
                  (no output)
                </div>
              )}
            </>
          )}
        </div>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function SectionLabel({
  text,
  isMobile,
  isError,
  marginTop,
}: {
  text: string;
  isMobile?: boolean;
  isError?: boolean;
  marginTop?: number;
}) {
  return (
    <div
      style={{
        fontSize: isMobile ? 11 : 9,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: isError ? "var(--red)" : "var(--text-faint)",
        marginBottom: 4,
        marginTop: marginTop ?? 0,
      }}
    >
      {text}
    </div>
  );
}

function ToolResult({
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
  const [open, setOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const content = entry.content;
  const isLong = content.length > 200;
  const preview = isLong ? content.slice(0, 150) + "..." : content;
  const isError = entry.metadata?.isError === true;
  // We only reach this branch when isFoldedToolResult returned false — i.e.
  // the row has attachments, has no matching call, or is an error. In the
  // attachments-only-paired-success case the text is already in the tool_call
  // expander, so don't duplicate it here.
  const hasMatchingToolCall =
    entry.metadata?.toolUseId != null &&
    !!turnEntries?.some(
      (e) =>
        e.kind === "tool_call" &&
        e.metadata?.toolId === entry.metadata?.toolUseId,
    );
  const showText = !hasMatchingToolCall || isError;
  const borderColor = isError ? "var(--red)" : "var(--green-border)";
  const textColor = isError ? "var(--red)" : "var(--text-dim)";

  return (
    <div
      style={{
        margin: "2px 0 8px 20px",
        padding: "6px 10px",
        borderRadius: 6,
        background: "var(--tool-result-bg)",
        borderLeft: `2px solid ${borderColor}`,
        fontSize: isMobile ? 13 : 11,
        fontFamily: "'JetBrains Mono',monospace",
        color: textColor,
        lineHeight: 1.5,
        position: "relative",
      }}
    >
      {showText && content && (
        <div
          style={{
            whiteSpace: "pre-wrap",
            overflowX: "auto",
            maxWidth: "100%",
          }}
        >
          {open ? content : preview}
        </div>
      )}
      {showText && isLong && (
        <button
          onClick={() => setOpen(!open)}
          style={{
            marginTop: 4,
            padding: "2px 6px",
            border: "none",
            background: "var(--expand-btn)",
            borderRadius: 4,
            color: "var(--text-faint)",
            fontSize: isMobile ? 12 : 10,
            cursor: "pointer",
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
          hasContent={showText && !!content}
        />
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function ErrorBlock({
  content,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  content: string;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--red-bg)",
        borderLeft: "3px solid var(--red)",
        color: "var(--red)",
        fontSize: isMobile ? 14 : 12,
        fontFamily: "'JetBrains Mono',monospace",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        position: "relative",
      }}
    >
      {content}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function SystemMessage({
  content,
  isMobile,
}: {
  content: string;
  isMobile?: boolean;
}) {
  const isMultiline = content.includes("\n");
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "6px 0",
        textAlign: isMultiline ? "left" : "center",
        color: isMultiline ? "var(--text-dim)" : "var(--text-ghost)",
        fontSize: isMultiline ? (isMobile ? 15 : 13) : isMobile ? 13 : 11,
        fontFamily: isMultiline ? "'JetBrains Mono',monospace" : undefined,
        fontStyle: isMultiline ? "normal" : "italic",
        ...(!isMultiline && { whiteSpace: "pre-wrap" }),
      }}
    >
      {isMultiline ? <Markdown content={content} /> : content}
    </div>
  );
}

// One-line background-task lifecycle breadcrumb (metadata.taskEvent on a
// system entry). Same unobtrusive centered style as single-line SystemMessage,
// plus a CSS status dot — a plain <span>, deliberately not a Unicode glyph
// (iOS Safari emoji-renders glyphs like ▶/●, overriding CSS color).
function TaskBreadcrumb({
  content,
  phase,
  isMobile,
}: {
  content: string;
  phase?: string;
  isMobile?: boolean;
}) {
  const dotColor =
    phase === "failed"
      ? "var(--red)"
      : phase === "completed"
        ? "var(--green)"
        : "var(--text-ghost)"; // started / stopped / unknown
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "6px 0",
        textAlign: "center",
        color: "var(--text-ghost)",
        fontSize: isMobile ? 13 : 11,
        fontStyle: "italic",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          marginRight: 6,
          verticalAlign: "middle",
        }}
      />
      {content}
    </div>
  );
}

// Compact card for a tool call auto-denied without an interactive prompt
// (metadata.permissionDenied on a system entry — auto-mode classifier, deny
// rule, dontAsk). Styled distinctly from both SystemMessage and the error
// block: a red-edged card, since the denial is a policy outcome the boss
// should notice, not an agent failure. No Unicode glyph for the marker (iOS
// Safari emoji-renders glyphs, overriding CSS color).
function PermissionDeniedCard({
  denial,
  isMobile,
}: {
  denial: { toolName?: string; message?: string; decisionReason?: string };
  isMobile?: boolean;
}) {
  // Prefer the deciding component's human-readable reason; the message (what
  // the model was told) is the fallback and stays available on hover.
  const reason = denial.decisionReason || denial.message;
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "5px 10px",
        borderLeft: "3px solid var(--red)",
        borderRadius: 4,
        background: "var(--bg-code)",
        fontSize: isMobile ? 13 : 12,
        display: "flex",
        gap: 6,
        alignItems: "baseline",
        flexWrap: "wrap",
      }}
      title={denial.message}
    >
      <span style={{ color: "var(--red)", fontWeight: 600, flexShrink: 0 }}>
        Denied
      </span>
      {denial.toolName && (
        <span
          style={{
            color: "var(--text-primary)",
            fontFamily: "'JetBrains Mono',monospace",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {denial.toolName}
        </span>
      )}
      {reason && (
        <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
          {reason}
        </span>
      )}
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
      return typeof obj.file_path === "string"
        ? obj.file_path
        : extractChangePaths(obj.changes);
    case "Glob":
      return typeof obj.pattern === "string" ? obj.pattern : "";
    case "Grep":
      return typeof obj.pattern === "string" ? obj.pattern : "";
    case "WebSearch":
      return typeof obj.query === "string" ? obj.query : "";
    default:
      return typeof obj.description === "string"
        ? obj.description.slice(0, 60)
        : "";
  }
}

function extractChangePaths(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  const paths = changes
    .map((change) => {
      if (!change || typeof change !== "object") return "";
      const path = (change as { path?: unknown }).path;
      return typeof path === "string" ? path : "";
    })
    .filter(Boolean);
  if (paths.length === 0) return "";
  const first = paths[0];
  return paths.length === 1 ? first : `${first} +${paths.length - 1} more`;
}
