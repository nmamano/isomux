import { useState, useCallback, useRef, useEffect, useMemo, memo } from "react";
import type {
  LogEntry,
  Attachment,
  SubagentOrigin,
} from "../../shared/types.ts";
import { formatIdentity, isApiTokenDevice } from "../../shared/identity.ts";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { SpeakButton } from "../components/SpeakButton.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { EditRequestCard } from "./EditRequestCard.tsx";
import { FileViewCard } from "./FileViewCard.tsx";
import { TerminalCommandCard } from "./TerminalCommandCard.tsx";
import { BASH_RAW_SUMMARY_CHARS } from "./isomux-curl.ts";
import { IsomuxCurlHeader, IsomuxCurlFields } from "./IsomuxCurlSummary.tsx";
import {
  commandForPermissionDenial,
  isFoldedToolResult,
  isomuxRequestForToolCall,
} from "./tool-call-groups.ts";

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
 * Subagent origin of a tool_call / tool_result row, when the agent's SUBAGENT
 * made the call rather than the agent itself. Written by both backends (see
 * SubagentOrigin); absent on the agent's own calls and on older entries.
 */
function subagentOf(entry: LogEntry): SubagentOrigin | undefined {
  const origin = entry.metadata?.subagent as SubagentOrigin | undefined;
  return origin?.parentToolUseId ? origin : undefined;
}

/**
 * Marks a card as a subagent's work. A subagent (Claude's Agent/Task tool, or
 * a Codex collab child thread) runs its own tool calls surfaced on the
 * parent's stream, so without this the subagent's Bash/Read run reads as the
 * agent's own.
 */
function SubagentPill({
  origin,
  isMobile,
}: {
  origin: SubagentOrigin;
  isMobile?: boolean;
}) {
  // Both fields are model-authored, so the pill is bounded and ellipsized
  // rather than trusted to be short - the backend's 200-char cap still leaves
  // room for a label that would squeeze a mobile tool row. The full text lives
  // in the hover title, composed here rather than passed through raw.
  const title =
    `Subagent${origin.type ? ` (${origin.type})` : ""}` +
    (origin.description ? `: ${origin.description}` : "");
  return (
    <span
      title={title}
      style={{
        flexShrink: 0,
        maxWidth: isMobile ? 120 : 160,
        overflow: "hidden",
        textOverflow: "ellipsis",
        padding: "0 5px",
        borderRadius: 4,
        border: "1px solid var(--border-light)",
        background: "var(--bg-subtle)",
        color: "var(--text-dim)",
        fontSize: isMobile ? 11 : 10,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {origin.type ? `subagent · ${origin.type}` : "subagent"}
    </span>
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

// Who sent a `user_message`, from the metadata the server stamped on it - and
// whether that sender is a HUMAN, which is what the styling and the edit
// affordance key on.
//
// A user_message is not always a person. Three kinds of sender reach an agent
// through the same queue and land in the same log: a boss typing, another agent
// (sender_agent_*), and one of the agent's own apps (sender_app_name). The
// authority distinction has to survive the chip becoming a log entry, because
// the log is what anyone reads afterwards - and editing someone else's message
// is a human affordance, so a non-human sender's message is not editable.
//
// Exported for its own test: the UI has no React render harness, so the mapping
// is pinned as a pure function (same pattern as ContextBattery's bandColor).
export function describeMessageSender(
  metadata: Record<string, unknown> | undefined,
): { label: string | undefined; fromHuman: boolean } {
  const senderAgentName = metadata?.sender_agent_name as string | undefined;
  const senderAgentRoom = metadata?.sender_agent_room as string | undefined;
  const senderAppName = metadata?.sender_app_name as string | undefined;
  if (senderAgentName) {
    return {
      label: `${senderAgentName} · agent${senderAgentRoom ? ` · Room "${senderAgentRoom}"` : ""}`,
      fromHuman: false,
    };
  }
  // An app messaging the agent that built it. Same treatment as an agent sender,
  // for a stronger reason: an app is unattended code, so a reader scrolling back
  // must never take its message for the boss asking for something.
  if (senderAppName) {
    return { label: `${senderAppName} · app`, fromHuman: false };
  }
  // A scheduled job. Unattended like an app, and it carries no human's
  // authority: without this arm a cron alert renders as the reader's own
  // message ("YOU"), which is exactly the misattribution above.
  const senderCronjobName = metadata?.sender_cronjob_name as string | undefined;
  if (senderCronjobName) {
    return { label: `${senderCronjobName} · cron job`, fromHuman: false };
  }
  const username = metadata?.username as string | undefined;
  const device = metadata?.device as string | undefined;
  return {
    label: formatIdentity({ username, device }) || undefined,
    // A personal API token is the human's authority, but the message came from
    // a script rather than the composer, so it reads as machine-sent (and is
    // not editable) like the app, agent and cron senders above.
    fromHuman: !isApiTokenDevice(device),
  };
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
      const { label: senderLabel, fromHuman } = describeMessageSender(
        entry.metadata,
      );
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
          fromNonHuman={!fromHuman}
          attachments={entry.attachments}
          agentId={entry.agentId}
          canEdit={canEdit && fromHuman}
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
          subagent={subagentOf(entry)}
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
        | {
            toolUseId?: string;
            toolName?: string;
            message?: string;
            decisionReason?: string;
          }
        | undefined;
      if (permissionDenied) {
        return (
          <PermissionDeniedCard
            denial={permissionDenied}
            turnEntries={turnEntries}
            onCopyToTerminal={onCopyToTerminal}
            isMobile={isMobile}
          />
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
      // Subprocess stderr surfaced by a backend adapter (Codex prefixes it
      // "[codex stderr]"). Multiline SystemMessage renders through Markdown
      // and reads as agent prose - stderr needs a log block (task ebe1bc1e).
      if (entry.content.startsWith("[codex stderr]")) {
        return <StderrBlock content={entry.content} isMobile={isMobile} />;
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
      // to the captured page's sanitized URL - show it as a caption. Other
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

export function RawToolCallGroupCard({
  entries,
  isLastInTurn,
  turnEntries,
  isMobile,
  onCopyToTerminal,
}: {
  entries: LogEntry[];
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  onCopyToTerminal?: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const subagent = subagentOf(entries[0]);
  if (open) {
    return (
      <div>
        <button
          onClick={() => setOpen(false)}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-dim)",
            cursor: "pointer",
            fontSize: isMobile ? 13 : 11,
            padding: "2px 8px",
          }}
        >
          &#9660; {entries.length} tool calls
        </button>
        {entries.map((entry, index) => (
          <LogEntryCard
            key={entry.id}
            entry={entry}
            isLastInTurn={isLastInTurn && index === entries.length - 1}
            turnEntries={turnEntries}
            isMobile={isMobile}
            onCopyToTerminal={onCopyToTerminal}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      style={{
        margin: "2px 0",
        position: "relative",
        ...(subagent && {
          marginLeft: 12,
          paddingLeft: 8,
          borderLeft: "2px solid var(--border-light)",
        }),
      }}
    >
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px",
          paddingRight: isLastInTurn ? 40 : 10,
          border: "1px solid var(--green-border)",
          borderRadius: 6,
          background: "var(--tool-call-bg)",
          color: "var(--green)",
          fontSize: isMobile ? 14 : 12,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          width: "100%",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 8 }}>&#9654;</span>
        {subagent && <SubagentPill origin={subagent} isMobile={isMobile} />}
        <span style={{ fontWeight: 600 }}>{entries.length} tool calls</span>
      </button>
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
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

function UserMessage({
  content,
  isMobile,
  username,
  fromNonHuman,
  attachments,
  agentId,
  canEdit,
  onEdit,
}: {
  content: string;
  isMobile?: boolean;
  username?: string;
  // Sender is not a person: another agent, or one of this agent's apps. Drives
  // the muted/dashed/italic treatment that keeps a non-human message from
  // reading like the boss.
  fromNonHuman?: boolean;
  attachments?: Attachment[];
  agentId?: string;
  canEdit?: boolean;
  onEdit?: () => void;
}) {
  const getText = useCallback(() => content, [content]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const accentColor = fromNonHuman ? "var(--text-muted)" : "var(--accent)";
  return (
    <div
      style={{
        margin: "12px 0",
        padding: "10px 14px",
        paddingRight: 40,
        borderRadius: 10,
        background: "var(--user-msg-bg)",
        borderLeft: `3px ${fromNonHuman ? "dashed" : "solid"} ${accentColor}`,
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
          fontStyle: fromNonHuman ? "italic" : "normal",
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
  subagent,
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
  subagent?: SubagentOrigin;
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
  const curlReq = useMemo(
    () => isomuxRequestForToolCall(name, input),
    [name, input],
  );
  // Isomux API cards get an accent tint so they read differently from
  // ordinary (green) tool calls; errors stay red either way. The tint uses
  // dedicated --isomux-card-* vars (not raw --accent-bg / --border) so light
  // themes can strengthen it - on white the plain accent tint was too faint
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
    <div
      style={{
        margin: "2px 0",
        position: "relative",
        // Subagent calls step in behind a rule, so a run of them reads as one
        // block instead of as the agent's own work interleaved at top level.
        ...(subagent && {
          marginLeft: 12,
          paddingLeft: 8,
          borderLeft: "2px solid var(--border-light)",
        }),
      }}
    >
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
        {subagent && <SubagentPill origin={subagent} isMobile={isMobile} />}
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
        fontSize: isMobile ? 11 : 10,
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
  const [echoOpen, setEchoOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const content = entry.content;
  const isLong = content.length > 200;
  const preview = isLong ? content.slice(0, 150) + "..." : content;
  const isError = entry.metadata?.isError === true;
  // We only reach this branch when isFoldedToolResult returned false - i.e.
  // the row has attachments, has no matching call, or is an error. In the
  // attachments-only-paired-success case the text is already in the tool_call
  // expander, so don't duplicate it here.
  const pairedToolCall =
    entry.metadata?.toolUseId != null
      ? turnEntries?.find(
          (e) =>
            e.kind === "tool_call" &&
            e.metadata?.toolId === entry.metadata?.toolUseId,
        )
      : undefined;
  const hasMatchingToolCall = !!pairedToolCall;
  // Attachment echo: when the agent Reads an image out of its OWN attachment
  // directory, that file arrived through this very chat (attachments are
  // path-notices since task 353e2e66) and is already rendered above as the
  // user's upload - a full re-render just mirrors it back. Collapse to a
  // click-to-expand chip instead. Images read from anywhere else (agent
  // screenshots, repo files) keep the full render: there the boss can't
  // otherwise know what the agent is looking at.
  const calledPathRaw = (
    pairedToolCall?.metadata?.input as { file_path?: unknown } | undefined
  )?.file_path;
  const isAttachmentEcho =
    typeof calledPathRaw === "string" &&
    (calledPathRaw.includes(`/logs/${entry.agentId}/files/`) ||
      calledPathRaw.includes(`/logs/${entry.agentId}/images/`));
  const showText = !hasMatchingToolCall || isError;
  const borderColor = isError ? "var(--red)" : "var(--green-border)";
  const textColor = isError ? "var(--red)" : "var(--text-dim)";
  // Only unpaired or errored results reach this branch; the rest fold into
  // their tool_call card, which carries the pill itself.
  const subagent = subagentOf(entry);

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
        // Line up under the indented subagent tool_call card above it.
        ...(subagent && { marginLeft: 32 }),
      }}
    >
      {subagent && (
        <div style={{ marginBottom: 4 }}>
          <SubagentPill origin={subagent} isMobile={isMobile} />
        </div>
      )}
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
      {entry.attachments &&
        entry.attachments.length > 0 &&
        (isAttachmentEcho && !echoOpen ? (
          <button
            onClick={() => setEchoOpen(true)}
            title="The agent viewed a file attached earlier in this chat. Click to show it."
            style={{
              display: "block",
              marginTop: showText && content ? 6 : 0,
              padding: "2px 8px",
              border: "1px solid var(--border-light)",
              background: "var(--expand-btn)",
              borderRadius: 4,
              color: "var(--text-faint)",
              fontSize: isMobile ? 12 : 10,
              cursor: "pointer",
            }}
          >
            Viewed{" "}
            {entry.attachments.length === 1
              ? entry.attachments[0].originalName
              : `${entry.attachments.length} attached images`}{" "}
            (click to show)
          </button>
        ) : (
          <AttachmentDisplay
            attachments={entry.attachments}
            agentId={entry.agentId}
            isMobile={isMobile}
            lightboxSrc={lightboxSrc}
            setLightboxSrc={setLightboxSrc}
            hasContent={showText && !!content}
          />
        ))}
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

// Raw subprocess stderr (system entries prefixed "[codex stderr]"): a dim
// monospace log block, never Markdown (task ebe1bc1e). Entries persisted
// before the server-side ANSI stripping still carry escape codes, so they
// are stripped here too.
function StderrBlock({
  content,
  isMobile,
}: {
  content: string;
  isMobile?: boolean;
}) {
  // eslint-disable-next-line no-control-regex -- ESC is the point here
  const clean = content.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--bg-code)",
        borderLeft: "3px solid var(--border)",
        color: "var(--text-dim)",
        fontSize: isMobile ? 13 : 12,
        fontFamily: "'JetBrains Mono',monospace",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
      }}
    >
      {clean}
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
// plus a CSS status dot - a plain <span>, deliberately not a Unicode glyph
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
// (metadata.permissionDenied on a system entry - auto-mode classifier, deny
// rule, dontAsk). Styled distinctly from both SystemMessage and the error
// block: a red-edged card, since the denial is a policy outcome the boss
// should notice, not an agent failure. No Unicode glyph for the marker (iOS
// Safari emoji-renders glyphs, overriding CSS color).
function PermissionDeniedCard({
  denial,
  turnEntries,
  onCopyToTerminal,
  isMobile,
}: {
  denial: {
    toolUseId?: string;
    toolName?: string;
    message?: string;
    decisionReason?: string;
  };
  turnEntries?: LogEntry[];
  onCopyToTerminal?: (command: string) => void;
  isMobile?: boolean;
}) {
  // Prefer the deciding component's human-readable reason; the message (what
  // the model was told) is the fallback and stays available on hover.
  const reason = denial.decisionReason || denial.message;
  const command = commandForPermissionDenial(denial, turnEntries);
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
      {command && onCopyToTerminal && (
        <button
          onClick={() => onCopyToTerminal(command)}
          style={{
            marginLeft: "auto",
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid var(--green-border)",
            background: "var(--green-bg)",
            color: "var(--green)",
            fontSize: 12,
            fontFamily: "'JetBrains Mono',monospace",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title="Open the terminal panel and type this command at the prompt (not auto-executed)"
        >
          Copy to terminal
        </button>
      )}
    </div>
  );
}

function extractToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case "Bash":
      // Isomux curl cards are bounded against this budget so a card never
      // conceals more of a command than this row would - see MAX_TAIL_DISPLAY
      // in isomux-curl.ts before changing it.
      return typeof obj.command === "string"
        ? obj.command.slice(0, BASH_RAW_SUMMARY_CHARS)
        : "";
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
