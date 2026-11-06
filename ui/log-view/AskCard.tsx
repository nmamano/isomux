// One open ask: the agent's prompt, its age, a reply field, Reply, Dismiss
// and "Not now; file as a task", which files the ask on the board; a secret
// request has its masked form instead (SecretAskCard). The asks stack above
// the chat input and the Asks page both draw it, so a new kind of ask shows
// on both. The card goes when the server accepts the answer, without waiting
// for ask_removed. An ask with a link to an office page or an agent's chat has a
// button that opens it (ui/office-link.tsx); the ask stays open. An action ask
// shows its action with Apply instead (AskActionBlock). Every ask
// has a "Discuss in chat" button (AskAboutButton), last but one in the bottom
// row, that starts a chat message about it, and the ask stays open too.
// Simplify, last in that row, asks the agent to rewrite the ask in plain
// words: the ask stays open, and until the agent edits the prompt a banner
// that says a rewrite is coming takes the place of the options and the reply
// area, with Undo, which withdraws the request; then the card keeps the first
// prompt behind "Show original". An ask with options has a button for
// each. A tap on the option the reply field holds sends it; a tap on any other
// option puts it in the field (focused with a mouse; on a touch screen the
// keyboard would move the buttons), and the button now sends. The button
// that sends is filled, with a send arrow; the others are outlined, with a
// pencil of the same size, so a fill moves no button. The field starts
// with the option the agent recommends (marked on its button), with the
// only option of a one-option ask, empty for other options, and with the
// catalog's "done" for an ask without options. An ask's files, editor files and commands are the
// chat's own cards, in that order, except that a file a reference line of the
// prompt names shows there (ui/log-view/ask-prompt-diff.ts); their buttons open this agent's panel
// through the store, as in chat (on the Inbox they also open the agent's
// chat), and answer nothing.
//
// The reply draft lives in the store per ask (askDrafts), so it outlives the
// card, and an untouched field follows an edit of the ask. While the field
// holds the untouched default, focus selects it (a tap on the focused field
// places the caret), and Dismiss or filing as a task sends nothing more; a
// typed note goes with either. The field grows with its text (fitComposer).
// Enter sends with a mouse and Shift+Enter is a new line; on a touch screen
// Enter is a new line and Reply sends. Tab and Shift+Tab move
// between the reply fields inside the list that draws the cards
// ([data-asks-list]); at either end the browser's order goes on.
//
// With `undoMs` (the Inbox), an answer is held that long first: the card turns
// into a line with what was chosen and Undo, which brings the card back with
// the draft. While held and while sent, the ask is answered in the store
// (answeredAsks), so the counts, the desk dots and the chat's ask stack leave
// it out at once; once sent, the Inbox drops the line too. Inside an
// AskUndoHost (the Inbox's list) the line is a toast in the host, over the
// list, and the card leaves the list at once: what the member reads next does
// not move when the line goes (task 02274529). When the card's place starts
// above the view (a tall card answered at its foot), the list scrolls it to
// the top, so the next ask starts in view. A held answer is
// sent at once when the card unmounts (the member leaves the Inbox) and when
// the page is hidden or closes, with keepalive so the request outlives the
// page. A send that fails brings the ask back everywhere, with the error
// (askErrors, kept in the store so it outlives this card).
//
// Another member's ask, shown to an office owner on the Inbox, names the
// member it is for; the owner answers it as their own.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { apiFetch, ApiError } from "../api.ts";
import { useAsksClosedHere } from "../ask-closed.ts";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { getDevice } from "../device-settings.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import {
  isActionStep,
  type AskMemberWire,
  type AskReadFile,
} from "../../shared/types.ts";
import type {
  AskDismissReq,
  AskFileTaskReq,
  AskReplyReq,
  AskSimplifyReq,
} from "../../shared/contract-shapes.ts";
import { AskPrompt } from "./AskPrompt.tsx";
import { unplacedAskFiles } from "./ask-prompt-diff.ts";
import { noTranslate } from "../no-translate.ts";
import { RecommendedStar } from "./recommended-star.tsx";
import { SudoAskCard } from "./SudoAskCard.tsx";
import { SecretAskCard } from "./SecretAskCard.tsx";
import { askLinkFor } from "../../shared/office-links.ts";
import { OfficeLinkOpener, officeLinkLabel } from "../office-link.tsx";
import { FileViewCard } from "./FileViewCard.tsx";
import { EditRequestCard } from "./EditRequestCard.tsx";
import { TerminalCommandCard } from "./TerminalCommandCard.tsx";
import { agentAccessOf, belowStandard } from "../../shared/agent-access.ts";
import { isRunnableCommand } from "../../shared/runnable-command.ts";
import { AskAboutButton } from "./AskAboutButton.tsx";
import { AskActionBlock } from "./AskActionBlock.tsx";
import { AskStepBlock, useStepView } from "./AskStepBlock.tsx";
import { AskIdChip } from "./AskIdChip.tsx";
import { PRIORITY_COLORS } from "../task-priority.ts";
import { fitComposer } from "../composer-height.ts";
import { isTouchPrimary } from "../touch-primary.ts";
import { filledSecondaryBtn } from "../components/dialog-styles.ts";

const PROMPT_LINES = 3;

// keepalive's body limit is 64 KiB over all of a page's keepalive requests
// in flight; fetch refuses a larger body at once. Over this, an answer goes
// without keepalive.
const KEEPALIVE_MAX_BYTES = 60_000;

type AnswerKind = "reply" | "dismiss" | "file-task";
type AnswerBody = AskReplyReq | (AskDismissReq & AskFileTaskReq);

// Where a held answer's Undo line goes: a toast over the list, or, with no
// host, the card's own place.
export const AskUndoHost = createContext<HTMLElement | null>(null);

// An answer the card holds for the undo window. `shown` is the reply, or the
// note that goes with a dismiss or a filing (null for none).
interface HeldAnswer {
  kind: AnswerKind;
  shown: string | null;
  body: AnswerBody;
  timer: ReturnType<typeof setTimeout>;
}

// Tab and Shift+Tab to the next or previous reply field of the list. No move
// past either end, so focus is never trapped.
function tabToReplyField(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.nativeEvent.isComposing) return;
  const list = e.currentTarget.closest("[data-asks-list]");
  if (!list) return;
  const fields = [
    ...list.querySelectorAll<HTMLTextAreaElement>(
      "textarea[data-ask-reply-input]",
    ),
  ].filter((f) => !f.disabled);
  const at = fields.indexOf(e.currentTarget);
  if (at === -1) return;
  const next = fields[at + (e.shiftKey ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// What an option button does: a send arrow on the option the reply field
// holds, a pencil on the others (a tap puts the option in the field to
// edit). One size for both, so a fill moves no button. SVG, not a glyph: iOS Safari draws arrows through the
// emoji font. The button's text says the option; the mark is decoration.
function OptionMark({ sends, size }: { sends: boolean; size: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block" }}
    >
      {sends ? (
        <path d="M4 12h15M13 6l6 6-6 6" />
      ) : (
        <path d="M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4" />
      )}
    </svg>
  );
}

// The reply field's starting value. A mark that names no option is ignored.
// The only option of a one-option ask ("do this, then tell me") starts there,
// so one tap sends it. An action ask starts empty: Apply makes the change, and
// a "done" sent as it stands would close the ask with nothing changed.
function replyDefault(entry: AskMemberWire, done: string): string {
  if (!entry.options?.length)
    return entry.step && isActionStep(entry.step) ? "" : done;
  if (
    entry.recommended !== undefined &&
    entry.options.includes(entry.recommended)
  )
    return entry.recommended;
  return entry.options.length === 1 ? entry.options[0] : "";
}

// One ask, of either kind. `onFocusAgent` is set where the ask's chat is not
// on screen (the Inbox): a click on a terminal or editor card opens it.
export function AskCard({
  entry,
  isMobile,
  onFocusAgent,
  onChatAgent,
  undoMs,
  promptLines,
}: {
  // `member`, set on another member's ask only, is the member it is for.
  entry: AskMemberWire & { member?: string | null };
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
  // Set on the Inbox: Discuss in chat opens the in-place chat panel.
  onChatAgent?: (agentId: string) => void;
  undoMs?: number;
  // The prompt's lines before Show more.
  promptLines?: number;
}) {
  return entry.secret ? (
    <SecretAskCard
      entry={entry}
      secret={entry.secret}
      isMobile={isMobile}
      onFocusAgent={onFocusAgent}
      onChatAgent={onChatAgent}
    />
  ) : entry.sudo ? (
    <SudoAskCard
      entry={entry}
      sudo={entry.sudo}
      isMobile={isMobile}
      onFocusAgent={onFocusAgent}
      onChatAgent={onChatAgent}
    />
  ) : (
    <ReplyAskCard
      entry={entry}
      isMobile={isMobile}
      onFocusAgent={onFocusAgent}
      onChatAgent={onChatAgent}
      undoMs={undoMs}
      promptLines={promptLines}
    />
  );
}

// Where an ask's read file is served from: a reference by the ask's own route,
// a copy from the agent's files dir.
function askFileSrc(entry: AskMemberWire) {
  return (att: AskReadFile) =>
    att.path
      ? `/api/asks/${entry.id}/files/${att.filename}`
      : `/api/files/${entry.agentId}/${att.filename}`;
}

// A path or command with no panel to send it to: the text only.
function PlainAffordance({ text }: { text: string }) {
  return (
    <div
      style={{
        margin: "8px 0",
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 13,
        color: "var(--text-secondary)",
        wordBreak: "break-all",
      }}
    >
      {text}
    </div>
  );
}

// A refused Run, in the member's words.
function runErrorText(t: ReturnType<typeof useI18n>["t"], err: unknown) {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case "command_changed":
      return t("cards.terminalCommand.runChanged");
    case "run_in_progress":
      return t("cards.terminalCommand.runInProgress");
    case "agent_limited":
      return t("cards.terminalCommand.runLimited");
    case "terminal_forbidden":
      return t("cards.terminalCommand.runForbidden");
    case "command_not_runnable":
      return t("cards.terminalCommand.runHidden");
    default:
      return t("cards.terminalCommand.runFailed");
  }
}

function AskAffordances({
  entry,
  isMobile,
  onFocusAgent,
}: {
  entry: AskMemberWire;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
}) {
  const dispatch = useDispatch();
  const features = useFeatures();
  const { t } = useI18n();
  const { agents } = useAppState();
  // The member's Run (task c3b91695): the taps whose answer is due, and the
  // refusal of the last tap, per command.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [runErrors, setRunErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const { agentId, editFiles, commands } = entry;
  if (!entry.readFiles && !editFiles && !commands) return null;
  const agent = agents.find((a) => a.id === agentId);
  // As the server: terminal panels on, an agent at Standard or above (one
  // below reads text from strangers), a command that shows as it runs.
  const canRun = (command: string) =>
    features.terminal &&
    !!agent &&
    !belowStandard(agentAccessOf(agent)) &&
    isRunnableCommand(command);
  const runCommand = async (command: string) => {
    setPending((prev) => new Set(prev).add(command));
    setRunErrors((prev) => {
      const next = new Map(prev);
      next.delete(command);
      return next;
    });
    try {
      await apiFetch("POST", `/api/asks/${entry.id}/run`, { command });
    } catch (err) {
      setRunErrors((prev) => new Map(prev).set(command, runErrorText(t, err)));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(command);
        return next;
      });
    }
  };
  // The prompt shows the files it places.
  const readFiles = entry.readFiles
    ? unplacedAskFiles(entry.prompt, entry.readFiles)
    : [];
  const openInEditor = (path: string) => {
    dispatch({ type: "open_in_editor", agentId, path });
    onFocusAgent?.(agentId);
  };
  const copyToTerminal = (command: string) => {
    dispatch({ type: "copy_to_terminal", agentId, command });
    onFocusAgent?.(agentId);
  };
  return (
    <div style={{ marginTop: 4 }}>
      {readFiles.length > 0 && (
        <FileViewCard
          attachments={readFiles}
          agentId={agentId}
          isMobile={isMobile}
          srcFor={askFileSrc(entry)}
        />
      )}
      {editFiles?.map((file, i) => (
        <div key={i} data-ask-edit-file={file.path}>
          {features.editor ? (
            <EditRequestCard payload={file} onOpen={openInEditor} />
          ) : (
            <PlainAffordance text={file.path} />
          )}
        </div>
      ))}
      {commands?.map((command, i) => (
        <div key={i} data-ask-command={command}>
          {features.terminal ? (
            <TerminalCommandCard
              payload={{ command }}
              onCopy={copyToTerminal}
              isMobile={isMobile}
              {...(canRun(command)
                ? {
                    onRun: (c: string) => void runCommand(c),
                    run: entry.runs?.find((r) => r.command === command),
                    runError: runErrors.get(command) ?? null,
                    pending: pending.has(command),
                  }
                : {})}
            />
          ) : (
            <PlainAffordance text={command} />
          )}
        </div>
      ))}
    </div>
  );
}

function ReplyAskCard({
  entry,
  isMobile,
  onFocusAgent,
  onChatAgent,
  undoMs,
  promptLines = PROMPT_LINES,
}: {
  entry: AskMemberWire & { member?: string | null };
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
  onChatAgent?: (agentId: string) => void;
  undoMs?: number;
  promptLines?: number;
}) {
  const { t, rich, language } = useI18n();
  const dispatch = useDispatch();
  const { askDrafts, askErrors, agents, rooms, sessionContext } = useAppState();
  const closedHere = useAsksClosedHere();
  const draft = askDrafts.get(entry.id);
  const untouched = draft === undefined;
  const fallback = replyDefault(entry, t("asks.replyDefault"));
  const reply = draft ?? fallback;
  const [busy, setBusy] = useState(false);
  // One answer at a time: a second submit in the same frame still sees busy
  // false.
  const sending = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Set by a pointerdown on a field without focus: only the tap that focuses
  // the field selects the default, so a later tap places the caret.
  const clickFocuses = useRef(false);
  // The input device, not viewport `isMobile`, as the chat input
  // does: Enter sends only with a mouse.
  const touchPrimary = useMemo(() => isTouchPrimary(), []);
  // Set by an option tap; the next commit focuses the field. No deps: a tap
  // on the option the field already holds leaves the draft the same.
  const pendingFocus = useRef(false);
  const error = askErrors.get(entry.id);
  // The held answer: the ref for the timer and the page events, the state to
  // draw the line.
  const heldRef = useRef<HeldAnswer | null>(null);
  const [held, setHeld] = useState<HeldAnswer | null>(null);
  const heldLineRef = useRef<HTMLDivElement>(null);
  const undoHost = useContext(AskUndoHost);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  // A simplify request in flight, its refusal, and the original prompt shown.
  const [simplifying, setSimplifying] = useState(false);
  const [simplifyError, setSimplifyError] = useState<string | null>(null);
  const [undoingSimplify, setUndoingSimplify] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const openLink = useContext(OfficeLinkOpener);
  // A link this UI does not know is not drawn, nor one to an agent the store
  // does not have. A step on the Integrations page that the card draws
  // (AskStepBlock) is done there, so its link, kept for older clients, is
  // not drawn.
  const stepView = useStepView(entry.step, entry.memberUserId);
  const link = stepView ? null : askLinkFor(entry.link);
  // Who else a shared ask is for (task 9461c464): the other members by name,
  // or the agent's room. Another member's ask names them all.
  const names = (list: string[]) => (
    <span {...noTranslate()}>
      {new Intl.ListFormat(language, { type: "conjunction" }).format(list)}
    </span>
  );
  const viewer = sessionContext?.username?.toLowerCase();
  const otherMembers = (entry.members ?? []).filter(
    (name) => name.toLowerCase() !== viewer,
  );
  const askRoom = entry.room
    ? rooms.find(
        (r) => r.id === agents.find((a) => a.id === entry.agentId)?.roomId,
      )
    : undefined;
  const sharedLine = entry.member
    ? null
    : entry.room
      ? askRoom
        ? rich("asks.forRoom", {
            room: <span {...noTranslate()}>{askRoom.name}</span>,
          })
        : null
      : otherMembers.length > 0
        ? rich("asks.alsoFor", { members: names(otherMembers) })
        : null;
  const linkLabel = !link
    ? null
    : "agentId" in link
      ? (agents.find((a) => a.id === link.agentId)?.name ?? null)
      : t(officeLinkLabel(link));

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  // On a touch screen the focus opens the keyboard, which moves the option
  // the member taps next to send.
  function fillOption(option: string) {
    if (!touchPrimary) pendingFocus.current = true;
    dispatch({ type: "set_ask_draft", askId: entry.id, text: option });
  }

  // The field grows with its text, an option tap, a restored draft and Undo
  // too.
  useLayoutEffect(() => {
    if (inputRef.current) fitComposer(inputRef.current, isMobile);
  }, [reply, isMobile, held]);

  // Show more only when the clamp cuts the prompt. A file placed in the
  // prompt has no height until it loads, so each load measures again.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Load events do not bubble: listen in the capture phase.
    el.addEventListener("load", measure, true);
    el.addEventListener("loadedmetadata", measure, true);
    return () => {
      el.removeEventListener("load", measure, true);
      el.removeEventListener("loadedmetadata", measure, true);
    };
  }, [entry.prompt, expanded, promptLines]);

  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const fontSize = isMobile ? 14 : 13;

  // What the member typed, unless it is blank or the default again.
  function dismissReason(): string | null {
    if (draft === undefined) return null;
    const typed = draft.trim();
    return typed === "" || typed === fallback.trim() ? null : draft;
  }

  // While the field holds the untouched default, typing replaces it.
  function selectDefault(el: HTMLTextAreaElement) {
    if (untouched) el.setSelectionRange(0, el.value.length);
  }

  // Plain Enter sends with a mouse; a modifier, an IME or a touch screen
  // keeps the browser's Enter.
  function onReplyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    tabToReplyField(e);
    if (e.key !== "Enter" || touchPrimary || e.nativeEvent.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

  // fetch() is reached in the same task as the call: a page event must start
  // the request before the page goes.
  async function send(kind: AnswerKind, body: AnswerBody, keepalive: boolean) {
    try {
      await apiFetch(
        "POST",
        `/api/asks/${entry.id}/${kind}`,
        body,
        keepalive &&
          new TextEncoder().encode(JSON.stringify(body)).length <=
            KEEPALIVE_MAX_BYTES
          ? { keepalive: true }
          : undefined,
      );
      dispatch({ type: "ask_removed", id: entry.id });
    } catch (err) {
      sending.current = false;
      setBusy(false);
      // Another member answered first (task 9461c464): the ask is closed,
      // and the notice names them.
      const by = err instanceof ApiError ? err.detail?.by : undefined;
      if (
        err instanceof ApiError &&
        err.code === "ask_closed" &&
        typeof by === "string"
      ) {
        dispatch({ type: "ask_removed", id: entry.id, by });
        return;
      }
      dispatch({
        type: "ask_answer_failed",
        id: entry.id,
        error: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  // `text` is a reply other than the field's, as the option a tap sends.
  function answer(kind: AnswerKind, text: string = reply) {
    if (sending.current) return;
    if (kind === "reply" && text.trim() === "") return;
    sending.current = true;
    dispatch({ type: "ask_answer_started", id: entry.id });
    const device = getDevice() || undefined;
    const reason = kind === "reply" ? null : dismissReason();
    const body: AnswerBody =
      kind === "reply"
        ? { text, ...(device ? { device } : {}) }
        : {
            ...(reason !== null ? { text: reason } : {}),
            ...(device ? { device } : {}),
          };
    if (undoMs === undefined) {
      setBusy(true);
      void send(kind, body, false);
      return;
    }
    const pending: HeldAnswer = {
      kind,
      shown: kind === "reply" ? text : reason,
      body,
      timer: setTimeout(() => flushRef.current(false), undoMs),
    };
    heldRef.current = pending;
    setHeld(pending);
    dispatch({ type: "ask_answered", id: entry.id, phase: "undo" });
  }

  // Asks the agent for a simpler ask. The card stays: the pushed ask brings
  // the pending line, and later the rewrite.
  async function simplify() {
    if (simplifying) return;
    setSimplifying(true);
    setSimplifyError(null);
    const device = getDevice() || undefined;
    const body: AskSimplifyReq = device ? { device } : {};
    try {
      await apiFetch("POST", `/api/asks/${entry.id}/simplify`, body);
    } catch (err) {
      setSimplifyError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSimplifying(false);
    }
  }

  // Withdraws the simplify request. The banner stays until the pushed ask
  // clears the mark.
  async function undoSimplify() {
    if (undoingSimplify) return;
    setUndoingSimplify(true);
    setSimplifyError(null);
    const device = getDevice() || undefined;
    const body: AskSimplifyReq = device ? { device } : {};
    try {
      await apiFetch("POST", `/api/asks/${entry.id}/simplify/undo`, body);
    } catch (err) {
      setSimplifyError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUndoingSimplify(false);
    }
  }

  // Sends the held answer now, at most once. The Inbox drops the card as the
  // ask turns "sending", so the line goes straight to nothing.
  function flush(keepalive: boolean) {
    const pending = heldRef.current;
    if (!pending) return;
    heldRef.current = null;
    clearTimeout(pending.timer);
    // The ask closed while held, as another member answered it: nothing to
    // send.
    if (closedHere.has(entry.id)) return;
    dispatch({ type: "ask_answered", id: entry.id, phase: "sending" });
    void send(pending.kind, pending.body, keepalive);
  }

  function undo() {
    const pending = heldRef.current;
    if (!pending) return;
    heldRef.current = null;
    clearTimeout(pending.timer);
    sending.current = false;
    pendingFocus.current = true;
    setHeld(null);
    dispatch({ type: "ask_undone", id: entry.id });
  }

  // Bring the Undo line, or the card's empty place, into view when it
  // replaces the card, so the next ask starts under it.
  useLayoutEffect(() => {
    if (!held) return;
    heldLineRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [held]);

  // The page events and the unmount reach the latest flush.
  const flushRef = useRef(flush);
  useLayoutEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => {
    if (undoMs === undefined) return;
    const onPageHide = () => flushRef.current(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushRef.current(true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushRef.current(false);
    };
  }, [undoMs]);

  const buttonPad = isMobile ? "8px 14px" : "5px 14px";
  // Filled, as on other cards: a transparent fill reads as plain text here.
  const secondaryButton = {
    padding: buttonPad,
    borderRadius: 8,
    border: filledSecondaryBtn.border,
    background: filledSecondaryBtn.background,
    color: filledSecondaryBtn.color,
    fontSize: 12,
    cursor: busy ? "default" : "pointer",
    flexShrink: 0,
  } as const;
  // Show original, a link under the prompt as the office link is.
  const linkButton = {
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--accent-text)",
    fontSize: isMobile ? 13 : 12,
    fontWeight: 600,
    cursor: "pointer",
  } as const;
  const simplifyOff = busy || simplifying;
  const rewriting = entry.simplifyRequestedAt !== undefined;
  // An answer's refusal, else a simplify request's.
  const failure = error ?? simplifyError;
  const cardBox = {
    padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
    borderRadius: 8,
    background: "var(--bg-subtle)",
    border: "1px solid var(--border-light)",
    borderLeft: "3px solid var(--orange)",
    marginBottom: 6,
    fontFamily: "var(--font-ui)",
  } as const;
  if (held) {
    const shown =
      held.shown === null ? null : <span {...noTranslate()}>{held.shown}</span>;
    const toastBox = {
      width: "100%",
      maxWidth: 760,
      boxSizing: "border-box",
      marginBottom: 0,
      background: "var(--bg-surface-solid)",
      boxShadow: "0 4px 16px var(--shadow-heavy)",
      pointerEvents: "auto",
    } as const;
    const line = (
      <div
        ref={undoHost ? undefined : heldLineRef}
        data-ask={entry.id}
        data-ask-pending={held.kind}
        style={{
          ...cardBox,
          ...(undoHost ? toastBox : {}),
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text-dim)",
            fontSize,
          }}
        >
          {held.kind === "reply"
            ? rich("asks.replied", { reply: shown })
            : held.kind === "dismiss"
              ? shown === null
                ? t("asks.dismissed")
                : rich("asks.dismissedReason", { reason: shown })
              : shown === null
                ? t("asks.filedAsTaskPending")
                : rich("asks.filedAsTaskPendingNote", { note: shown })}
        </span>
        <button
          type="button"
          data-ask-undo=""
          onClick={undo}
          style={{ ...secondaryButton, cursor: "pointer" }}
        >
          {t("asks.undo")}
        </button>
      </div>
    );
    if (!undoHost) return line;
    // The card's place keeps no height; the line is in the host.
    return (
      <>
        <div ref={heldLineRef} data-ask-place={entry.id} />
        {createPortal(line, undoHost)}
      </>
    );
  }
  // Reply, Dismiss, filing as a task, Discuss in chat and Simplify: one group
  // that wraps, under the field, which takes the card's width.
  const replyButtons = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      <button
        type="submit"
        disabled={busy || reply.trim() === ""}
        style={{
          padding: buttonPad,
          borderRadius: 8,
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
          flexShrink: 0,
        }}
      >
        {t("asks.reply")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => answer("dismiss")}
        style={secondaryButton}
      >
        {t("asks.dismiss")}
      </button>
      {/* Closes the ask and files it on the board; the reply field's note
          goes with it, as with Dismiss. */}
      <button
        type="button"
        data-ask-file-task=""
        disabled={busy}
        onClick={() => answer("file-task")}
        style={secondaryButton}
      >
        {t("asks.fileTask")}
      </button>
      <AskAboutButton
        entry={entry}
        style={secondaryButton}
        disabled={busy}
        onFocusAgent={onFocusAgent}
        onChatAgent={onChatAgent}
      />
      <button
        type="button"
        data-ask-simplify=""
        disabled={simplifyOff}
        onClick={() => void simplify()}
        style={{
          ...secondaryButton,
          cursor: simplifyOff ? "default" : "pointer",
        }}
      >
        {t("asks.simplify")}
      </button>
    </div>
  );

  return (
    <div data-ask={entry.id} style={cardBox}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {entry.app && (
            <div
              data-ask-app=""
              style={{
                color: "var(--text-ghost)",
                fontSize: isMobile ? 12 : 11,
                lineHeight: 1.5,
                overflowWrap: "break-word",
              }}
            >
              {t("asks.fromApp", { app: entry.app.name })}
            </div>
          )}
          {entry.member && (
            <div
              data-ask-for=""
              style={{
                color: "var(--text-ghost)",
                fontSize: isMobile ? 12 : 11,
                lineHeight: 1.5,
                overflowWrap: "break-word",
              }}
            >
              {rich("asks.forMember", {
                member:
                  (entry.members?.length ?? 0) > 1 ? (
                    names(entry.members ?? [])
                  ) : (
                    <span {...noTranslate()}>{entry.member}</span>
                  ),
              })}
            </div>
          )}
          {sharedLine && (
            <div
              data-ask-members=""
              style={{
                color: "var(--text-ghost)",
                fontSize: isMobile ? 12 : 11,
                lineHeight: 1.5,
                overflowWrap: "break-word",
              }}
            >
              {sharedLine}
            </div>
          )}
          <div
            ref={promptRef}
            data-ask-prompt=""
            {...noTranslate()}
            style={{
              color: "var(--text-primary)",
              fontSize,
              lineHeight: 1.5,
              overflowWrap: "break-word",
              ...(expanded
                ? {}
                : {
                    display: "-webkit-box",
                    WebkitLineClamp: promptLines,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
          >
            <AskPrompt
              content={entry.prompt}
              files={entry.readFiles}
              srcFor={askFileSrc(entry)}
              isMobile={isMobile}
            />
          </div>
          {(clamped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                marginTop: 2,
                color: "var(--accent-text)",
                fontSize: isMobile ? 12 : 11,
                cursor: "pointer",
              }}
            >
              {expanded
                ? t("cards.toolResult.showLess")
                : t("cards.toolResult.showMore")}
            </button>
          )}
          {((link && linkLabel !== null && openLink) ||
            entry.originalPrompt !== undefined) && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                columnGap: 14,
                marginTop: 2,
              }}
            >
              {link && linkLabel !== null && openLink && (
                <button
                  type="button"
                  data-ask-office-link={entry.link}
                  onClick={() => openLink(link)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--accent-text)",
                    fontSize: isMobile ? 13 : 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {"askId" in link && link.askId
                    ? t("asks.openAsk", { id: link.askId })
                    : t("asks.openLink", { page: linkLabel })}
                </button>
              )}
              {entry.originalPrompt !== undefined && (
                <button
                  type="button"
                  data-ask-show-original=""
                  onClick={() => setShowOriginal((v) => !v)}
                  style={linkButton}
                >
                  {showOriginal
                    ? t("asks.hideOriginal")
                    : t("asks.showOriginal")}
                </button>
              )}
            </div>
          )}
          {showOriginal && entry.originalPrompt !== undefined && (
            <div
              data-ask-original=""
              {...noTranslate()}
              style={{
                marginTop: 4,
                paddingLeft: 8,
                borderLeft: "2px solid var(--border-light)",
                color: "var(--text-dim)",
                fontSize,
                lineHeight: 1.5,
                overflowWrap: "break-word",
              }}
            >
              <AskPrompt
                content={entry.originalPrompt}
                files={entry.readFiles}
                srcFor={askFileSrc(entry)}
                isMobile={isMobile}
              />
            </div>
          )}
        </div>
        {!isMobile && (
          <AskIdChip
            id={entry.id}
            isMobile={isMobile}
            lineHeight={`${fontSize * 1.5}px`}
          />
        )}
        {/* On mobile the id goes under priority and age, so the prompt keeps
            its width. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            {entry.priority && (
              <span
                data-ask-priority={entry.priority}
                style={{
                  color: PRIORITY_COLORS[entry.priority],
                  fontSize: isMobile ? 11 : 10,
                  fontWeight: 700,
                  lineHeight: `${fontSize * 1.5}px`,
                }}
              >
                {entry.priority}
              </span>
            )}
            <span
              style={{
                color: "var(--text-ghost)",
                fontSize: isMobile ? 12 : 11,
                lineHeight: `${fontSize * 1.5}px`,
              }}
            >
              {age}
            </span>
          </div>
          {isMobile && <AskIdChip id={entry.id} isMobile={isMobile} />}
        </div>
      </div>
      {stepView && (
        <AskStepBlock askId={entry.id} view={stepView} isMobile={isMobile} />
      )}
      {entry.step && isActionStep(entry.step) && (
        <AskActionBlock
          askId={entry.id}
          askingAgentId={entry.agentId}
          memberUserId={entry.memberUserId}
          step={entry.step}
          isMobile={isMobile}
        />
      )}
      <AskAffordances
        entry={entry}
        isMobile={isMobile}
        onFocusAgent={onFocusAgent}
      />
      {/* Until the rewrite, the banner takes the place of the options and the
          reply area: the member waits for the rewrite or withdraws it. */}
      {rewriting && (
        <div
          data-ask-simplify-pending=""
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 7,
            padding: isMobile ? "8px 10px" : "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--accent-text)",
            background: "var(--accent-bg)",
          }}
        >
          <span
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              color: "var(--text-primary)",
              fontSize,
              fontWeight: 600,
            }}
          >
            {t("asks.simplifyPending")}
          </span>
          <button
            type="button"
            data-ask-simplify-undo=""
            disabled={undoingSimplify}
            onClick={() => void undoSimplify()}
            style={{
              ...secondaryButton,
              color: "var(--accent-text)",
              border: "1px solid var(--accent-text)",
              fontWeight: 600,
              cursor: undoingSimplify ? "default" : "pointer",
            }}
          >
            {t("asks.undo")}
          </button>
        </div>
      )}
      {!rewriting && entry.options && entry.options.length > 0 && (
        <div
          data-ask-options=""
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
        >
          {entry.options.map((option, i) => {
            const recommended = option === entry.recommended;
            // Options come trimmed from the server, and no two are the same.
            const sends = reply.trim() === option;
            const marks = {
              "data-ask-option": "",
              ...(sends ? { "data-ask-option-sends": "" } : {}),
              ...(recommended
                ? {
                    "data-ask-option-recommended": "",
                    title: t("asks.recommended"),
                  }
                : {}),
            };
            const style: React.CSSProperties = {
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              maxWidth: "100%",
              boxSizing: "border-box",
              padding: buttonPad,
              // Tight space on the star's left, as on its right.
              ...(recommended ? { paddingLeft: 10 } : {}),
              borderRadius: 8,
              border: "1px solid var(--accent-text)",
              // The option that sends is the Reply button's colours; the
              // others are outlined.
              background: sends ? "var(--accent-text)" : "transparent",
              color: sends ? "var(--bg-base)" : "var(--accent-text)",
              fontFamily: "var(--font-ui)",
              fontSize: isMobile ? 14 : 12,
              fontWeight: 600,
              lineHeight: 1.35,
              textAlign: "left",
              overflowWrap: "anywhere",
            };
            return (
              <button
                key={i}
                type="button"
                {...marks}
                disabled={busy}
                onClick={() =>
                  sends ? answer("reply", option) : fillOption(option)
                }
                style={{
                  ...style,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  {recommended && <RecommendedStar size={isMobile ? 13 : 11} />}
                  {/* The agent's words; the recommended mark stays translatable. */}
                  <span {...noTranslate()}>{option}</span>
                </span>
                <OptionMark sends={sends} size={isMobile ? 14 : 12} />
              </button>
            );
          })}
        </div>
      )}
      {rewriting ? null : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            answer("reply");
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 7,
          }}
        >
          <textarea
            ref={inputRef}
            value={reply}
            rows={1}
            disabled={busy}
            data-ask-reply-input=""
            onChange={(e) =>
              dispatch({
                type: "set_ask_draft",
                askId: entry.id,
                text: e.target.value,
              })
            }
            onFocus={(e) => selectDefault(e.currentTarget)}
            onPointerDown={(e) => {
              clickFocuses.current = document.activeElement !== e.currentTarget;
            }}
            onClick={(e) => {
              if (clickFocuses.current) selectDefault(e.currentTarget);
              clickFocuses.current = false;
            }}
            onKeyDown={onReplyKeyDown}
            aria-label={t("asks.reply")}
            style={{
              minWidth: 0,
              boxSizing: "border-box",
              padding: isMobile ? "8px 10px" : "5px 10px",
              background: "var(--bg-input)",
              border: "1px solid var(--border-light)",
              borderRadius: 8,
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
              // 16px keeps iOS Safari from zooming into the field.
              fontSize: isMobile ? 16 : 12,
              lineHeight: isMobile ? "20px" : "16px",
              resize: "none",
              overflowY: "auto",
              outline: "none",
            }}
          />
          {replyButtons}
        </form>
      )}
      {failure && (
        <div
          role="alert"
          style={{
            marginTop: 6,
            color: "var(--red-text)",
            fontSize: isMobile ? 12 : 11,
          }}
        >
          {t("asks.answerFailed", { error: failure })}
        </div>
      )}
    </div>
  );
}
