import { StatusShape } from "../components/StatusShape.tsx";
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useId,
  useContext,
  memo,
} from "react";
import type { ReactNode } from "react";
import type {
  LogEntry,
  Attachment,
  SubagentOrigin,
} from "../../shared/types.ts";
import { formatIdentity, isApiTokenDevice } from "../../shared/identity.ts";
import { Markdown } from "./Markdown.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { useI18n, type UiTranslator } from "../i18n.tsx";
import type { Translator } from "../../shared/i18n/translate.ts";
import { SpeakButton } from "../components/SpeakButton.tsx";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { SystemPromptButton } from "../components/SystemPromptButton.tsx";
import { DiffCard } from "./DiffCard.tsx";
import { PlainTaskText, type TaskMap } from "./task-links.tsx";
import { EditRequestCard } from "./EditRequestCard.tsx";
import { FileViewCard } from "./FileViewCard.tsx";
import {
  DownloadButton,
  ImageLightbox,
  type LightboxImage,
} from "./attachment-download.tsx";
import { TerminalCommandCard } from "./TerminalCommandCard.tsx";
import { SecretRequestCard } from "./SecretRequestCard.tsx";
import { BASH_RAW_SUMMARY_CHARS } from "./isomux-curl.ts";
import { IsomuxCurlHeader, IsomuxCurlFields } from "./IsomuxCurlSummary.tsx";
import { AgentAvatar, AgentLink, MemberAvatar } from "./chat-avatars.tsx";
import { jumpToLogEntry } from "./jump-to-entry.ts";
import {
  commandForPermissionDenial,
  isFoldedToolResult,
  isomuxRequestForToolCall,
  DetachedSubagentSteps,
  type DetachedSubagentStep,
} from "./tool-call-groups.ts";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { noTranslate } from "../no-translate.ts";
import { failedEditText } from "../../shared/failed-edit.ts";
import {
  hasLiveTimeParam,
  localizeLogParts,
  logEntryText,
} from "../../shared/i18n/log-message.ts";
import { AskLink, askAnswerText, askRefOf } from "./ask-link.tsx";
import { unescapeDollars } from "./plain-copy.ts";
import {
  parseReviewFindings,
  type ReviewFinding,
} from "../../shared/review-findings.ts";

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
 * made the call rather than the agent itself. Written by backends that expose
 * subagents (see SubagentOrigin); absent on the agent's own calls and on older
 * entries.
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
  detached,
  ownLine,
}: {
  origin: SubagentOrigin;
  isMobile?: boolean;
  // Set for a step that sits after a later member message
  // (detachedSubagentSteps): the pill names the job, says when it runs in
  // the background, and is a button that jumps to the card that started it.
  // Never pass it to a pill inside another button.
  detached?: DetachedSubagentStep;
  // The detached pill has a line of its own, so it may take the full width.
  ownLine?: boolean;
}) {
  const { t } = useI18n();
  const { type, description } = origin;
  const background = detached?.background === true;
  // Both fields are model-authored, so the pill is bounded and ellipsized
  // rather than trusted to be short - the backend's 200-char cap still leaves
  // room for a label that would squeeze a mobile tool row. The full text lives
  // in the hover title, one whole key per combination (ruling 16) with the
  // model's own words as data.
  const title = background
    ? type
      ? description
        ? t("cards.subagent.titleBackgroundTypedDescribed", {
            type,
            description,
          })
        : t("cards.subagent.titleBackgroundTyped", { type })
      : description
        ? t("cards.subagent.titleBackgroundDescribed", { description })
        : t("cards.subagent.titleBackground")
    : type
      ? description
        ? t("cards.subagent.titleTypedDescribed", { type, description })
        : t("cards.subagent.titleTyped", { type })
      : description
        ? t("cards.subagent.titleDescribed", { description })
        : t("cards.subagent.title");
  // A detached step names its job (the description) rather than the
  // subagent's type, so it reads as part of that job.
  const label = background
    ? description
      ? t("cards.subagent.pillBackground", { description })
      : type
        ? t("cards.subagent.pillBackgroundTyped", { type })
        : t("cards.subagent.pillBackgroundPlain")
    : detached && description
      ? t("cards.subagent.pillDescribed", { description })
      : type
        ? t("cards.subagent.pillTyped", { type })
        : t("cards.subagent.pill");
  const style = {
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
  } as const;
  if (!detached)
    return (
      <span title={title} data-subagent-pill="plain" style={style}>
        {label}
      </span>
    );
  return (
    <button
      type="button"
      title={`${title}\n${t("cards.subagent.jumpHint")}`}
      data-subagent-pill={background ? "background" : "detached"}
      data-jump-target={detached.target}
      onClick={() => jumpToLogEntry(detached.target)}
      style={{
        ...style,
        // Its text is the job's name, so it gets more room than the plain
        // pill: a line of its own where it has one, else room beside the card.
        maxWidth: ownLine ? "100%" : 280,
        fontFamily: "'JetBrains Mono',monospace",
        lineHeight: "inherit",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
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

/** Serialize visible conversation entries for the clipboard. */
export function serializeEntries(
  i18n: Translator,
  entries: LogEntry[],
): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind === "user_message") {
      parts.push(e.content);
    } else if (e.kind === "text") {
      parts.push(unescapeDollars(e.content));
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

function SystemEntryCard({
  content,
  button,
}: {
  content: string;
  button: ReactNode;
}) {
  return (
    <div
      style={{
        margin: "4px 0",
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        color: "var(--text-dim)",
        fontSize: 12,
      }}
    >
      <span>
        <InlineMarkdown content={content} />
      </span>
      {button}
    </div>
  );
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
  fileBase,
  isMobile,
}: {
  att: Attachment;
  agentId: string;
  // URL prefix the attachment is served from. Default: this agent's files
  // route; the members chat passes its own.
  fileBase?: string;
  isMobile?: boolean;
}) {
  const isPdf = att.mediaType === "application/pdf";
  const icon = isPdf ? "📄" : "📎";
  const sizeStr = formatFileSize(att.size);
  const href = `${fileBase ?? `/api/files/${agentId}`}/${att.filename}`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: "100%",
      }}
    >
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
          fontFamily: "var(--font-ui)",
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
      <DownloadButton
        src={href}
        name={att.originalName}
        isMobile={isMobile}
        style={{
          boxSizing: "border-box",
          background: "var(--bg-hover)",
          border: "1px solid var(--border)",
          color: "var(--text-secondary)",
        }}
      />
    </span>
  );
}

function AttachmentDisplay({
  attachments,
  agentId,
  fileBase,
  isMobile,
  hasContent,
}: {
  attachments: Attachment[];
  agentId: string;
  fileBase?: string;
  isMobile?: boolean;
  hasContent?: boolean;
}) {
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const images = attachments.filter((a) => a.mediaType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mediaType.startsWith("image/"));

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
            const src = `${fileBase ?? `/api/files/${agentId}`}/${att.filename}`;
            return (
              <div
                key={att.filename}
                style={{ position: "relative", maxWidth: "100%" }}
              >
                <img
                  src={src}
                  alt={att.originalName}
                  onClick={() => setLightbox({ src, name: att.originalName })}
                  style={{
                    display: "block",
                    maxWidth: isMobile ? "100%" : 300,
                    maxHeight: 200,
                    borderRadius: 4,
                    cursor: "pointer",
                    border: "1px solid var(--green-border)",
                  }}
                />
                <DownloadButton
                  src={src}
                  name={att.originalName}
                  isMobile={isMobile}
                  overlay
                />
              </div>
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
              fileBase={fileBase}
              isMobile={isMobile}
            />
          ))}
        </div>
      )}
      {lightbox && (
        <ImageLightbox
          image={lightbox}
          isMobile={isMobile}
          onClose={() => setLightbox(null)}
        />
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
        fontFamily: "var(--font-ui)",
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
// through the same queue and land in the same log: a member typing, another agent
// (sender_agent_*), and one of the agent's own apps (sender_app_name). The
// authority distinction has to survive the chip becoming a log entry, because
// the log is what anyone reads afterwards - and editing someone else's message
// is a human affordance, so a non-human sender's message is not editable.
export function senderIsHuman(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (
    metadata?.sender_agent_name ||
    metadata?.sender_app_name ||
    metadata?.sender_cronjob_name ||
    metadata?.sender_webhook_name
  )
    return false;
  // A personal API token is the human's authority, but the message came from a
  // script rather than the composer, so it reads as machine-sent (and is not
  // editable) like the app, agent and cron senders above.
  return !isApiTokenDevice(metadata?.device as string | undefined);
}

export function describeMessageSender(
  i18n: Translator,
  metadata: Record<string, unknown> | undefined,
): { label: string | undefined; fromHuman: boolean } {
  const senderAgentName = metadata?.sender_agent_name as string | undefined;
  const senderAgentRoom = metadata?.sender_agent_room as string | undefined;
  const senderAppName = metadata?.sender_app_name as string | undefined;
  if (senderAgentName) {
    return {
      label: senderAgentRoom
        ? i18n.t("common.sender.agentInRoom", {
            name: senderAgentName,
            room: senderAgentRoom,
          })
        : i18n.t("common.sender.agent", { name: senderAgentName }),
      fromHuman: false,
    };
  }
  // An app messaging the agent that built it. Same treatment as an agent sender,
  // for a stronger reason: an app is unattended code, so a reader scrolling back
  // must never take its message for the member asking for something.
  if (senderAppName) {
    return {
      label: i18n.t("common.sender.app", { name: senderAppName }),
      fromHuman: false,
    };
  }
  // A scheduled job. Unattended like an app, and it carries no human's
  // authority: without this arm a cron alert renders as the reader's own
  // message ("YOU"), which is exactly the misattribution above.
  const senderCronjobName = metadata?.sender_cronjob_name as string | undefined;
  if (senderCronjobName) {
    return {
      label: i18n.t("common.sender.cronjob", {
        name: senderCronjobName,
      }),
      fromHuman: false,
    };
  }
  // A delivery from an outside service. Not a member, and its JSON is the
  // sender's data, so it must never read as the reader's own message.
  const senderWebhookName = metadata?.sender_webhook_name as string | undefined;
  if (senderWebhookName) {
    return {
      label: i18n.t("common.sender.webhook", { name: senderWebhookName }),
      fromHuman: false,
    };
  }
  const username = metadata?.username as string | undefined;
  const device = metadata?.device as string | undefined;
  return {
    label: formatIdentity({ username, device }) || undefined,
    fromHuman: senderIsHuman(metadata),
  };
}

// Re-renders each minute while `on`: a line with a relative moment ("in 3
// hours") is worded against the clock when shown.
function useMinuteTick(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [on]);
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
  onRestoreFailedEdit,
  onOpenInEditor,
  onCopyToTerminal,
  tasks,
  onOpenTask,
  messageExpanded,
  onToggleMessage,
}: {
  entry: LogEntry;
  messageExpanded?: boolean;
  onToggleMessage?: (entryId: string) => void;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  canEdit?: boolean;
  isEditing?: boolean;
  onStartEdit?: (entryId: string) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (entryId: string, newText: string) => void;
  // Puts the text of a failed edit back in the composer. Passed only to
  // viewers who can edit messages here.
  onRestoreFailedEdit?: (text: string) => void;
  onOpenInEditor?: (path: string) => void;
  onCopyToTerminal?: (command: string) => void;
  tasks?: TaskMap;
  onOpenTask?: (id: string) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  useMinuteTick(hasLiveTimeParam(entry.message));
  // A server-written line in the reader's language (task c37a7365). Only what
  // is shown reads it; the detectors below keep reading entry.content.
  const display = logEntryText(i18n, entry);
  const detached = useContext(DetachedSubagentSteps).get(entry.id);
  switch (entry.kind) {
    case "user_message": {
      const { label: senderLabel, fromHuman } = describeMessageSender(
        i18n,
        entry.metadata,
      );
      // An answer to an ask: the link above it, and a dismiss in the
      // viewer's language (the agent reads the English word).
      const ask = askRefOf(entry);
      const content = askAnswerText(t, ask, entry.content);
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
      // A message from another agent: one compact row. From a member: their
      // avatar before the name.
      const senderAgentName = entry.metadata?.sender_agent_name as
        | string
        | undefined;
      if (senderAgentName) {
        return (
          <PeerMessage
            content={content}
            agentId={entry.metadata?.sender_agent_id as string | undefined}
            agentName={senderAgentName}
            room={entry.metadata?.sender_agent_room as string | undefined}
            isMobile={isMobile}
            expanded={!!messageExpanded}
            onToggle={
              onToggleMessage ? () => onToggleMessage(entry.id) : undefined
            }
            attachments={entry.attachments}
            logAgentId={entry.agentId}
            tasks={tasks}
            onOpenTask={onOpenTask}
            timestamp={entry.timestamp}
          />
        );
      }
      return (
        <UserMessage
          avatar={
            fromHuman ? (
              <MemberAvatar
                username={entry.metadata?.username as string | undefined}
              />
            ) : undefined
          }
          content={content}
          beforeContent={
            ask ? <AskLink ask={ask} isMobile={isMobile} /> : undefined
          }
          renderedContent={
            tasks && onOpenTask ? (
              <PlainTaskText
                content={content}
                tasks={tasks}
                onOpen={onOpenTask}
              />
            ) : undefined
          }
          isMobile={isMobile}
          username={senderLabel}
          fromNonHuman={!fromHuman}
          // Collapse app reports; scheduled-job messages stay fully visible.
          collapsible={!!entry.metadata?.sender_app_name}
          expanded={messageExpanded}
          onToggle={
            onToggleMessage ? () => onToggleMessage(entry.id) : undefined
          }
          attachments={entry.attachments}
          agentId={entry.agentId}
          canEdit={canEdit && fromHuman && !ask}
          onEdit={onStartEdit ? () => onStartEdit(entry.id) : undefined}
          timestamp={entry.timestamp}
        />
      );
    }
    // The chat filters both out (chat-entries.ts); this is only a backstop.
    case "api_token_outbound":
    case "agent_outbound":
      return null;
    case "text":
      return (
        <AssistantText
          content={entry.content}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
          timestamp={entry.timestamp}
          tasks={tasks}
          onOpenTask={onOpenTask}
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
          detached={detached}
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
          detached={detached}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
        />
      );
    }
    case "error":
      return (
        <ErrorBlock
          content={display}
          isLastInTurn={isLastInTurn}
          turnEntries={turnEntries}
          isMobile={isMobile}
          failedEditText={failedEditText(entry.metadata)}
          onRestoreFailedEdit={onRestoreFailedEdit}
        />
      );
    case "system": {
      if (typeof entry.metadata?.helpContent === "string") {
        return (
          <SystemEntryCard
            content={display}
            button={
              <SystemPromptButton
                // The whole body in the reader's language, else the stored
                // English (task c37a7365).
                helpContent={
                  localizeLogParts(i18n, entry.metadata.helpContentMessage) ??
                  entry.metadata.helpContent
                }
              />
            }
          />
        );
      }
      if (entry.metadata?.systemPrompt === true) {
        return (
          <SystemEntryCard
            content={display}
            button={
              <SystemPromptButton
                agentId={entry.agentId}
                cronjobId={
                  typeof entry.metadata?.cronjobId === "string"
                    ? entry.metadata.cronjobId
                    : undefined
                }
              />
            }
          />
        );
      }
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
            content={display}
            phase={taskEvent.phase}
            isMobile={isMobile}
          />
        );
      }
      // A notice from isomux (metadata.notice names it, e.g. "settings"):
      // a system message whatever its line count.
      if (typeof entry.metadata?.notice === "string") {
        return <SystemMessage content={display} isMobile={isMobile} notice />;
      }
      // Subprocess stderr surfaced by a backend adapter (Codex prefixes it
      // "[codex stderr]"). Multiline SystemMessage renders through Markdown
      // and reads as agent prose - stderr needs a log block.
      if (entry.content.startsWith("[codex stderr]")) {
        return <StderrBlock content={entry.content} isMobile={isMobile} />;
      }
      // Claude Code's /code-review output: a fenced JSON findings array.
      const findings = parseReviewFindings(entry.content);
      if (findings) {
        return <ReviewFindingsCard findings={findings} isMobile={isMobile} />;
      }
      return <SystemMessage content={display} isMobile={isMobile} />;
    }
    case "diff": {
      if (!entry.diff)
        return <SystemMessage content={display} isMobile={isMobile} />;
      return <DiffCard payload={entry.diff} />;
    }
    case "edit-request": {
      if (!entry.file || !onOpenInEditor)
        return <SystemMessage content={display} isMobile={isMobile} />;
      return <EditRequestCard payload={entry.file} onOpen={onOpenInEditor} />;
    }
    case "terminal-command": {
      if (!entry.terminal || !onCopyToTerminal)
        return <SystemMessage content={display} isMobile={isMobile} />;
      return (
        <TerminalCommandCard
          payload={entry.terminal}
          onCopy={onCopyToTerminal}
        />
      );
    }
    case "secret-request": {
      if (!entry.secretRequest)
        return <SystemMessage content={display} isMobile={isMobile} />;
      return <SecretRequestCard payload={entry.secretRequest} />;
    }
    case "file-view": {
      if (!entry.attachments || entry.attachments.length === 0)
        return <SystemMessage content={display} isMobile={isMobile} />;
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
          {display}
        </div>
      );
  }
});

function EntryTimestamp({ timestamp }: { timestamp: number }) {
  const { language } = useI18n();
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      title={new Date(timestamp).toISOString()}
      data-message-timestamp=""
      style={{
        color: "var(--text-ghost)",
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: "normal",
        textTransform: "none",
        whiteSpace: "nowrap",
      }}
    >
      {formatDateTime(language, timestamp, "dateTime")}
    </time>
  );
}

/**
 * The date and that bubble's action buttons, as one cluster in the bubble's
 * top right corner. Every bubble kind in the agent chat uses it, so the date
 * reads the same way everywhere (Nil, 2026-09-12).
 *
 * It FLOATS rather than sitting in an absolutely positioned corner: the text
 * wraps around it, so the date costs no line of its own and no line below it
 * runs underneath the date or the buttons. The buttons keep their own flex
 * row inside the cluster, so the gap that separates the date from the buttons
 * never reaches the gap between the buttons themselves. The bubble around it
 * needs `display: flow-root`, which makes the bubble contain the float.
 * Markdown blocks that scroll (code, tables, diagrams, display math) clear
 * the float in ui/styles.ts, so the date never narrows them. Its class
 * paints it above the Markdown box, which is a stacking context so that
 * reply content cannot leave it (task 1b92a224).
 */
function BubbleCorner({
  timestamp,
  children,
}: {
  timestamp?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="bubble-corner"
      style={{
        float: "right",
        display: "flex",
        alignItems: "center",
        gap: TIMESTAMP_GAP,
        marginLeft: TIMESTAMP_GAP,
      }}
    >
      {timestamp !== undefined && <EntryTimestamp timestamp={timestamp} />}
      <div style={{ display: "flex", gap: BUTTON_GAP }}>{children}</div>
    </div>
  );
}

// The gap between the date and the first button. The gap BETWEEN the buttons
// is a separate number and stays what it has always been.
const TIMESTAMP_GAP = 8;
const BUTTON_GAP = 4;

/**
 * The header row of a tool card whose step is detached: the jump pill is a
 * button of its own, so it sits beside the card's toggle button, never
 * inside it - on a phone on its own line above it, where the job's name has
 * room. Other cards render the toggle alone.
 */
function DetachedPillRow({
  subagent,
  detached,
  isMobile,
  children,
}: {
  subagent?: SubagentOrigin;
  detached?: DetachedSubagentStep;
  isMobile?: boolean;
  children: ReactNode;
}) {
  if (!subagent || !detached) return <>{children}</>;
  return (
    <div
      style={{
        display: "flex",
        gap: isMobile ? 2 : 6,
        ...(isMobile
          ? { flexDirection: "column" as const, alignItems: "flex-start" }
          : { alignItems: "center" }),
      }}
    >
      <SubagentPill
        origin={subagent}
        isMobile={isMobile}
        detached={detached}
        ownLine={isMobile}
      />
      {children}
    </div>
  );
}

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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const subagent = subagentOf(entries[0]);
  // A group never spans a member message or two subagents, so its first
  // entry speaks for all of them.
  const detached = useContext(DetachedSubagentSteps).get(entries[0].id);
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
          <StatusShape kind="triangle" rotate={90} />{" "}
          {t("cards.toolCall.groupCount", { count: entries.length })}
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
      <DetachedPillRow
        subagent={subagent}
        detached={detached}
        isMobile={isMobile}
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
            color: "var(--green-text)",
            fontSize: isMobile ? 14 : 12,
            cursor: "pointer",
            fontFamily: "'JetBrains Mono',monospace",
            width: "100%",
            minWidth: 0,
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 8 }}>
            <StatusShape kind="triangle" />
          </span>
          {subagent && !detached && (
            <SubagentPill origin={subagent} isMobile={isMobile} />
          )}
          <span style={{ fontWeight: 600 }}>
            {t("cards.toolCall.groupCount", { count: entries.length })}
          </span>
        </button>
      </DetachedPillRow>
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

function TurnCopyButton({ turnEntries }: { turnEntries?: LogEntry[] }) {
  const i18n = useI18n();
  const getText = useCallback(
    () => (turnEntries ? serializeEntries(i18n, turnEntries) : ""),
    [i18n, turnEntries],
  );
  if (!turnEntries) return null;
  return (
    // Centred, so a one-row card holds it.
    <div
      style={{
        position: "absolute",
        top: "50%",
        right: 8,
        transform: "translateY(-50%)",
      }}
    >
      <CopyButton getText={getText} />
    </div>
  );
}

export function UserMessage({
  variant,
  hideAuthor = false,
  footer,
  beforeContent,
  renderedContent,
  inlineAccessory,
  title,
  content,
  isMobile,
  username,
  fromNonHuman,
  outgoing,
  collapsible = false,
  expanded = false,
  onToggle,
  attachments,
  agentId,
  fileBase,
  avatar,
  extraActions,
  editTitle,
  canEdit,
  onEdit,
  timestamp,
}: {
  variant?: "members-chat";
  hideAuthor?: boolean;
  footer?: ReactNode;
  beforeContent?: ReactNode;
  renderedContent?: ReactNode;
  inlineAccessory?: ReactNode;
  title?: string;
  content: string;
  isMobile?: boolean;
  username?: string;
  // Sender is not a person: another agent, or one of this agent's apps. Drives
  // the muted/dashed/italic treatment that keeps a non-human message from
  // reading like the member.
  fromNonHuman?: boolean;
  // The agent SENT this, rather than received it. Mirrors the card - accent
  // bar on the right and a small left inset - so direction is readable at a
  // glance without reading the header text.
  outgoing?: boolean;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  attachments?: Attachment[];
  agentId?: string;
  // Members chat: attachments live under its own route, a small avatar sits
  // before the author label, a delete control follows the edit button, and
  // the edit is in place rather than a branch. All absent in the agent chat.
  fileBase?: string;
  avatar?: ReactNode;
  extraActions?: ReactNode;
  editTitle?: string;
  canEdit?: boolean;
  onEdit?: () => void;
  timestamp?: number;
}) {
  const { t } = useI18n();
  const getText = useCallback(() => content, [content]);
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const compact = variant === "members-chat";
  const messageFontSize = compact ? 15 : isMobile ? 15 : 13;
  const messageLineHeight = compact ? 1.4 : 1.6;
  const previewHeight = messageFontSize * messageLineHeight * 6;
  useEffect(() => {
    const body = bodyRef.current;
    if (!collapsible || !body) return;
    const measure = () => setOverflows(body.scrollHeight > previewHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [collapsible, previewHeight, content, attachments]);
  const collapsed = collapsible && !expanded;
  const accentColor = fromNonHuman ? "var(--text-muted)" : "var(--accent)";
  const edge = `3px ${fromNonHuman ? "dashed" : "solid"} ${accentColor}`;
  const actions = (
    <>
      {canEdit && onEdit && (
        <button
          data-edit-message=""
          onClick={onEdit}
          title={editTitle ?? t("cards.userMessage.editAndBranch")}
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
            (e.currentTarget.style.color = "var(--accent-text)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = "var(--text-ghost)")
          }
        >
          <EditIcon />
        </button>
      )}
      {extraActions}
      <CopyButton getText={getText} />
    </>
  );
  return (
    <div
      title={title}
      data-members-chat-message={compact ? "" : undefined}
      style={{
        fontFamily: compact ? "var(--font-ui)" : undefined,
        margin: compact
          ? hideAuthor
            ? "2px 0"
            : "8px 0 2px"
          : outgoing
            ? "12px 0 12px 18px"
            : "12px 0",
        padding: compact ? "5px 10px" : "10px 14px",
        ...(compact ? { paddingRight: 70 } : { display: "flow-root" }),
        borderRadius: 10,
        background: "var(--user-msg-bg)",
        ...(compact
          ? {}
          : outgoing
            ? { borderRight: edge }
            : { borderLeft: edge }),
        position: "relative",
      }}
    >
      {!compact && <BubbleCorner timestamp={timestamp}>{actions}</BubbleCorner>}
      {!hideAuthor && (
        <div
          {...noTranslate()}
          data-members-chat-author={compact ? "" : undefined}
          style={{
            fontSize: compact ? 12 : isMobile ? 12 : 10,
            fontWeight: 600,
            color: fromNonHuman ? "var(--text-muted)" : "var(--accent-text)",
            marginBottom: 4,
            textTransform: compact ? "none" : "uppercase",
            letterSpacing: compact ? "normal" : "0.05em",
            fontStyle: fromNonHuman ? "italic" : "normal",
          }}
        >
          {avatar}
          {compact
            ? (username ?? t("common.you"))
            : (username ?? t("common.you")).toUpperCase()}
        </div>
      )}
      {beforeContent}
      <div
        id={bodyId}
        onFocusCapture={() => {
          // Reveal clipped attachments when a keyboard user reaches them.
          if (collapsed && overflows) onToggle?.();
        }}
        style={{
          ...(inlineAccessory
            ? { display: "flex", alignItems: "flex-end", gap: 8 }
            : {}),
          maxHeight: collapsed ? previewHeight : undefined,
          overflow: collapsed ? "hidden" : undefined,
        }}
      >
        <div
          ref={bodyRef}
          style={inlineAccessory ? { flex: 1, minWidth: 0 } : undefined}
        >
          {content && (
            // What a member or agent wrote stays out of page translation.
            <div
              {...noTranslate()}
              style={{
                color: "var(--text-secondary)",
                fontFamily: "var(--font-ui)",
                fontSize: messageFontSize,
                lineHeight: messageLineHeight,
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                wordBreak: "break-word",
              }}
            >
              {renderedContent ?? content}
            </div>
          )}
          {attachments && attachments.length > 0 && (agentId || fileBase) && (
            <AttachmentDisplay
              attachments={attachments}
              agentId={agentId ?? ""}
              fileBase={fileBase}
              isMobile={isMobile}
              hasContent={!!content}
            />
          )}
        </div>
        {inlineAccessory}
      </div>
      {footer}
      {collapsible && overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          style={{
            display: "block",
            marginTop: 6,
            padding: isMobile ? "8px 0" : "4px 0",
            border: "none",
            background: "transparent",
            color: "var(--accent-text)",
            fontSize: isMobile ? 14 : 12,
            cursor: "pointer",
          }}
        >
          {t(
            expanded
              ? "cards.userMessage.collapse"
              : "cards.userMessage.expand",
          )}
        </button>
      )}
      {/* Members chat keeps its buttons in the corner, above the text, and
          shows no date in the bubble. */}
      {compact && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: BUTTON_GAP,
          }}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

// A message from another agent, compact: the sender's avatar, linked name and
// room lead the first line, the text follows on the same line with its line
// breaks folded, and the chevron opens the full text.
function PeerMessage({
  content,
  agentId,
  agentName,
  room,
  isMobile,
  expanded,
  onToggle,
  attachments,
  logAgentId,
  tasks,
  onOpenTask,
  timestamp,
}: {
  content: string;
  agentId?: string;
  agentName: string;
  room?: string;
  isMobile?: boolean;
  expanded: boolean;
  onToggle?: () => void;
  attachments?: Attachment[];
  logAgentId: string;
  tasks?: TaskMap;
  onOpenTask?: (id: string) => void;
  timestamp: number;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const getText = useCallback(() => content, [content]);
  const fontSize = isMobile ? 14 : 13;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    const measure = () =>
      setOverflows(
        body.scrollHeight > body.clientHeight + 1 || content.includes("\n"),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [content, expanded]);
  const canToggle = !!onToggle && (overflows || expanded);
  return (
    <div
      data-peer-message=""
      style={{
        margin: "4px 0",
        padding: "5px 12px",
        borderRadius: 8,
        background: "var(--user-msg-bg)",
        borderLeft: "3px dashed var(--text-muted)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div
          ref={bodyRef}
          id={bodyId}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-ui)",
            fontSize,
            lineHeight: 1.45,
            color: "var(--text-secondary)",
            overflowWrap: "break-word",
            ...(expanded
              ? { whiteSpace: "pre-wrap" }
              : {
                  display: "-webkit-box",
                  WebkitLineClamp: isMobile ? 3 : 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }),
          }}
        >
          <span
            {...noTranslate()}
            style={{
              fontWeight: 600,
              color: "var(--text-muted)",
              marginRight: 8,
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>
              <AgentAvatar agentId={agentId} />
              <AgentLink agentId={agentId}>{agentName}</AgentLink>
            </span>
            {room && (expanded || !isMobile) && (
              <span style={{ fontWeight: 400, color: "var(--text-faint)" }}>
                {" "}
                · {room}
              </span>
            )}
          </span>
          {expanded && "\n"}
          <span {...noTranslate()}>
            {!expanded ? (
              content.replace(/\s*\n+\s*(?:[-*]\s+)?/g, " · ")
            ) : tasks && onOpenTask ? (
              <PlainTaskText
                content={content}
                tasks={tasks}
                onOpen={onOpenTask}
              />
            ) : (
              content
            )}
          </span>
        </div>
        <BubbleCorner timestamp={timestamp}>
          {canToggle && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              title={t(
                expanded
                  ? "cards.userMessage.collapse"
                  : "cards.userMessage.expand",
              )}
              onClick={onToggle}
              style={{
                background: "transparent",
                border: "none",
                padding: 2,
                cursor: "pointer",
                color: "var(--text-muted)",
                display: "flex",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  transform: expanded ? "rotate(180deg)" : undefined,
                  transition: "transform 0.15s",
                }}
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
          )}
          <CopyButton getText={getText} />
        </BubbleCorner>
      </div>
      {attachments && attachments.length > 0 && (
        <AttachmentDisplay
          attachments={attachments}
          agentId={logAgentId}
          isMobile={isMobile}
          hasContent={!!content}
        />
      )}
    </div>
  );
}

export function EditableUserMessage({
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
  const { t } = useI18n();
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
        {...noTranslate()}
        style={{
          fontSize: isMobile ? 12 : 10,
          fontWeight: 600,
          color: "var(--accent-text)",
          marginBottom: 4,
          fontFamily: "var(--font-ui)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {(username ?? t("common.you")).toUpperCase()}
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
          fontFamily: "var(--font-ui)",
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
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={() => text.trim() && onSubmit?.(entryId, text.trim())}
          style={{
            padding: "4px 14px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent-text)",
            color: "var(--bg-base)",
            fontSize: isMobile ? 14 : 12,
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {t("common.send")}
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
  timestamp,
  tasks,
  onOpenTask,
}: {
  content: string;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  timestamp: number;
  tasks?: TaskMap;
  onOpenTask?: (id: string) => void;
}) {
  const i18n = useI18n();
  const getText = useCallback(() => content, [content]);
  return (
    // The agent's words stay out of page translation; the corner controls are
    // already in the reader's language.
    <div
      {...noTranslate()}
      style={{
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--bg-subtle)",
        position: "relative",
        display: "flow-root",
        fontSize: isMobile ? 15 : undefined,
      }}
    >
      <BubbleCorner timestamp={timestamp}>
        <SpeakButton getText={getText} />
        {isLastInTurn && turnEntries && (
          <CopyButton getText={() => serializeEntries(i18n, turnEntries)} />
        )}
      </BubbleCorner>
      <Markdown content={content} tasks={tasks} onOpenTask={onOpenTask} />
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
  const { t } = useI18n();
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
          <StatusShape kind="triangle" />
        </span>
        {t("cards.thinking.label")}
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
            fontFamily: "var(--font-ui)",
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
  detached,
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
  detached?: DetachedSubagentStep;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const inputStr =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const summary = extractToolSummary(t, name, input);
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
    ? "var(--red-text)"
    : curlReq
      ? "var(--text-secondary)"
      : "var(--green-text)";
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
      <DetachedPillRow
        subagent={subagent}
        detached={detached}
        isMobile={isMobile}
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
            minWidth: 0,
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
            <StatusShape kind="triangle" />
          </span>
          {subagent && !detached && (
            <SubagentPill origin={subagent} isMobile={isMobile} />
          )}
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
                color: "var(--red-text)",
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
      </DetachedPillRow>
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
          <SectionLabel text={t("cards.toolCall.input")} isMobile={isMobile} />
          <div style={{ whiteSpace: "pre-wrap" }}>{inputStr}</div>
          {hasResult && (
            <>
              <SectionLabel
                text={t("cards.toolCall.output")}
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
                  {t("cards.tool.noOutput")}
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
        color: isError ? "var(--red-text)" : "var(--text-faint)",
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
  detached,
  isLastInTurn,
  turnEntries,
  isMobile,
}: {
  entry: LogEntry;
  detached?: DetachedSubagentStep;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [echoOpen, setEchoOpen] = useState(false);
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
  // path notices) and is already rendered above as the
  // user's upload - a full re-render just mirrors it back. Collapse to a
  // click-to-expand chip instead. Images read from anywhere else (agent
  // screenshots, repo files) keep the full render: there the member can't
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
  const textColor = isError ? "var(--red-text)" : "var(--text-dim)";
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
          <SubagentPill
            origin={subagent}
            isMobile={isMobile}
            detached={detached}
            ownLine
          />
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
          {open
            ? t("cards.toolResult.showLess")
            : t("cards.toolResult.showMore")}
        </button>
      )}
      {entry.attachments &&
        entry.attachments.length > 0 &&
        (isAttachmentEcho && !echoOpen ? (
          <button
            onClick={() => setEchoOpen(true)}
            title={t("cards.fileView.earlierAttachment")}
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
            {/* Two whole frames, one per branch: a named file, or a count of
                images. Never a sentence joined around the data. */}
            {entry.attachments.length === 1
              ? t("cards.fileView.viewedFile", {
                  file: entry.attachments[0].originalName,
                })
              : t("cards.fileView.viewedImages", {
                  count: entry.attachments.length,
                })}
          </button>
        ) : (
          <AttachmentDisplay
            attachments={entry.attachments}
            agentId={entry.agentId}
            isMobile={isMobile}
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
  failedEditText,
  onRestoreFailedEdit,
}: {
  content: string;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  // The edited text of a failed edit (FAILED_EDIT_TEXT_KEY), kept in the log.
  failedEditText?: string | null;
  onRestoreFailedEdit?: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--red-bg)",
        borderLeft: "3px solid var(--red)",
        color: "var(--red-text)",
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
      {failedEditText && (
        <div
          data-failed-edit-text=""
          style={{
            marginTop: 8,
            padding: "6px 10px",
            borderRadius: 6,
            background: "var(--bg-code)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
          }}
        >
          {failedEditText}
        </div>
      )}
      {failedEditText && onRestoreFailedEdit && (
        <button
          type="button"
          data-restore-failed-edit=""
          onClick={() => onRestoreFailedEdit(failedEditText)}
          style={{
            marginTop: 8,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            fontSize: isMobile ? 13 : 11,
            cursor: "pointer",
          }}
        >
          {t("cards.failedEdit.restore")}
        </button>
      )}
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}

// Raw subprocess stderr (system entries prefixed "[codex stderr]"): a dim
// monospace log block, never Markdown. Entries persisted
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

// A multi-line entry is command output (/help, /context) and renders as
// Markdown; a `notice` keeps the one-line style and its line breaks.
function SystemMessage({
  content,
  isMobile,
  notice,
}: {
  content: string;
  isMobile?: boolean;
  notice?: boolean;
}) {
  const isMultiline = !notice && content.includes("\n");
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
// block: a red-edged card, since the denial is a policy outcome the member
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
  const { t } = useI18n();
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
      <span
        style={{ color: "var(--red-text)", fontWeight: 600, flexShrink: 0 }}
      >
        {t("cards.toolCall.denied")}
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
            color: "var(--green-text)",
            fontSize: 12,
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={t("cards.terminalCommand.copyHint")}
        >
          {t("cards.terminalCommand.copy")}
        </button>
      )}
    </div>
  );
}

// Claude Code's /code-review findings (shared/review-findings.ts), one row
// each in the PermissionDeniedCard style. Verdict, category and outcome are
// protocol values, shown as they arrive.
function ReviewFindingsCard({
  findings,
  isMobile,
}: {
  findings: ReviewFinding[];
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  if (findings.length === 0) {
    return (
      <SystemMessage
        content={t("cards.reviewFindings.none")}
        isMobile={isMobile}
      />
    );
  }
  return (
    <div style={{ margin: "8px 0" }} data-review-findings="">
      {findings.map((finding, i) => (
        <ReviewFindingRow key={i} finding={finding} isMobile={isMobile} />
      ))}
    </div>
  );
}

const BADGE_COLORS: Record<string, string> = {
  CONFIRMED: "var(--red-text)",
  PLAUSIBLE: "var(--orange-text)",
  fixed: "var(--green-text)",
};

function FindingBadge({ value }: { value: string }) {
  return (
    <span
      data-finding-badge={value}
      style={{
        color: BADGE_COLORS[value] ?? "var(--text-faint)",
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        flexShrink: 0,
      }}
    >
      {value}
    </span>
  );
}

function ReviewFindingRow({
  finding,
  isMobile,
}: {
  finding: ReviewFinding;
  isMobile?: boolean;
}) {
  const location =
    finding.file === undefined
      ? undefined
      : finding.line === undefined
        ? finding.file
        : `${finding.file}:${finding.line}`;
  // short_summary is the headline when present; summary then shows under it.
  const headline = finding.shortSummary ?? finding.summary;
  const detail =
    finding.shortSummary !== undefined ? finding.summary : undefined;
  const badges = [finding.verdict, finding.category, finding.outcome].filter(
    (value): value is string => value !== undefined,
  );
  return (
    <div
      data-review-finding=""
      style={{
        margin: "4px 0",
        padding: "6px 10px",
        borderLeft: "3px solid var(--orange)",
        borderRadius: 4,
        background: "var(--bg-code)",
        fontSize: isMobile ? 13 : 12,
        lineHeight: 1.5,
        overflowWrap: "anywhere",
      }}
    >
      {(badges.length > 0 || location) && (
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "baseline",
            flexWrap: "wrap",
            marginBottom: 2,
          }}
        >
          {badges.map((value, i) => (
            <FindingBadge key={i} value={value} />
          ))}
          {location && (
            <span
              data-finding-location=""
              style={{
                color: "var(--text-primary)",
                fontFamily: "'JetBrains Mono',monospace",
                fontWeight: 600,
              }}
            >
              {location}
            </span>
          )}
        </div>
      )}
      {headline && (
        // .md-content paints var(--text-secondary): re-point it per block.
        <div
          data-finding-headline=""
          style={{ ["--text-secondary" as string]: "var(--text-primary)" }}
        >
          <Markdown content={headline} />
        </div>
      )}
      {detail && (
        <div data-finding-detail="" style={{ marginTop: 2 }}>
          <Markdown content={detail} />
        </div>
      )}
      {finding.failureScenario && (
        <div
          style={{
            ["--text-secondary" as string]: "var(--text-dim)",
            marginTop: 2,
          }}
        >
          <Markdown content={finding.failureScenario} />
        </div>
      )}
      {finding.extras.map(([key, value]) => (
        <div
          key={key}
          data-finding-extra={key}
          style={{
            color: "var(--text-dim)",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: isMobile ? 12 : 11,
            marginTop: 2,
            whiteSpace: "pre-wrap",
          }}
        >
          {key}: {value}
        </div>
      ))}
    </div>
  );
}

function extractToolSummary(
  t: UiTranslator["t"],
  toolName: string,
  input: unknown,
): string {
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
        : extractChangePaths(t, obj.changes);
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

function extractChangePaths(t: UiTranslator["t"], changes: unknown): string {
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
  return paths.length === 1
    ? first
    : t("cards.tool.morePaths", { path: first, count: paths.length - 1 });
}
