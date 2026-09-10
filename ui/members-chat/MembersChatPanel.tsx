// The members chat panel: the office-wide, humans-only stream on the Lobby tab.
//
// It is the agent chat's own message card (UserMessage / EditableUserMessage
// from the log view) over a store slice that a REST page hydrates and the
// members_chat_* wire events keep live, plus a composer with the agent chat's
// shape: paperclip, paste and drop uploads, staged chips, Enter to send.
//
// What differs from the agent chat, on purpose: an edit rewrites in place (no
// branch), a message can be deleted (own, or any for an office owner), the
// group header carries a time and a small ghost of the author. Human
// continuations keep their own time in a title; non-human messages keep
// their author line on every message. The list pages older messages at the
// top instead of holding the whole history.

import { membersChatExcerpt } from "../../shared/members-chat.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Attachment, MembersChatMessage } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { formatDateTime } from "../../shared/i18n/time.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import type {
  Translator,
  PlainMessageKey,
} from "../../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import { ApiError } from "../api.ts";
import { MEMBERS_CHAT_MAX_CHARS } from "../../shared/types.ts";
import { formatIdentity } from "../../shared/identity.ts";
import { defaultGhostColorForUserId } from "../../shared/avatar.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { PinnedMessageStrip } from "./PinnedMessageStrip.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { ReplyQuote } from "./ReplyQuote.tsx";
import { InlineMarkdown } from "./InlineMarkdown.tsx";
import { ThumbsUpReaction } from "./ThumbsUpReaction.tsx";
import { UserMessage, EditableUserMessage } from "../log-view/LogEntryCard.tsx";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { getDevice } from "../device-settings.ts";
import * as chatApi from "./api.ts";
import {
  MEMBERS_CHAT_FILES_BASE,
  MEMBERS_CHAT_PAGE_LIMIT as PAGE_LIMIT,
} from "./api.ts";

// The char counter appears once a draft is this close to the cap.
const COUNTER_FROM = MEMBERS_CHAT_MAX_CHARS - 500;

// The author label the card prints. A person reads as
// "Nil (Phone)"; an API token and an agent read as machine-sent, the way the
// agent chat styles them, so nobody scrolling back takes a script's line for a
// boss's.
export function describeMembersChatAuthor(
  m: Pick<MembersChatMessage, "kind" | "userName" | "device">,
  t: Translator["t"],
): {
  label: string;
  nonHuman: boolean;
} {
  if (m.kind === "agent")
    return {
      label: t("membersChat.authorAgent", { name: m.userName }),
      nonHuman: true,
    };
  if (m.kind === "api") {
    return {
      label: m.device
        ? t("membersChat.authorApiDevice", {
            name: m.userName,
            device: m.device,
          })
        : t("membersChat.authorApi", { name: m.userName }),
      nonHuman: true,
    };
  }
  return {
    label: formatIdentity({ username: m.userName, device: m.device }),
    nonHuman: false,
  };
}

// "14:02" today, "Sep 5, 14:02" this year, "Sep 5 2025" before that.
export function formatWhen(
  language: SupportedLanguageCode,
  ts: number,
  now = Date.now(),
): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  return formatDateTime(
    language,
    ts,
    sameDay
      ? "clock24"
      : d.getFullYear() === n.getFullYear()
        ? "monthDayTime24"
        : "fullDate",
  );
}

interface Staged {
  id: string;
  originalName: string;
  mediaType: string;
  size: number;
  filename?: string;
  uploading: boolean;
  error?: ChatError;
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

// Two clicks to delete: the first turns the icon into a "sure?" that expires
// on its own, so a stray click never removes a line and no dialog interrupts.
function DeleteControl({ onConfirm }: { onConfirm: () => void }) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={() => {
        if (armed) onConfirm();
        else setArmed(true);
      }}
      title={armed ? t("membersChat.deleteAgain") : t("common.delete")}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: armed ? "var(--red)" : "var(--text-ghost)",
        padding: 2,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontFamily: "'DM Sans',sans-serif",
        fontWeight: 600,
        transition: "color 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!armed) e.currentTarget.style.color = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        if (!armed) e.currentTarget.style.color = "var(--text-ghost)";
      }}
    >
      <TrashIcon />
      <span>{armed ? t("membersChat.sure") : t("common.delete")}</span>
    </button>
  );
}

export function continuesMembersChatAuthor(
  previous: MembersChatMessage | undefined,
  message: MembersChatMessage,
): boolean {
  return (
    !!previous &&
    previous.kind === "user" &&
    message.kind === "user" &&
    previous.userId === message.userId &&
    previous.device === message.device &&
    message.timestamp >= previous.timestamp &&
    message.timestamp - previous.timestamp <= 5 * 60 * 1000
  );
}

export function MembersChatPanel({
  resizeHandle,
  style,
  onClose,
  onHide,
  onRetry,
  loadFailed = false,
}: {
  resizeHandle?: ReactNode;
  style?: React.CSSProperties;
  onClose?: () => void;
  onHide?: () => void;
  onRetry?: () => void;
  loadFailed?: boolean;
}) {
  const { t, language } = useI18n();
  const {
    membersChat,
    sessionContext,
    users,
    onlineUserIds,
    totalOnlineUsers,
    isMobile,
  } = useAppState();
  const dispatch = useDispatch();
  // The store keys users by lowercased NAME (ui/user-merge.ts); messages and
  // presence carry ids, so index once by id here.
  const usersById = useMemo(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof users.get>>>();
    for (const u of users.values()) m.set(u.id, u);
    return m;
  }, [users]);
  const me = sessionContext?.userId ?? null;
  const amOwner = sessionContext?.role === "owner";
  const { messages, hasMore, loaded, readPointer } = membersChat;
  const loadedMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  );

  const [input, setInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<MembersChatMessage | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const dragCounter = useRef(0);

  const isTouchPrimary = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );

  // Keep the newest message in view unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingOlder(true);
    const pinsRevisionAtRequest = membersChat.pinsRevision ?? 0;
    chatApi
      .fetchPage({ before: messages[0].id, limit: PAGE_LIMIT })
      .then((page) => {
        dispatch({
          type: "members_chat_page",
          ...page,
          prepend: true,
          pinsRevisionAtRequest,
        });
        // Hold the reader's place: grow the scroll offset by what was added
        // above, so the message they were looking at does not jump.
        requestAnimationFrame(() => {
          const el2 = scrollRef.current;
          if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop;
        });
      })
      .catch((err: unknown) =>
        setError(chatError(err, "membersChat.olderFailed")),
      )
      .finally(() => setLoadingOlder(false));
  }, [loadingOlder, hasMore, messages, membersChat.pinsRevision, dispatch]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 40) loadOlder();
  }

  // Mark read: the newest message, once it is on screen in a visible tab.
  // Debounced so a burst of arrivals is one call; the server's answer (its
  // pointer and count) replaces the local guess.
  const newestId = messages.length ? messages[messages.length - 1].id : null;
  const [visibilityTick, setVisibilityTick] = useState(0);
  useEffect(() => {
    const onVis = () => setVisibilityTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Members-chat IDs carry a random suffix and do not sort. The server
  // keeps the pointer monotonic by file position, including unloaded history.
  useEffect(() => {
    if (!loaded || !atBottom || !newestId || newestId === readPointer) return;
    if (document.visibilityState !== "visible") return;
    const t = setTimeout(() => {
      chatApi
        .markRead(newestId)
        .then((r) => dispatch({ type: "members_chat_read", ...r }))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [loaded, atBottom, newestId, readPointer, visibilityTick, dispatch]);

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setStaged((prev) => [
        ...prev,
        {
          id,
          originalName: file.name,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          uploading: true,
        },
      ]);
      chatApi
        .upload([file])
        .then(([att]) => {
          setStaged((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, ...att, uploading: false } : s,
            ),
          );
        })
        .catch((err: unknown) => {
          setStaged((prev) =>
            prev.map((s) =>
              s.id === id
                ? {
                    ...s,
                    uploading: false,
                    error: chatError(err, "membersChat.uploadFailed"),
                  }
                : s,
            ),
          );
        });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDraggingOver(false);
    addFiles(e.dataTransfer.files);
  }

  const readyAttachments: Attachment[] = staged
    .filter((s) => !s.uploading && !s.error && s.filename)
    .map((s) => ({
      filename: s.filename!,
      originalName: s.originalName,
      mediaType: s.mediaType,
      size: s.size,
    }));
  const uploading = staged.some((s) => s.uploading);
  const canSend =
    !sending &&
    !uploading &&
    input.length <= MEMBERS_CHAT_MAX_CHARS &&
    (input.trim() !== "" || readyAttachments.length > 0);

  function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const device = getDevice();
    chatApi
      .post({
        text: input,
        ...(replyingTo ? { replyTo: replyingTo.id } : {}),
        attachments: readyAttachments,
        ...(device ? { device } : {}),
      })
      .then((m) => {
        dispatch({ type: "members_chat_message", message: m });
        setInput("");
        setReplyingTo(null);
        setStaged([]);
        setAtBottom(true);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError && err.code === "reply_not_found"
            ? { key: "membersChat.replyMissing", message: "" }
            : chatError(err, "membersChat.sendFailed"),
        ),
      )
      .finally(() => setSending(false));
  }

  function jumpTo(id: string) {
    const target = document.getElementById(`members-chat-${id}`);
    if (!target) return;
    setAtBottom(false);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus({ preventScroll: true });
  }

  function setPinned(id: string, active: boolean) {
    chatApi
      .setPinned(id, active)
      .then((message) => {
        dispatch({ type: "members_chat_message", message, updateOnly: true });
      })
      .catch((err: unknown) =>
        setError(chatError(err, "membersChat.pinFailed")),
      );
  }

  function submitEdit(id: string, text: string) {
    chatApi
      .edit(id, text)
      .then((m) => {
        dispatch({
          type: "members_chat_message",
          message: m,
          updateOnly: true,
        });
        setEditingId(null);
      })
      .catch((err: unknown) =>
        setError(chatError(err, "membersChat.editFailed")),
      );
  }

  async function setThumbsUp(id: string, active: boolean) {
    try {
      const message = await chatApi.setThumbsUp(id, active);
      dispatch({ type: "members_chat_message", message, updateOnly: true });
    } catch (err) {
      setError(chatError(err, "membersChat.reactionFailed"));
    }
  }

  function remove(id: string) {
    chatApi
      .remove(id)
      .then(() => dispatch({ type: "members_chat_deleted", id }))
      .catch((err: unknown) =>
        setError(chatError(err, "membersChat.deleteFailed")),
      );
  }

  const online = onlineUserIds
    .map((id) => usersById.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        background: "var(--bg-base)",
        ...style,
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current++;
        if (dragCounter.current === 1) setDraggingOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current--;
        if (dragCounter.current === 0) setDraggingOver(false);
      }}
      onDrop={handleDrop}
    >
      {resizeHandle}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: isMobile ? "10px 12px" : "8px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        {onClose && (
          <button
            onClick={onClose}
            style={{
              minHeight: 44,
              padding: "0 12px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-code)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            {t("common.back")}
          </button>
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--text-primary)",
            fontFamily: "'DM Sans',sans-serif",
          }}
        >
          {t("membersChat.title")}
        </span>
        <span
          data-online-count
          style={{
            fontSize: 11,
            color: "var(--text-ghost)",
            marginLeft: "auto",
          }}
        >
          {t("membersChat.online", {
            count: formatNumber(language, totalOnlineUsers),
          })}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {online.slice(0, isMobile ? 3 : 8).map((u, i) => (
            <span
              key={u.id}
              title={u.name}
              style={{ display: "inline-flex", marginLeft: i === 0 ? 0 : -4 }}
            >
              <GhostGraphic
                variant={u.avatarVariant}
                color={u.avatarColor}
                size={14}
                animated={false}
                shadow={false}
              />
            </span>
          ))}
        </span>
        {onHide && (
          <button
            onClick={onHide}
            style={{
              flexShrink: 0,
              padding: "4px 8px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-code)",
              color: "var(--text-primary)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {t("membersChat.hide")}
          </button>
        )}
      </div>

      {membersChat.pinned?.[0] && (
        <PinnedMessageStrip
          key={membersChat.pinned[0].id}
          message={membersChat.pinned[0]}
          count={membersChat.pinned.length}
          author={describeMembersChatAuthor(membersChat.pinned[0], t).label}
          loaded={loadedMessageIds.has(membersChat.pinned[0].id)}
          onJump={() => jumpTo(membersChat.pinned![0].id)}
          onUnpin={() => setPinned(membersChat.pinned![0].id, false)}
        />
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-members-chat-list
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 10px",
        }}
      >
        {hasMore && (
          <div
            style={{
              textAlign: "center",
              padding: "10px 0 0",
              fontSize: 11,
              color: "var(--text-ghost)",
            }}
          >
            {loadingOlder ? (
              t("membersChat.loadingOlder")
            ) : (
              <button
                onClick={loadOlder}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  padding: "3px 10px",
                  cursor: "pointer",
                }}
              >
                {t("membersChat.loadOlder")}
              </button>
            )}
          </div>
        )}
        {loaded && messages.length === 0 && (
          <div
            style={{
              padding: "40px 0",
              textAlign: "center",
              color: "var(--text-ghost)",
              fontSize: 12,
            }}
          >
            {t("membersChat.empty")}
          </div>
        )}
        {messages.map((m, index) => {
          const continuation = continuesMembersChatAuthor(
            messages[index - 1],
            m,
          );
          const author = describeMembersChatAuthor(m, t);
          const mine = me !== null && m.userId === me;
          const time = formatWhen(language, m.timestamp);
          const label = `${author.label} · ${time}${m.editedAt ? t("membersChat.edited") : ""}`;
          if (editingId === m.id) {
            return (
              <div key={m.id} id={`members-chat-${m.id}`} tabIndex={-1}>
                <EditableUserMessage
                  content={m.content}
                  entryId={m.id}
                  variant="members-chat"
                  isMobile={isMobile}
                  username={author.label}
                  onCancel={() => setEditingId(null)}
                  onSubmit={submitEdit}
                />
              </div>
            );
          }
          const user = usersById.get(m.userId);
          const avatar: ReactNode =
            m.kind === "user" ? (
              <span
                data-author-ghost
                style={{
                  display: "inline-flex",
                  verticalAlign: "middle",
                  marginRight: 6,
                  position: "relative",
                  top: -1,
                }}
              >
                <GhostGraphic
                  variant={user?.avatarVariant ?? "classic"}
                  color={
                    user?.avatarColor ?? defaultGhostColorForUserId(m.userId)
                  }
                  size={11}
                  animated={false}
                  shadow={false}
                />
              </span>
            ) : null;
          const canDelete = mine || amOwner;
          return (
            <div key={m.id} id={`members-chat-${m.id}`} tabIndex={-1}>
              <UserMessage
                beforeContent={
                  m.replyTo && (
                    <ReplyQuote
                      reply={m.replyTo}
                      onJump={
                        loadedMessageIds.has(m.replyTo.id)
                          ? () => jumpTo(m.replyTo!.id)
                          : undefined
                      }
                    />
                  )
                }
                content={m.content}
                renderedContent={<InlineMarkdown content={m.content} />}
                isMobile={isMobile}
                username={label}
                variant="members-chat"
                hideAuthor={continuation}
                inlineAccessory={
                  <ThumbsUpReaction
                    active={(m.thumbsUp ?? []).some((r) => r.userId === me)}
                    names={(m.thumbsUp ?? []).map(
                      (r) => describeMembersChatAuthor(r, t).label,
                    )}
                    isMobile={isMobile}
                    onChange={(active) => setThumbsUp(m.id, active)}
                  />
                }
                title={label}
                fromNonHuman={author.nonHuman}
                attachments={m.attachments}
                fileBase={MEMBERS_CHAT_FILES_BASE}
                avatar={avatar}
                editTitle={t("common.edit")}
                extraActions={
                  <MessageActions>
                    {(close) => (
                      <>
                        <button
                          type="button"
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-primary)",
                            textAlign: "left",
                            font: "inherit",
                            fontSize: 12,
                            cursor: "pointer",
                            padding: "4px 0",
                          }}
                          title={t("membersChat.reply")}
                          disabled={sending}
                          onClick={() => {
                            close();
                            setReplyingTo(m);
                            textareaRef.current?.focus();
                          }}
                        >
                          {t("membersChat.reply")}
                        </button>
                        <button
                          type="button"
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-primary)",
                            textAlign: "left",
                            font: "inherit",
                            fontSize: 12,
                            cursor: "pointer",
                            padding: "4px 0",
                          }}
                          onClick={() => {
                            close();
                            setPinned(m.id, m.pinnedAt === undefined);
                          }}
                        >
                          {t(
                            m.pinnedAt === undefined
                              ? "membersChat.pin"
                              : "membersChat.unpin",
                          )}
                        </button>
                        {mine && (
                          <button
                            type="button"
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "var(--text-primary)",
                              textAlign: "left",
                              font: "inherit",
                              fontSize: 12,
                              cursor: "pointer",
                              padding: "4px 0",
                            }}
                            title={t("common.edit")}
                            onClick={() => {
                              close();
                              setEditingId(m.id);
                            }}
                          >
                            {t("common.edit")}
                          </button>
                        )}
                        {canDelete && (
                          <DeleteControl
                            onConfirm={() => {
                              close();
                              remove(m.id);
                            }}
                          />
                        )}
                      </>
                    )}
                  </MessageActions>
                }
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "relative",
          flexShrink: 0,
          padding: isMobile ? "10px 12px 10px 11px" : "10px 18px 10px 11px",
          paddingBottom: isMobile
            ? "calc(10px + env(safe-area-inset-bottom, 0px))"
            : undefined,
          borderTop: draggingOver
            ? "2px solid var(--green)"
            : "2px solid var(--border-strong)",
          background: draggingOver ? "var(--bg-hover)" : "var(--bg-surface)",
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        {replyingTo && (
          <div
            data-members-chat-composer-quote
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <ReplyQuote
              reply={{
                id: replyingTo.id,
                userName: replyingTo.userName,
                excerpt: membersChatExcerpt(
                  replyingTo.content,
                  replyingTo.attachments,
                ),
              }}
            />
            <button
              type="button"
              disabled={sending}
              onClick={() => setReplyingTo(null)}
              aria-label={t("membersChat.cancelReply")}
              title={t("membersChat.cancelReply")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: 8,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => addFiles(e.target.files)}
        />
        {(error || loadFailed) && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              color: "var(--red)",
              fontSize: isMobile ? 12 : 11,
            }}
          >
            {error ? errorText(error, t) : t("membersChat.loadFailed")}
            {loadFailed && onRetry && (
              <button
                onClick={onRetry}
                style={{
                  marginLeft: 8,
                  padding: "8px 12px",
                  background: "var(--bg-code)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                {t("membersChat.retry")}
              </button>
            )}
          </div>
        )}
        {staged.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 8,
            }}
          >
            {staged.map((att) => (
              <div
                key={att.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: att.error ? "var(--red-bg)" : "var(--bg-hover)",
                  border: `1px solid ${att.error ? "var(--red)" : "var(--border)"}`,
                  fontSize: isMobile ? 13 : 11,
                  fontFamily: "'DM Sans',sans-serif",
                  color: att.error ? "var(--red)" : "var(--text-secondary)",
                  maxWidth: "100%",
                }}
              >
                {att.mediaType.startsWith("image/")
                  ? "🖼️"
                  : att.mediaType === "application/pdf"
                    ? "📄"
                    : "📎"}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 150,
                  }}
                >
                  {att.originalName}
                </span>
                {att.uploading && (
                  <span style={{ color: "var(--text-ghost)" }}>
                    {t("membersChat.uploading")}
                  </span>
                )}
                {att.error && (
                  <span style={{ fontSize: isMobile ? 11 : 10 }}>
                    {errorText(att.error, t)}
                  </span>
                )}
                <button
                  onClick={() =>
                    setStaged((prev) => prev.filter((s) => s.id !== att.id))
                  }
                  style={{
                    background: "none",
                    border: "none",
                    color: att.error ? "var(--red)" : "var(--text-ghost)",
                    cursor: "pointer",
                    padding: "0 2px",
                    fontSize: 14,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--text-muted)",
              cursor: "pointer",
              lineHeight: "20px",
              fontSize: 16,
              flexShrink: 0,
              opacity: 0.7,
            }}
            title={t("logView.attachFiles")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !isTouchPrimary
                ) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t("membersChat.placeholder")}
              rows={1}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text-secondary)",
                fontFamily: "'DM Sans',sans-serif",
                fontSize: isMobile ? 16 : 13,
                caretColor: "var(--green)",
                resize: "none",
                padding: "0 0 4px",
                lineHeight: "20px",
                maxHeight: 200,
                overflowY: "auto",
              }}
            />
            {input.length >= COUNTER_FROM && (
              <span
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: -2,
                  fontSize: 10,
                  color:
                    input.length > MEMBERS_CHAT_MAX_CHARS
                      ? "var(--red)"
                      : "var(--text-ghost)",
                }}
              >
                {formatNumber(language, input.length)}/
                {formatNumber(language, MEMBERS_CHAT_MAX_CHARS)}
              </span>
            )}
          </div>
          {(isTouchPrimary || isMobile) && (
            <button
              onClick={handleSend}
              disabled={!canSend}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                height: 32,
                padding: "0 12px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: canSend ? "var(--accent-bg)" : "transparent",
                color: canSend ? "var(--accent)" : "var(--text-ghost)",
                fontSize: 12,
                fontWeight: 600,
                cursor: canSend ? "pointer" : "default",
              }}
            >
              {t("common.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type ChatError = {
  key: Extract<PlainMessageKey, `membersChat.${string}`>;
  message: string;
  status?: number;
};

function chatError(err: unknown, key: ChatError["key"]): ChatError {
  return {
    key,
    message: err instanceof Error ? err.message : "",
    ...(err instanceof ApiError && err.code === "upload_failed"
      ? { status: err.status }
      : {}),
  };
}

function errorText(error: ChatError, t: Translator["t"]): string {
  const fallback = t(error.key);
  const message =
    error.status === undefined
      ? error.message
      : t("membersChat.uploadStatus", { status: error.status });
  return message ? `${fallback}: ${message}` : fallback;
}
