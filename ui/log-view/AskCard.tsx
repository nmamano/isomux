// One open ask: the agent's prompt, its age, a reply field with its send
// button, and the tags Dismiss, Postpone and Rewrite; a secret request has
// its masked form instead (SecretAskCard). The asks stack above
// the chat input and the Asks page both draw it, so a new kind of ask shows
// on both. The card goes when the server accepts the answer, without waiting
// for ask_removed. An ask with a link to an office page or an agent's chat has a
// button that opens it (ui/office-link.tsx); the ask stays open. An action ask
// shows its action with Apply instead (AskActionBlock). Every ask
// has a "Discuss in chat" button (AskAboutButton), last in the bottom row,
// that starts a chat message about it, and the ask stays open too.
//
// Tags (task 1466ea8b): a row under the options with Dismiss, Postpone and
// Rewrite, the answers every ask takes. A tap puts the tag on the reply
// field as a chip at its start (× or Backspace at the field's start takes
// it off); the send button takes its name and the tag's button sends, as an
// option's does. At most one tag; a tap on an option takes it off. A tag tap
// empties the field, and the field goes with the tag as it is (blank = no
// words). Postpone and Rewrite show suggestions above the field, whose words
// replace the field's ("File as a task" too: the agent files it). A tap that
// erases the member's words shows a line with Undo (task 9d79a544). The
// agent can recommend a tag with words (recommendedTag): an untouched card
// starts with it, so Enter sends it. Rewrite asks the agent to rewrite the
// ask as the field says: the ask stays open, and until the agent changes it
// a banner that says a rewrite is coming takes the place of the options and
// the reply area, with Undo, which withdraws the request; then the card
// keeps the first prompt behind "Show original". An ask with options has a button for
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
// places the caret). The tag lives in the store too (askTags). The field
// grows with its text (fitComposer).
// Enter sends with a mouse and Shift+Enter is a new line; on a touch screen
// Enter is a new line and Reply sends. Tab and Shift+Tab move
// between the reply fields inside the list that draws the cards
// ([data-asks-list]); at either end the browser's order goes on.
//
// With `undoMs` (the Inbox), an answer is held that long first: the card turns
// into a line with what was chosen, Undo, which brings the card back with
// the draft, and a ×, which sends the answer at once. While held and while
// sent, the ask is answered in the store (answeredAsks), so the counts, the
// desk dots and the chat's ask stack leave it out at once; once sent, the
// Inbox drops the line too. Inside an
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
//
// Selecting text in the prompt shows the chat's Cite pill where the chat has
// one (task ad4b51ac): it puts the selection into the agent's chat draft as a
// cite block, as Discuss in chat does (AskCitePill; task d9a347a6).

import {
  createContext,
  Fragment,
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
import { sendFailureText } from "../send-failure.ts";
import { sendFailureNode } from "../send-failure-node.tsx";
import { useAsksClosedHere } from "../ask-closed.ts";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { getDevice } from "../device-settings.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import {
  ASK_TAGS,
  automateOffered,
  isActionStep,
  type AskMemberWire,
  type AskReadFile,
  type AskTag,
} from "../../shared/types.ts";
import type {
  AskDismissReq,
  AskPostponeReq,
  AskReplyReq,
  AskRewriteReq,
  AskSimplifyReq,
} from "../../shared/contract-shapes.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { AskPrompt } from "./AskPrompt.tsx";
import { unplacedAskFiles } from "./ask-prompt-diff.ts";
import { noTranslate } from "../no-translate.ts";
import { Data } from "../components/Data.tsx";
import { RecommendedStar } from "./recommended-star.tsx";
import { SudoAskCard } from "./SudoAskCard.tsx";
import { SecretAskCard } from "./SecretAskCard.tsx";
import { askLinkFor, outsideLinkFor } from "../../shared/office-links.ts";
import { OutsideLinkButton } from "./OutsideLink.tsx";
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
import { AskPageLine } from "./AskPageLine.tsx";
import { PRIORITY_COLORS } from "../task-priority.ts";
import { fitComposer, placeComposerCaret } from "../composer-height.ts";
import { citationBlock, insertCite } from "./cite.ts";
import { AskCitePill } from "./AskCitePill.tsx";
import { citeModeHere } from "./cite-mode.ts";
import { useSelectionCite } from "./useSelectionCite.ts";
import { isTouchPrimary } from "../touch-primary.ts";
import { filledSecondaryBtn } from "../components/dialog-styles.ts";
import { NoticeCloseButton } from "../components/NoticeCloseButton.tsx";
import { useComposerVoice } from "../hooks/useComposerVoice.ts";
import { MicIcon } from "../components/MicIcon.tsx";
import { VoiceInputAlert } from "./VoiceInputAlert.tsx";

const PROMPT_LINES = 3;

// keepalive's body limit is 64 KiB over all of a page's keepalive requests
// in flight; fetch refuses a larger body at once. Over this, an answer goes
// without keepalive.
const KEEPALIVE_MAX_BYTES = 60_000;

type AnswerKind = "reply" | "dismiss" | "postpone";
type AnswerBody = AskReplyReq | (AskDismissReq & AskPostponeReq);

// Each tag's name, on its button, its chip and the send button.
const TAG_LABEL: Record<AskTag, PlainMessageKey> = {
  dismiss: "asks.tag.dismiss",
  postpone: "asks.tag.postpone",
  rewrite: "asks.tag.rewrite",
};
// The suggestions above the field: a tap puts their words in the field in
// place of what it held. "File as a task" is words too: the agent files it.
const SUGGESTIONS: Partial<
  Record<AskTag, { name: string; label: PlainMessageKey }[]>
> = {
  postpone: [
    { name: "file", label: "asks.suggest.file" },
    { name: "circle-back", label: "asks.suggest.circleBack" },
  ],
  rewrite: [
    { name: "simplify", label: "asks.suggest.simplify" },
    { name: "context", label: "asks.suggest.context" },
    { name: "visuals", label: "asks.suggest.visuals" },
    { name: "answer", label: "asks.suggest.answer" },
  ],
};

// "... and automate" (task 33891b5b): the opener and the section's send
// button, named after what the card sends.
const AUTOMATE_LABEL: Record<AskTag | "reply", PlainMessageKey> = {
  reply: "asks.automateAs.reply",
  dismiss: "asks.automateAs.dismiss",
  postpone: "asks.automateAs.postpone",
  rewrite: "asks.automateAs.rewrite",
};
const AUTOMATE_SUGGESTIONS: { name: string; label: PlainMessageKey }[] = [
  { name: "pick", label: "asks.automate.suggest.pick" },
  { name: "same", label: "asks.automate.suggest.same" },
];

// A replacing tap's Undo (task 9d79a544): what the box held before the
// first tap that erased the member's words, and what the taps left. A tap
// while the line shows keeps the first `before`, so Undo brings back the
// member's words after a chain of taps. The reply field and the automate box
// each keep one.
type Replaced<B, A> = { before: B; after: A };
function afterReplacingTap<B, A>(
  shown: Replaced<B, A> | null,
  erases: boolean,
  before: B,
  after: A,
): Replaced<B, A> | null {
  return shown
    ? { before: shown.before, after }
    : erases
      ? { before, after }
      : null;
}

// The line under a box whose words a tap replaced, with Undo.
function ReplacedLine({
  automate,
  disabled,
  isMobile,
  onUndo,
}: {
  // The automate box's line, apart from the reply field's.
  automate?: boolean;
  disabled: boolean;
  isMobile: boolean;
  onUndo: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      {...(automate
        ? { "data-ask-automate-replaced": "" }
        : { "data-ask-replaced": "" })}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        color: "var(--text-dim)",
        fontSize: isMobile ? 12 : 11,
      }}
    >
      {t("asks.textReplaced")}
      <button
        type="button"
        {...(automate
          ? { "data-ask-automate-replaced-undo": "" }
          : { "data-ask-replaced-undo": "" })}
        disabled={disabled}
        onClick={onUndo}
        style={{
          padding: 0,
          border: "none",
          background: "none",
          color: "var(--accent-text)",
          fontFamily: "var(--font-ui)",
          fontSize: "inherit",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {t("asks.undo")}
      </button>
    </div>
  );
}

// Where a held answer's Undo line goes: a toast over the list, or, with no
// host, the card's own place.
export const AskUndoHost = createContext<HTMLElement | null>(null);

// An answer the card holds for the undo window. `shown` is the reply, or the
// note that goes with a dismiss or a filing (null for none); `automate`,
// whether it goes with "... and automate".
interface HeldAnswer {
  kind: AnswerKind;
  shown: string | null;
  automate: boolean;
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
    case "enterprise_secret_needed":
      return sendFailureText(t, err as ApiError);
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
  // refusal of the last tap, per command, with its code.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [runErrors, setRunErrors] = useState<
    ReadonlyMap<string, { code: string | null; text: string }>
  >(new Map());
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
  // The server runs one command of an ask at a time (task 3b648009): while
  // one runs, or a tap's answer is due, the others' Run waits, and a refusal
  // for that reason goes once nothing runs.
  const anyRunning =
    pending.size > 0 || !!entry.runs?.some((r) => r.state === "running");
  const runErrorOf = (command: string) => {
    const err = runErrors.get(command);
    return !err || (err.code === "run_in_progress" && !anyRunning)
      ? null
      : err.text;
  };
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
      setRunErrors((prev) =>
        new Map(prev).set(command, {
          code: err instanceof ApiError ? err.code : null,
          text: runErrorText(t, err),
        }),
      );
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
                    runError: runErrorOf(command),
                    pending: pending.has(command),
                    blocked: anyRunning,
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
  const {
    askDrafts,
    askTags,
    askAutomate,
    askErrors,
    agents,
    rooms,
    sessionContext,
    drafts,
  } = useAppState();
  const closedHere = useAsksClosedHere();
  const draft = askDrafts.get(entry.id);
  const untouched = draft === undefined;
  // An ask with no agent: a page from the office or an app (task 74e8fc07).
  const noAgent = entry.agentId === "";
  // The tags this ask takes: none with no agent (it has its own Dismiss),
  // only Dismiss on a reply draft to a messaging contact, which the server
  // neither postpones, files nor rewrites.
  const offered: readonly AskTag[] = noAgent
    ? []
    : entry.messaging
      ? ["dismiss"]
      : ASK_TAGS;
  // The agent's tag, when this card offers it; a later release's is ignored.
  const recommendedTag =
    offered.find((tag) => tag === entry.recommendedTag) ?? null;
  const storedTag = askTags.get(entry.id);
  // No stored tag: the card is untouched and shows the agent's.
  const tag: AskTag | null =
    storedTag === undefined ? recommendedTag : storedTag;
  const fallback =
    untouched && storedTag === undefined && recommendedTag !== null
      ? (entry.recommendedText ?? "")
      : replyDefault(entry, t("asks.replyDefault"));
  const reply = draft ?? fallback;
  // The field and tag before a tap replaced the member's words, and what the
  // taps left (replaceWords).
  const [replaced, setReplaced] = useState<Replaced<
    { draft: string | undefined; tag: AskTag | null | undefined },
    { text: string; tag: AskTag | null }
  > | null>(null);
  const replacedShown =
    replaced !== null &&
    reply === replaced.after.text &&
    tag === replaced.after.tag;
  // "... and automate" (task 33891b5b): open, the section's send is the
  // card's one send. Its words start as the agent's automateText.
  const automateDraft = askAutomate.get(entry.id);
  const automateWords = automateDraft?.text ?? entry.automateText ?? "";
  // The automate box's replacing tap, as the field's: its words before the
  // first tap (undefined: the agent's automateText), and what the taps left.
  const [automateReplaced, setAutomateReplaced] = useState<Replaced<
    string | undefined,
    string
  > | null>(null);
  const automateReplacedShown =
    automateReplaced !== null && automateWords === automateReplaced.after;
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
  // A rewrite request in flight, its refusal, and the original prompt shown.
  const [simplifying, setSimplifying] = useState(false);
  const [simplifyError, setSimplifyError] = useState<string | null>(null);
  const [undoingSimplify, setUndoingSimplify] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  // A paged ask's ack in flight, and its refusal.
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const openLink = useContext(OfficeLinkOpener);
  // A link this UI does not know is not drawn, nor one to an agent the store
  // does not have. A step on the Integrations page that the card draws
  // (AskStepBlock) is done there, so its link, kept for older clients, is
  // not drawn.
  const stepView = useStepView(entry.step, entry.memberUserId);
  const link = stepView ? null : askLinkFor(entry.link);
  // An outside page opens in a new tab and needs no office opener.
  const outside = !stepView && outsideLinkFor(entry.link) !== null;
  // Who else a shared ask is for (task 9461c464): the other members by name,
  // or the agent's room. Another member's ask names them all. Each name is
  // its own data chip; the list words between them stay translatable text.
  const names = (list: string[]) =>
    new Intl.ListFormat(language, { type: "conjunction" })
      .formatToParts(list)
      .map((part, i) =>
        part.type === "element" ? (
          <Data key={i}>{part.value}</Data>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
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
            room: <Data>{askRoom.name}</Data>,
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

  // The composer's mic on the reply field. No Ctrl+Space: that stays the
  // chat composer's. No dictated write lands while the card holds or sends
  // its answer, so Undo brings back the sent words.
  const voice = useComposerVoice({
    keywords: agents.map((a) => a.name),
    draft: () => draft ?? "",
    setDraft: (text) => {
      if (sending.current) return;
      setReplaced(null);
      dispatch({ type: "set_ask_draft", askId: entry.id, text });
    },
    send: ({ text }) => {
      if (
        sending.current ||
        automateOpen ||
        (tag === null && text.trim() === "")
      )
        return false;
      dispatch({ type: "set_ask_draft", askId: entry.id, text });
      commitTagged(text);
      return true;
    },
    onDictated: () => {
      const el = inputRef.current;
      if (!el) return;
      fitComposer(el, isMobile);
      el.scrollTop = el.scrollHeight;
    },
    pushToTalk: false,
  });
  const voiceHolds =
    voice.voiceInput === "openai" && (voice.listening || voice.transcribing);
  const answerOff = busy || voiceHolds;

  // On a touch screen the focus opens the keyboard, which moves the option
  // the member taps next to send. An option takes the tag off.
  function fillOption(option: string) {
    if (!touchPrimary) pendingFocus.current = true;
    dispatch({ type: "set_ask_draft", askId: entry.id, text: option });
    if (tag !== null)
      dispatch({ type: "set_ask_tag", askId: entry.id, tag: null });
  }

  // A tag tap empties the field, and a suggestion tap puts its words in
  // place of the field's (task 9d79a544). When that erases the member's own
  // words, a line under the field offers Undo, which brings back the words
  // and the tag from before the first such tap: a tag tap and then a
  // suggestion tap keep the line. It shows while the field still holds what
  // the taps left.
  function replaceWords(text: string, next: AskTag | null) {
    const erases = !untouched && reply.trim() !== "" && reply !== text;
    setReplaced(
      afterReplacingTap(
        replacedShown ? replaced : null,
        erases,
        { draft, tag: storedTag },
        { text, tag: next },
      ),
    );
    dispatch({ type: "set_ask_draft", askId: entry.id, text });
    dispatch({ type: "set_ask_tag", askId: entry.id, tag: next });
    if (!touchPrimary) pendingFocus.current = true;
  }

  // × and Backspace take the tag off and keep the words.
  function removeTag() {
    if (untouched)
      dispatch({ type: "set_ask_draft", askId: entry.id, text: reply });
    dispatch({ type: "set_ask_tag", askId: entry.id, tag: null });
    if (!touchPrimary) pendingFocus.current = true;
  }

  function undoReplace() {
    if (!replaced) return;
    dispatch({
      type: "set_ask_draft",
      askId: entry.id,
      text: replaced.before.draft ?? null,
    });
    dispatch({
      type: "set_ask_tag",
      askId: entry.id,
      tag: replaced.before.tag,
    });
    setReplaced(null);
    if (!touchPrimary) pendingFocus.current = true;
  }

  // An automate suggestion's words replace the box's. Only words the member
  // typed count as erased: not the agent's automateText, nor a suggestion's.
  function replaceAutomateWords(text: string) {
    const typed =
      automateDraft?.text !== undefined &&
      !AUTOMATE_SUGGESTIONS.some(({ label }) => t(label) === automateWords);
    const erases =
      typed && automateWords.trim() !== "" && automateWords !== text;
    setAutomateReplaced(
      afterReplacingTap(
        automateReplacedShown ? automateReplaced : null,
        erases,
        automateDraft?.text,
        text,
      ),
    );
    setAutomate(true, text);
  }

  function undoAutomateReplace() {
    if (!automateReplaced) return;
    const before = automateReplaced.before;
    dispatch({
      type: "set_ask_automate",
      askId: entry.id,
      automate: {
        open: true,
        ...(before !== undefined ? { text: before } : {}),
      },
    });
    setAutomateReplaced(null);
  }

  // The automate section (task 33891b5b): open or closed, and its words.
  function setAutomate(open: boolean, text?: string) {
    dispatch({
      type: "set_ask_automate",
      askId: entry.id,
      automate: {
        open,
        ...(text !== undefined
          ? { text }
          : automateDraft?.text !== undefined
            ? { text: automateDraft.text }
            : {}),
      },
    });
  }

  // The field grows with its text, an option tap, a restored draft and Undo
  // too.
  useLayoutEffect(() => {
    if (inputRef.current) fitComposer(inputRef.current, isMobile);
  }, [reply, isMobile, held]);

  // Keep this after the fit effect: layout effects run in order, and the fit
  // scrolls the field back to the top.
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const el = inputRef.current;
    if (!el) return;
    placeComposerCaret(el, el.value.length, isMobile);
  });

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

  // While the field holds the untouched default, typing replaces it.
  function selectDefault(el: HTMLTextAreaElement) {
    if (untouched) el.setSelectionRange(0, el.value.length);
  }

  // A rewrite is pending: the banner takes the place of the reply area.
  const rewriting = entry.simplifyRequestedAt !== undefined;
  // "... and automate" only where the agent could decide asks like this
  // alone (automateOffered), and not while a rewrite is pending. While the
  // section is open, its button is the card's one send.
  const automateShown = !noAgent && !rewriting && automateOffered(entry);
  const automateOpen = automateShown && automateDraft?.open === true;

  // Cite (task ad4b51ac): a selection inside the prompt shows the chat's
  // Cite pill (AskCitePill). It puts the selection into the agent's chat
  // draft, not the reply field, as Discuss in chat does: a member cites a
  // part they still have questions about (Nil, 2026-11-14; task d9a347a6).
  // Off where the chat has no Cite (citeMode).
  // The card as state, not a ref: the pill reads its box while it renders.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const citeMode = useMemo(() => citeModeHere(), []);
  const citeEnabled =
    citeMode !== null && !noAgent && !rewriting && !held && !busy;
  const { cite, clearCite } = useSelectionCite(promptRef, citeEnabled);
  function handleCite(text: string) {
    const { draft: next, caret } = insertCite(
      drafts.get(entry.agentId) ?? "",
      citationBlock(text),
    );
    dispatch({
      type: "set_draft",
      agentId: entry.agentId,
      text: next,
      focusCaret: caret,
    });
    (onChatAgent ?? onFocusAgent)?.(entry.agentId);
    clearCite();
    window.getSelection()?.removeAllRanges();
  }

  // Plain Enter sends with a mouse; a modifier, an IME or a touch screen
  // keeps the browser's Enter.
  function onReplyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    tabToReplyField(e);
    // Backspace at the field's start, with nothing selected, takes the tag
    // off; over selected words it deletes them.
    if (
      e.key === "Backspace" &&
      tag !== null &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0
    ) {
      e.preventDefault();
      removeTag();
      return;
    }
    if (e.key !== "Enter" || touchPrimary || e.nativeEvent.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    // The automate section's button is the one send while it is open.
    if (automateOpen) return;
    e.currentTarget.form?.requestSubmit();
  }

  // Enter in the automate box sends with automate, as the field's Enter.
  function onAutomateKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || touchPrimary || e.nativeEvent.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (automateSendOff) return;
    sendTagged(reply, automateWords);
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
        error: err instanceof ApiError ? sendFailureText(t, err) : String(err),
      });
    }
  }

  // `text` is a reply other than the field's, as the option a tap sends.
  // While an OpenAI clip records or transcribes, the card does not answer:
  // the spoken words are not in the field yet.
  function answer(kind: AnswerKind, text: string = reply) {
    if (voiceHolds) return;
    commit(kind, text);
  }

  // The field with its tag: the answer the send button names. Not while an
  // OpenAI clip records or transcribes, as answer.
  // `automate`: the automate box's words, with "... and automate".
  function sendTagged(text: string = reply, automate?: string) {
    if (voiceHolds) return;
    commitTagged(text, automate);
  }

  // A spoken submit sends from inside the clip's end.
  function commitTagged(text: string, automate?: string) {
    if (tag === "rewrite") {
      void rewrite(text, automate);
      return;
    }
    commit(
      tag === null ? "reply" : tag === "postpone" ? "postpone" : "dismiss",
      text,
      automate,
    );
  }

  function commit(kind: AnswerKind, text: string, automate?: string) {
    if (sending.current) return;
    if (kind === "reply" && text.trim() === "") return;
    // The browser recognizer stops and drops its pending words, which would
    // otherwise land on the answered card.
    voice.stop(true);
    sending.current = true;
    setReplaced(null);
    setAutomateReplaced(null);
    dispatch({ type: "ask_answer_started", id: entry.id });
    const device = getDevice() || undefined;
    // The field goes with a tag as it is; blank is no words.
    const reason = kind === "reply" || text.trim() === "" ? null : text;
    const withAutomate = automate !== undefined ? { automate } : {};
    const body: AnswerBody =
      kind === "reply"
        ? { text, ...(device ? { device } : {}), ...withAutomate }
        : {
            ...(reason !== null ? { text: reason } : {}),
            ...(device ? { device } : {}),
            ...withAutomate,
          };
    if (undoMs === undefined) {
      setBusy(true);
      void send(kind, body, false);
      return;
    }
    const pending: HeldAnswer = {
      kind,
      shown: kind === "reply" ? text : reason,
      automate: automate !== undefined,
      body,
      timer: setTimeout(() => flushRef.current(false), undoMs),
    };
    heldRef.current = pending;
    setHeld(pending);
    dispatch({ type: "ask_answered", id: entry.id, phase: "undo" });
  }

  // Asks the agent to rewrite the ask as the field says, in plain words when
  // it is blank. Sent at once, with no Undo hold: the ask stays, the pushed
  // ask brings the pending banner (with its own Undo), and later the
  // rewrite. Once sent, the field and its tag start again.
  async function rewrite(text: string, automate?: string) {
    if (simplifying || sending.current) return;
    setSimplifying(true);
    setSimplifyError(null);
    voice.stop(true);
    const device = getDevice() || undefined;
    const body: AskRewriteReq = {
      ...(text.trim() !== "" ? { text } : {}),
      ...(device ? { device } : {}),
      ...(automate !== undefined ? { automate } : {}),
    };
    try {
      await apiFetch("POST", `/api/asks/${entry.id}/rewrite`, body);
      dispatch({ type: "set_ask_draft", askId: entry.id, text: null });
      dispatch({ type: "set_ask_tag", askId: entry.id, tag: undefined });
      setReplaced(null);
      setAutomateReplaced(null);
      dispatch({
        type: "set_ask_automate",
        askId: entry.id,
        automate: undefined,
      });
    } catch (err) {
      setSimplifyError(
        err instanceof ApiError ? sendFailureText(t, err) : String(err),
      );
    } finally {
      setSimplifying(false);
    }
  }

  // Acks a paged ask: its alerts stop and the card stays. The pushed ask
  // brings the acked state.
  async function ackPage() {
    if (acking) return;
    setAcking(true);
    setAckError(null);
    try {
      await apiFetch("POST", `/api/asks/${entry.id}/ack`);
    } catch (err) {
      setAckError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAcking(false);
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
      setSimplifyError(
        err instanceof ApiError ? sendFailureText(t, err) : String(err),
      );
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

  // One text size for every button on the card, on phone and desktop:
  // the buttons above the field are the size of Reply under it.
  const buttonFont = 12;
  const buttonPad = isMobile ? "8px 14px" : "5px 14px";
  // A recommended button: tight space on the star's left, as on its right.
  // One shorthand either way: a longhand that comes and goes beside it is
  // cleared to 0 when it goes, so the button that loses the star would keep
  // no left padding.
  const markedPad = isMobile ? "8px 14px 8px 10px" : "5px 14px 5px 10px";
  // Filled, as on other cards: a transparent fill reads as plain text here.
  const secondaryButton = {
    padding: buttonPad,
    borderRadius: 8,
    border: filledSecondaryBtn.border,
    background: filledSecondaryBtn.background,
    color: filledSecondaryBtn.color,
    fontSize: buttonFont,
    cursor: "pointer",
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
  // An answer's refusal, else a rewrite request's, else an ack's.
  const failure = error ?? simplifyError ?? ackError;
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
              : held.kind === "postpone"
                ? shown === null
                  ? t("asks.postponed")
                  : rich("asks.postponedNote", { note: shown })
                : shown === null
                  ? t("asks.filedAsTaskPending")
                  : rich("asks.filedAsTaskPendingNote", { note: shown })}
          {held.automate && (
            <span data-ask-pending-automate="">
              {" · "}
              {t("asks.automate.held")}
            </span>
          )}
        </span>
        <button
          type="button"
          data-ask-undo=""
          onClick={undo}
          style={secondaryButton}
        >
          {t("asks.undo")}
        </button>
        <NoticeCloseButton
          type="button"
          data-ask-send-now=""
          aria-label={t("asks.sendNow")}
          title={t("asks.sendNow")}
          onClick={() => flushRef.current(false)}
        />
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
  // An ask with no agent: Dismiss is its one answer, with no words.
  const dismissButton = (
    <button
      type="button"
      data-ask-dismiss=""
      disabled={answerOff}
      onClick={() => answer("dismiss", "")}
      style={secondaryButton}
    >
      {t("asks.dismiss")}
    </button>
  );
  // The answer the send button names: Reply, or the tag on the field.
  const sendKind = tag ?? "reply";
  // The automate send: the card's answer, as the send button's rule.
  const automateSendOff =
    answerOff ||
    (tag === "rewrite" && simplifying) ||
    (tag === null && reply.trim() === "");
  // The send button and Discuss in chat: one group that wraps, under the
  // field, which takes the card's width. Reply needs words; a tag does not.
  const replyButtons = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      <button
        type="submit"
        data-ask-send={sendKind}
        disabled={automateOpen || automateSendOff}
        style={{
          padding: buttonPad,
          borderRadius: 8,
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontSize: buttonFont,
          fontWeight: 600,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {tag === null ? t("asks.reply") : t(TAG_LABEL[tag])}
      </button>
      {automateShown && (
        <button
          type="button"
          data-ask-automate-open={sendKind}
          aria-expanded={automateOpen}
          disabled={automateOpen || busy}
          onClick={() => setAutomate(true)}
          style={{
            ...secondaryButton,
            ...(automateOpen ? { opacity: 0.55, cursor: "default" } : {}),
          }}
        >
          {t(AUTOMATE_LABEL[sendKind])}
        </button>
      )}
      <AskAboutButton
        entry={entry}
        style={secondaryButton}
        disabled={busy}
        onFocusAgent={onFocusAgent}
        onChatAgent={onChatAgent}
      />
    </div>
  );
  // The tags' own hue, so they read as answers apart from the agent's
  // options and never as greyed out: a hue of its own (--ask-tag, never
  // red), filled with the send arrow on the tag that sends.
  const tagRow = offered.length > 0 && (
    <div
      data-ask-tags=""
      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
    >
      {offered.map((name) => {
        const sends = !automateOpen && tag === name;
        const recommended = name === recommendedTag;
        return (
          <button
            key={name}
            type="button"
            data-ask-tag={name}
            {...(sends ? { "data-ask-tag-sends": "" } : {})}
            {...(recommended
              ? {
                  "data-ask-tag-recommended": "",
                  title: t("asks.recommended"),
                }
              : {})}
            disabled={answerOff || (name === "rewrite" && simplifying)}
            onClick={() => (sends ? sendTagged() : replaceWords("", name))}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: recommended ? markedPad : buttonPad,
              borderRadius: 8,
              border: "1px solid var(--ask-tag-text)",
              // Filled as the options are: the text colour as the fill and
              // the page's ground as the text, readable in every theme.
              background: sends
                ? "var(--ask-tag-text)"
                : "color-mix(in srgb, var(--ask-tag) 14%, transparent)",
              color: sends ? "var(--bg-base)" : "var(--ask-tag-text)",
              fontFamily: "var(--font-ui)",
              fontSize: buttonFont,
              fontWeight: 600,
              lineHeight: 1.35,
              cursor: "pointer",
            }}
          >
            <span>
              {recommended && <RecommendedStar size={11} />}
              {t(TAG_LABEL[name])}
            </span>
            <OptionMark sends={sends} size={12} />
          </button>
        );
      })}
    </div>
  );
  const suggestionList = tag === null ? undefined : SUGGESTIONS[tag];
  const suggestionRow = suggestionList && (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {suggestionList.map(({ name, label }) => {
        const words = t(label);
        return (
          <button
            key={name}
            type="button"
            data-ask-suggestion={name}
            disabled={answerOff}
            onClick={() =>
              // A label that ends with a colon asks for words after it.
              replaceWords(words.endsWith(":") ? `${words} ` : words, tag)
            }
            style={{
              padding: isMobile ? "4px 9px" : "2px 8px",
              borderRadius: 4,
              border: "1px solid var(--accent-text)",
              background: "var(--accent-bg)",
              color: "var(--accent-text)",
              fontFamily: "var(--font-ui)",
              fontSize: buttonFont,
              cursor: "pointer",
            }}
          >
            {words}
          </button>
        );
      })}
    </div>
  );

  // Id, priority and age float at the right of the first line, and the text
  // flows under them. Above the office and member lines when the card has
  // them, else in the prompt. On mobile the id goes under priority and age.
  const metaAtTop = !!(entry.office || entry.app || entry.member || sharedLine);
  const meta = (
    <div
      data-ask-meta=""
      style={{
        float: "right",
        marginLeft: 8,
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "flex-end" : "flex-start",
        gap: isMobile ? 0 : 8,
      }}
    >
      {!isMobile && (
        <AskIdChip
          id={entry.id}
          isMobile={isMobile}
          lineHeight={`${fontSize * 1.5}px`}
        />
      )}
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
  );

  return (
    <div ref={setCardEl} data-ask={entry.id} style={cardBox}>
      {cite && cardEl && citeMode && (
        <AskCitePill
          card={cardEl}
          cite={cite}
          mode={citeMode}
          onCite={() => handleCite(cite.text)}
          clearCite={clearCite}
        />
      )}
      <div>
        {metaAtTop && meta}
        {entry.office && (
          <div
            data-ask-office=""
            style={{
              color: "var(--text-ghost)",
              fontSize: isMobile ? 12 : 11,
              lineHeight: 1.5,
              overflowWrap: "break-word",
            }}
          >
            {t("asks.fromOffice", { name: entry.office.name })}
          </div>
        )}
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
            {rich("asks.fromApp", { app: <Data>{entry.app.name}</Data> })}
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
                  <Data>{entry.member}</Data>
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
            // Starts under the meta when it floats above, over the office
            // and member lines, so the prompt keeps its full width.
            clear: "right",
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
          {/* One block, so the meta floats in the text and the clamp still
                counts its lines. */}
          <div>
            {!metaAtTop && meta}
            <AskPrompt
              content={entry.prompt}
              files={entry.readFiles}
              srcFor={askFileSrc(entry)}
              isMobile={isMobile}
            />
          </div>
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
          outside ||
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
            {outside && (
              <OutsideLinkButton link={entry.link} isMobile={isMobile} />
            )}
            {entry.originalPrompt !== undefined && (
              <button
                type="button"
                data-ask-show-original=""
                onClick={() => setShowOriginal((v) => !v)}
                style={linkButton}
              >
                {showOriginal ? t("asks.hideOriginal") : t("asks.showOriginal")}
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
      {entry.page && (
        <AskPageLine
          page={entry.page}
          acking={acking}
          onAck={() => void ackPage()}
          isMobile={isMobile}
          fontSize={fontSize}
          buttonStyle={secondaryButton}
        />
      )}
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
            }}
          >
            {t("asks.undo")}
          </button>
        </div>
      )}
      {!rewriting && !noAgent && entry.options && entry.options.length > 0 && (
        <div
          data-ask-options=""
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
        >
          {entry.options.map((option, i) => {
            const recommended = option === entry.recommended;
            // Options come trimmed from the server, and no two are the same.
            // None sends while the automate section is open.
            const sends = !automateOpen && reply.trim() === option;
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
              padding: recommended ? markedPad : buttonPad,
              borderRadius: 8,
              border: "1px solid var(--accent-text)",
              // The option that sends is the Reply button's colours; the
              // others take an accent tint.
              background: sends ? "var(--accent-text)" : "var(--accent-bg)",
              color: sends ? "var(--bg-base)" : "var(--accent-text)",
              fontFamily: "var(--font-ui)",
              fontSize: buttonFont,
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
                disabled={answerOff}
                onClick={() =>
                  sends ? answer("reply", option) : fillOption(option)
                }
                style={{ ...style, cursor: "pointer" }}
              >
                <span style={{ minWidth: 0 }}>
                  {recommended && <RecommendedStar size={11} />}
                  {/* The agent's words; the recommended mark stays translatable. */}
                  <span {...noTranslate()}>{option}</span>
                </span>
                <OptionMark sends={sends} size={12} />
              </button>
            );
          })}
        </div>
      )}
      {!rewriting && tagRow}
      {/* An ask with no agent (task 74e8fc07): nobody reads a reply, so it
          has only Dismiss, with Ack above while it rings. */}
      {noAgent ? (
        <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
          {dismissButton}
        </div>
      ) : rewriting ? null : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!automateOpen) sendTagged();
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 7,
          }}
        >
          {voice.voiceInput === "openai" ? (
            <VoiceInputAlert dictation={voice.recorded} isMobile={isMobile} />
          ) : (
            voice.error && (
              <div
                role="alert"
                style={{
                  color: "var(--red-text)",
                  fontSize: isMobile ? 12 : 11,
                }}
              >
                {voice.error}
              </div>
            )
          )}
          {suggestionRow}
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
            {/* The field's box: the tag's chip at its start, then the words. */}
            <div
              onClick={(e) => {
                if (e.target === e.currentTarget) inputRef.current?.focus();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                boxSizing: "border-box",
                paddingLeft: tag === null ? 0 : 6,
                background: "var(--bg-input)",
                border: "1px solid var(--border-light)",
                borderRadius: 8,
              }}
            >
              {tag !== null && (
                <span
                  data-ask-tag-chip={tag}
                  style={{
                    flexShrink: 0,
                    // On the first line of the words.
                    marginTop: isMobile ? 7 : 5,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: isMobile ? "2px 4px 2px 8px" : "1px 3px 1px 7px",
                    borderRadius: 5,
                    background: "var(--ask-tag-text)",
                    color: "var(--bg-base)",
                    fontFamily: "var(--font-ui)",
                    fontSize: isMobile ? 13 : 11,
                    fontWeight: 600,
                    lineHeight: isMobile ? "18px" : "14px",
                    whiteSpace: "nowrap",
                    userSelect: "none",
                  }}
                >
                  {t(TAG_LABEL[tag])}
                  <button
                    type="button"
                    data-ask-tag-chip-remove=""
                    aria-label={t("asks.removeTag")}
                    title={t("asks.removeTag")}
                    disabled={busy}
                    onClick={removeTag}
                    style={{
                      display: "flex",
                      padding: 1,
                      border: "none",
                      background: "none",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width={isMobile ? 13 : 11}
                      height={isMobile ? 13 : 11}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                      strokeLinecap="round"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
              )}
              <textarea
                ref={inputRef}
                value={reply}
                rows={1}
                disabled={busy}
                data-ask-reply-input=""
                onChange={(e) => {
                  // Typing ends the Undo line of a replacing tap.
                  setReplaced(null);
                  dispatch({
                    type: "set_ask_draft",
                    askId: entry.id,
                    // Typed words join a running dictation, so its next result
                    // does not write over them.
                    text: voice.reconcileEdit(e.target.value),
                  });
                }}
                onFocus={(e) => selectDefault(e.currentTarget)}
                onPointerDown={(e) => {
                  clickFocuses.current =
                    document.activeElement !== e.currentTarget;
                }}
                onClick={(e) => {
                  if (clickFocuses.current) selectDefault(e.currentTarget);
                  clickFocuses.current = false;
                }}
                onKeyDown={onReplyKeyDown}
                aria-label={t("asks.reply")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  boxSizing: "border-box",
                  padding: isMobile
                    ? `8px 10px 8px ${tag === null ? 10 : 2}px`
                    : `5px 10px 5px ${tag === null ? 10 : 2}px`,
                  background: "transparent",
                  border: "none",
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
            </div>
            {voice.micShown && (
              <button
                type="button"
                disabled={busy}
                aria-pressed={voice.listening}
                aria-busy={voice.transcribing || undefined}
                aria-label={t(
                  voice.transcribing
                    ? "voice.mic.transcribing"
                    : "voice.mic.talk",
                )}
                title={t(
                  voice.transcribing
                    ? "voice.mic.transcribing"
                    : "voice.mic.talk",
                )}
                onClick={voice.toggle}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: isMobile ? 38 : 28,
                  height: isMobile ? 38 : 28,
                  padding: 0,
                  borderRadius: 8,
                  border: voice.listening
                    ? "1px solid var(--red)"
                    : "1px solid var(--border-light)",
                  background: voice.listening
                    ? "rgba(255,50,50,0.15)"
                    : "var(--bg-input)",
                  color: voice.listening
                    ? "var(--red-text)"
                    : "var(--text-muted)",
                  cursor: voice.transcribing ? "progress" : "pointer",
                  opacity: voice.transcribing ? 0.6 : 1,
                  animation: voice.listening
                    ? "mic-pulse 1.5s ease-in-out infinite"
                    : "none",
                }}
              >
                <MicIcon />
              </button>
            )}
          </div>
          {replacedShown && (
            <ReplacedLine
              disabled={busy}
              isMobile={isMobile}
              onUndo={undoReplace}
            />
          )}
          {tag === "rewrite" && (
            <div
              data-ask-rewrite-hint=""
              style={{ color: "var(--text-dim)", fontSize: isMobile ? 12 : 11 }}
            >
              {t("asks.rewriteHint")}
            </div>
          )}
          {replyButtons}
        </form>
      )}
      {/* "... and automate" (task 33891b5b): under the bottom row, with
          its own box and the one send while open. */}
      {automateOpen && (
        <div
          data-ask-automate=""
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px dashed var(--border-light)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                color: "var(--text-dim)",
                fontSize: isMobile ? 12 : 11,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              {t("asks.automate.title")}
            </span>
            <NoticeCloseButton
              type="button"
              data-ask-automate-close=""
              aria-label={t("asks.automate.close")}
              title={t("asks.automate.close")}
              onClick={() => setAutomate(false)}
            />
          </div>
          <div
            style={{
              color: "var(--text-dim)",
              fontSize: isMobile ? 13 : 12,
              lineHeight: 1.45,
            }}
          >
            {t("asks.automate.guide")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {AUTOMATE_SUGGESTIONS.map(({ name, label }) => (
              <button
                key={name}
                type="button"
                data-ask-automate-suggestion={name}
                disabled={answerOff}
                onClick={() => replaceAutomateWords(t(label))}
                style={{
                  padding: isMobile ? "4px 9px" : "2px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--accent-text)",
                  background: "var(--accent-bg)",
                  color: "var(--accent-text)",
                  fontFamily: "var(--font-ui)",
                  fontSize: buttonFont,
                  cursor: "pointer",
                }}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <textarea
            value={automateWords}
            rows={2}
            disabled={busy}
            data-ask-automate-input=""
            aria-label={t("asks.automate.box")}
            onChange={(e) => {
              // Typing ends the Undo line of a replacing tap.
              setAutomateReplaced(null);
              setAutomate(true, e.target.value);
            }}
            onKeyDown={onAutomateKeyDown}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: isMobile ? "8px 10px" : "5px 10px",
              background: "var(--bg-input)",
              border: "1px solid var(--border-light)",
              borderRadius: 8,
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
              fontSize,
              lineHeight: 1.5,
              resize: "vertical",
            }}
          />
          {automateReplacedShown && (
            <ReplacedLine
              automate
              disabled={busy}
              isMobile={isMobile}
              onUndo={undoAutomateReplace}
            />
          )}
          <div>
            <button
              type="button"
              data-ask-automate-send={sendKind}
              disabled={automateSendOff}
              onClick={() => sendTagged(reply, automateWords)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: buttonPad,
                borderRadius: 8,
                border: "none",
                background: "var(--accent-text)",
                color: "var(--bg-base)",
                fontSize: buttonFont,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t(AUTOMATE_LABEL[sendKind])}
              <OptionMark sends size={12} />
            </button>
          </div>
        </div>
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
          {rich("asks.answerFailed", { error: sendFailureNode(failure) })}
        </div>
      )}
    </div>
  );
}
