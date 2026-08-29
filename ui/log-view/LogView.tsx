import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  type RefCallback,
} from "react";
import type {
  AgentInfo,
  AgentChoiceInteraction,
  AgentState,
  PendingPromptKind,
  LogEntry,
  QueuedMessage,
  Attachment,
} from "../../shared/types.ts";
import { formatIdentity } from "../../shared/identity.ts";
import {
  familyDisplayLabel,
  modelLabelImpliesEngine,
} from "../../shared/types.ts";
import { styleForModel } from "../model-styles.ts";
import { StatusLight } from "../office/StatusLight.tsx";
import { Character } from "../office/Character.tsx";
import { ghostBodyBottomOffset } from "../office/Ghost.tsx";
import { MiniGhostCluster } from "../office/MiniGhostCluster.tsx";
import {
  advanceDictationSession,
  joinSpoken,
  reconcileDictationEdit,
  startDictationSession,
} from "../spoken-punctuation.ts";
import { voiceInputErrorMessage } from "../voice-input-error.ts";
import { apiFetch } from "../api.ts";
import type { TopicReq } from "../../shared/contract-shapes.ts";
import { useAppState, useDispatch, useFeatures, useTheme } from "../store.tsx";
import {
  LogEntryCard,
  RawToolCallGroupCard,
  serializeEntries,
} from "./LogEntryCard.tsx";
import {
  findRawToolCallGroups,
  liveTailEntryIds,
  lastVisibleEntryIndex,
} from "./tool-call-groups.ts";
import { SunIcon, MoonIcon } from "../components/ThemeIcons.tsx";
import { ThemePicker } from "../components/ThemePicker.tsx";
import { NavActions, type NavAction } from "../components/NavActions.tsx";
import { ContextBattery } from "./ContextBattery.tsx";
import { SubscriptionPill } from "./SubscriptionPill.tsx";
import {
  TasksIcon,
  AgentIcon,
  EyeIcon,
  TerminalIcon,
  EditorIcon,
  CopyIcon,
  CheckIcon,
} from "../components/NavIcons.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { EditorPanel } from "./EditorPanel.tsx";
import { PanelResizer } from "./PanelResizer.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { useSlideModeEnabled } from "../hooks/useSlideMode.ts";
import { useSpeechLocale } from "../hooks/useSpeechLocale.ts";
import {
  getDevice,
  getSlideView as readSlideViewPref,
  setSlideView as writeSlideViewPref,
} from "../device-settings.ts";
import { DeckView } from "./DeckView.tsx";
import type { SlideDeckRes } from "../../shared/contract-shapes.ts";
import { useSelectionCite } from "./useSelectionCite.ts";
import { CiteSelectionButton } from "./CiteSelectionButton.tsx";
import { SkillsPopover } from "./SkillsPopover.tsx";
import { shortenCwd } from "../cwd-display.ts";
import { PENDING_PROMPT_LABEL } from "../pending-prompt.ts";

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  thinking: "Thinking",
  tool_executing: "Running tool",
};

// Header label for an agent parked on a two-step prompt (task 29daebe2). It
// sits where the activity indicator would be if a turn were running - which is
// blank for a parked agent, since `waiting_for_response` has no STATE_LABELS
// entry, so a parked agent rendered identically to one that had simply finished
// its turn. Static, with no elapsed timer: the wait ends when a human or agent
// answers, and counting up would imply the agent is working on something.
function PendingPromptLabel({ kind }: { kind: PendingPromptKind }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--orange)",
        whiteSpace: "nowrap",
      }}
    >
      {PENDING_PROMPT_LABEL[kind]}
    </span>
  );
}

// Slide Mode header toggle (design: internal-docs/slide-mode-design.md). Sits
// next to the context battery; per-device-per-agent state (device-settings). SVG
// icon, not a Unicode glyph, to dodge iOS auto-emoji recoloring.
function SlideToggleButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Switch to chat view" : "Switch to slide view"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "var(--bg-hover)" : "none",
        border: active
          ? "1px solid var(--border-medium)"
          : "1px solid transparent",
        borderRadius: 6,
        padding: "3px 5px",
        cursor: "pointer",
        color: active ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      <svg width={17} height={13} viewBox="0 0 17 13" aria-hidden="true">
        <rect
          x={0.75}
          y={0.75}
          width={15.5}
          height={11.5}
          rx={2}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.2}
        />
        <rect
          x={3.2}
          y={3.4}
          width={10.6}
          height={2}
          rx={0.5}
          fill="currentColor"
        />
        <rect
          x={3.2}
          y={6.6}
          width={7}
          height={1.6}
          rx={0.5}
          fill="currentColor"
          opacity={0.55}
        />
      </svg>
    </button>
  );
}

// Side panel size constraints. Mins below differ between terminal and editor
// because the editor's tab strip + line numbers need more horizontal room
// before content starts wrapping uselessly.
const PANEL_MIN = { terminal: 300, editor: 380 } as const;
const PANEL_MAX = { terminal: 1000, editor: 1200 } as const;
// The chat column always keeps at least this many pixels regardless of how
// far the boss drags the panel. Window-resize clamping shrinks the panel
// rather than letting the chat dip below this floor.
const CHAT_COLUMN_FLOOR = 300;

function readPanelWidth(kind: "terminal" | "editor", fallback: number): number {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(`isomux:panel-width:${kind}`);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(PANEL_MIN[kind], Math.min(PANEL_MAX[kind], n));
  } catch {
    return fallback;
  }
}

function writePanelWidth(kind: "terminal" | "editor", width: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      `isomux:panel-width:${kind}`,
      String(Math.round(width)),
    );
  } catch {}
}

const ESCALATION_AMBER_MS = 2 * 60 * 1000; // 2 minutes
const ESCALATION_RED_MS = 5 * 60 * 1000; // 5 minutes

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function escalationColor(elapsedMs: number, baseColor: string): string {
  if (elapsedMs >= ESCALATION_RED_MS) return "var(--red)";
  if (elapsedMs >= ESCALATION_AMBER_MS) return "var(--orange)";
  return baseColor;
}

// Debounce abort sends across all sites (textarea Ctrl+C, ActivityIndicator
// button, mobile Stop). Users tap Ctrl+C twice when the first tap doesn't
// visibly do anything, and the second frame races with the in-flight abort -
// see task 154e2c14 for the full investigation.
const lastAbortAtPerAgent = new Map<string, number>();
function sendAbortDebounced(agentId: string) {
  const now = performance.now();
  const last = lastAbortAtPerAgent.get(agentId) ?? 0;
  if (now - last < 2000) return;
  lastAbortAtPerAgent.set(agentId, now);
  apiFetch("POST", `/api/agents/${agentId}/abort`).catch(() => {});
}

function ActivityIndicator({
  state,
  stateChangedAt,
  agentId,
}: {
  state: AgentState;
  stateChangedAt?: number;
  agentId: string;
}) {
  const label = STATE_LABELS[state];
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!label) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [label]);

  if (!label) return null;

  const elapsedMs = stateChangedAt ? now - stateChangedAt : 0;
  const baseColor =
    state === "waiting_for_response" ? "var(--purple)" : "var(--green)";
  const color = escalationColor(elapsedMs, baseColor);
  const showAbort = elapsedMs >= ESCALATION_AMBER_MS;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 14px",
        margin: "8px 0",
        color,
        fontSize: 12,
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <span style={{ display: "inline-flex", gap: 3 }}>
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.2s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.4s",
          }}
        />
      </span>
      <span>{label}...</span>
      <span
        style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 11,
          opacity: 0.7,
        }}
      >
        {formatElapsed(elapsedMs)}
      </span>
      {showAbort && (
        <button
          onClick={() => sendAbortDebounced(agentId)}
          style={{
            marginLeft: 8,
            padding: "2px 10px",
            borderRadius: 4,
            border: `1px solid ${color}`,
            background: "transparent",
            color,
            fontSize: 11,
            cursor: "pointer",
            opacity: 0.8,
          }}
        >
          Abort
        </button>
      )}
    </div>
  );
}

function SessionSwapIndicator({ swapping }: { swapping: boolean }) {
  if (!swapping) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        color: "var(--text-muted)",
        fontSize: 12,
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <span style={{ display: "inline-flex", gap: 3 }}>
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--text-muted)",
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--text-muted)",
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.2s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--text-muted)",
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.4s",
          }}
        />
      </span>
      <span>Restarting session...</span>
    </div>
  );
}

function QueueChips({
  queue,
  agentId,
  isMobile,
}: {
  queue: QueuedMessage[];
  agentId: string;
  isMobile?: boolean;
}) {
  if (queue.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: isMobile ? 11 : 10,
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {queue.length} queued
        </span>
        <button
          onClick={() => {
            apiFetch("POST", `/api/agents/${agentId}/send-now`).catch(() => {});
          }}
          style={{
            padding: "2px 10px",
            borderRadius: 4,
            border: "1px solid var(--green)",
            background: "var(--green)",
            color: "var(--bg-base)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="Flush queued messages now (interrupts the current turn)"
        >
          Send now
        </button>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          // Keep the textarea reachable when many messages are queued. The cap
          // is 50 server-side so this can grow tall; constrain and scroll.
          maxHeight: isMobile ? 200 : 240,
          overflowY: "auto",
        }}
      >
        {queue.map((msg) => {
          // Not-from-a-human, which is what the styling below distinguishes: an
          // agent or one of this agent's own apps.
          const isAgent = msg.sender.kind !== "user";
          const label =
            msg.sender.kind === "agent"
              ? `${msg.sender.agentName} · agent · Room "${msg.sender.roomName}"`
              : msg.sender.kind === "cronjob"
                ? `${msg.sender.cronjobName} · cron job`
                : msg.sender.kind === "app"
                  ? `${msg.sender.appName} · app`
                  : formatIdentity({
                      username: msg.sender.username,
                      device: msg.sender.device,
                    }) || "You";
          const attachmentCount = msg.attachments?.length ?? 0;
          return (
            <div
              key={msg.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 8,
                background: isAgent ? "var(--bg-base)" : "var(--bg-hover)",
                border: `1px ${isAgent ? "dashed" : "solid"} var(--border-medium)`,
                fontSize: isMobile ? 13 : 12,
                fontFamily: "'JetBrains Mono',monospace",
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: isMobile ? 11 : 10,
                    fontWeight: 600,
                    color: isAgent ? "var(--text-muted)" : "var(--accent)",
                    marginBottom: 2,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    fontStyle: isAgent ? "italic" : "normal",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  queued · {label}
                </div>
                {msg.text && (
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      lineHeight: 1.4,
                      maxHeight: isMobile ? "4.2em" : "3.5em",
                      overflow: "hidden",
                      opacity: 0.9,
                    }}
                  >
                    {msg.text}
                  </div>
                )}
                {attachmentCount > 0 && (
                  <div
                    style={{
                      fontSize: isMobile ? 11 : 10,
                      color: "var(--text-muted)",
                      marginTop: msg.text ? 4 : 0,
                      fontStyle: "italic",
                    }}
                  >
                    📎 {attachmentCount} attachment
                    {attachmentCount !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  apiFetch(
                    "DELETE",
                    `/api/agents/${agentId}/queue/${msg.id}`,
                  ).catch(() => {});
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-ghost)",
                  cursor: "pointer",
                  padding: "0 2px",
                  fontSize: 16,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                title="Cancel this queued message"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HeaderTimer({
  state,
  stateChangedAt,
}: {
  state: AgentState;
  stateChangedAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = stateChangedAt ? now - stateChangedAt : 0;
  const baseColor =
    state === "waiting_for_response" ? "var(--purple)" : "var(--green)";
  const color = escalationColor(elapsedMs, baseColor);
  return (
    <>
      <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
      <span style={{ color, fontSize: 12 }}>
        {STATE_LABELS[state]} {formatElapsed(elapsedMs)}
      </span>
    </>
  );
}

export function ChoiceInteractionCard({
  interaction,
}: {
  interaction: AgentChoiceInteraction;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(value: string) {
    if (submitting) return;
    setSubmitting(value);
    setError(null);
    try {
      await apiFetch(
        "POST",
        `/api/agents/${interaction.agentId}/interactions/${interaction.id}/respond`,
        { value },
      );
    } catch {
      setSubmitting(null);
      setError("Could not apply that choice.");
    }
  }

  return (
    <section
      aria-label={interaction.title}
      style={{
        margin: "12px 0 16px",
        padding: 16,
        border: "1px solid var(--border-strong)",
        borderRadius: 12,
        background: "var(--bg-surface)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
      }}
    >
      <div
        style={{
          color: "var(--text-primary)",
          fontSize: 14,
          fontWeight: 650,
          marginBottom: 10,
        }}
      >
        {interaction.title}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {interaction.choices.map((choice, index) => (
          <button
            key={choice.value}
            type="button"
            disabled={submitting !== null}
            aria-current={choice.current ? "true" : undefined}
            onClick={() => void choose(choice.value)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              width: "100%",
              minHeight: 42,
              padding: "9px 12px",
              border: choice.current
                ? "1px solid var(--accent)"
                : "1px solid var(--border)",
              borderRadius: 9,
              color: "var(--text-primary)",
              background: choice.current ? "var(--bg-hover)" : "var(--bg-code)",
              cursor: submitting ? "wait" : "pointer",
              textAlign: "left",
              opacity: submitting && submitting !== choice.value ? 0.55 : 1,
            }}
          >
            <span>
              <span style={{ display: "block", fontWeight: 600 }}>
                {index + 1}. {choice.label}
              </span>
              {choice.description && (
                <span
                  style={{
                    display: "block",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    marginTop: 2,
                  }}
                >
                  {choice.description}
                </span>
              )}
            </span>
            {choice.current && (
              <span
                style={{ color: "var(--accent)", fontSize: 11, flexShrink: 0 }}
              >
                Current
              </span>
            )}
          </button>
        ))}
      </div>
      <div
        style={{
          color: "var(--text-secondary)",
          fontSize: 12,
          marginTop: 10,
        }}
      >
        {interaction.instruction}
      </div>
      {error && (
        <div
          role="alert"
          style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

export function LogView({
  agent,
  logs,
  onBack,
  onEditAgent,
  onOpenTasks,
  onSwipeLeft,
  onSwipeRight,
}: {
  agent: AgentInfo;
  logs: LogEntry[];
  onBack: () => void;
  onEditAgent: () => void;
  onOpenTasks?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    drafts,
    slashCommands,
    stateChangedAt,
    isMobile,
    connected,
    sidePanels,
    presences,
    sessionContext,
    interactions,
  } = useAppState();
  const interaction = interactions.find((item) => item.agentId === agent.id);
  // Use `pointer: coarse` instead of viewport `isMobile` so narrow desktop
  // windows (split-screen) with a hardware keyboard still send on Enter.
  const isTouchPrimary = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );
  const dispatch = useDispatch();
  const features = useFeatures();
  const device = getDevice();
  const { mode } = useTheme();
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const input = drafts.get(agent.id) ?? "";
  const inputRef = useRef(input);
  inputRef.current = input;
  function setInput(text: string) {
    if (isListeningRef.current) {
      dictationRef.current = reconcileDictationEdit(dictationRef.current, text);
      text = dictationRef.current.display;
    }
    dispatch({ type: "set_draft", agentId: agent.id, text });
  }
  const [autoScroll, setAutoScroll] = useState(true);
  // Slide Mode view toggle - per device, per agent. LogView can stay mounted
  // across an agent switch, so re-read the pref when agent.id changes using the
  // render-time "reset state on prop change" pattern (no effect / cascading
  // render). The per-agent pref only takes effect while the Slide Mode gate is
  // on (a per-user preference in User Settings since task 49d4e2f6); with the
  // gate off the deck entry point is hidden and an agent left on the deck
  // falls back to chat, without the pref being cleared.
  const slideModeEnabled = useSlideModeEnabled();
  const speechLocale = useSpeechLocale();
  const [slideViewPref, setSlideViewPref] = useState(() =>
    readSlideViewPref(agent.id),
  );
  const [slideViewAgentId, setSlideViewAgentId] = useState(agent.id);
  if (slideViewAgentId !== agent.id) {
    setSlideViewAgentId(agent.id);
    setSlideViewPref(readSlideViewPref(agent.id));
  }
  const slideView = slideModeEnabled && slideViewPref;
  // Chat scroll position, restored when the deck hands the view back so the
  // deck→chat edge doesn't dump the viewer at scrollTop 0 (the messages
  // container remounts). Only consulted when the viewer was NOT following the
  // bottom; when they were, the autoScroll path re-pins to the newest below.
  // Recorded on every scroll rather than on deck ENTRY, because entry isn't
  // always a click: enabling the Slide Mode gate opens the deck for an agent
  // whose pref was already on, and by the time an effect sees that transition
  // the chat element is gone. Tagged with the agent it belongs to - LogView can
  // outlive an agent switch, and one agent's position must not be applied to
  // another's chat.
  const savedChatScrollRef = useRef<{ agentId: string; top: number } | null>(
    null,
  );
  const applySlideView = (on: boolean) => {
    setSlideViewPref(on);
    writeSlideViewPref(agent.id, on);
  };
  // Seed the deck from cached slides whenever the view is (re)opened for an
  // agent. Live slide_ready pushes fill the rest; the reducer merges without
  // clobbering anything that raced ahead.
  useEffect(() => {
    if (!slideView) return;
    apiFetch<SlideDeckRes>("GET", `/api/agents/${agent.id}/slides`)
      .then((res) =>
        dispatch({
          type: "slides_loaded",
          agentId: agent.id,
          slides: res.slides ?? {},
        }),
      )
      .catch(() => {});
  }, [slideView, agent.id, dispatch]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);
  const topicSavedRef = useRef(false);
  // Whether the ↻ button can regenerate the topic. `topicStale` is a server
  // runtime flag that only flips true once a *new* message arrives during the
  // live session, so on a fresh page load (or after a restart) it stays false
  // even when there's a full conversation to re-summarize. Fall back to the
  // logs the UI already holds: gate on at least one *user* message, matching
  // what generateTopic() actually summarizes - it returns null (clearing the
  // topic) when no user message exists, so enabling on model text alone could
  // wipe an existing topic.
  const hasTopicableHistory = useMemo(
    () => logs.some((e) => e.kind === "user_message"),
    [logs],
  );
  const canRegenerateTopic = agent.topicStale || hasTopicableHistory;
  // Side panel state (terminal vs editor vs none) lives in the store keyed
  // by agent id so it survives LogView remount on agent switch. Toggling a
  // panel dispatches set_side_panel; opening one closes the other.
  const sidePanel = sidePanels.get(agent.id) ?? null;
  const terminalOpen = sidePanel === "terminal";
  const editorOpen = sidePanel === "editor";
  const [terminalWidth, setTerminalWidth] = useState<number>(() =>
    readPanelWidth("terminal", 500),
  );
  const [editorWidth, setEditorWidth] = useState<number>(() =>
    readPanelWidth("editor", 600),
  );
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<
    string | null
  >(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const commitTerminalWidth = useCallback((w: number) => {
    setTerminalWidth(w);
    writePanelWidth("terminal", w);
  }, []);
  const commitEditorWidth = useCallback((w: number) => {
    setEditorWidth(w);
    writePanelWidth("editor", w);
  }, []);
  // Live max: reading window.innerWidth at call time so a window-resize
  // mid-drag is reflected immediately (vs a value captured at mousedown).
  const getTerminalMax = useCallback(() => {
    return Math.max(
      PANEL_MIN.terminal,
      Math.min(PANEL_MAX.terminal, window.innerWidth - CHAT_COLUMN_FLOOR),
    );
  }, []);
  const getEditorMax = useCallback(() => {
    return Math.max(
      PANEL_MIN.editor,
      Math.min(PANEL_MAX.editor, window.innerWidth - CHAT_COLUMN_FLOOR),
    );
  }, []);
  // Window-resize clamp: when the boss shrinks the browser window so far
  // that the panel + min chat column would overflow, shrink the panel.
  useEffect(() => {
    function clamp() {
      const maxAllowed = Math.max(
        PANEL_MIN.terminal,
        window.innerWidth - CHAT_COLUMN_FLOOR,
      );
      setTerminalWidth((w) => (w > maxAllowed ? maxAllowed : w));
      const maxAllowedEditor = Math.max(
        PANEL_MIN.editor,
        window.innerWidth - CHAT_COLUMN_FLOOR,
      );
      setEditorWidth((w) => (w > maxAllowedEditor ? maxAllowedEditor : w));
    }
    window.addEventListener("resize", clamp);
    clamp();
    return () => window.removeEventListener("resize", clamp);
  }, []);
  // First-render flag so we can tell "user just toggled the terminal open"
  // from "agent-switch restored a previously-open terminal" - only the
  // former should grab keyboard focus from the chat textarea.
  const isFirstRenderRef = useRef(true);
  useEffect(() => {
    isFirstRenderRef.current = false;
  }, []);
  const terminalAutoFocus = !isFirstRenderRef.current;
  const setTerminalOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const prev = sidePanels.get(agent.id) === "terminal";
      const next = typeof value === "function" ? value(prev) : value;
      dispatch({
        type: "set_side_panel",
        agentId: agent.id,
        panel: next ? "terminal" : null,
      });
    },
    [dispatch, agent.id, sidePanels],
  );
  const setEditorOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const prev = sidePanels.get(agent.id) === "editor";
      const next = typeof value === "function" ? value(prev) : value;
      dispatch({
        type: "set_side_panel",
        agentId: agent.id,
        panel: next ? "editor" : null,
      });
    },
    [dispatch, agent.id, sidePanels],
  );
  // Path to focus when the editor is opened or re-targeted. Cleared after the
  // panel reads it so the user can later switch to other tabs without
  // jumping back here.
  const [editorInitialPath, setEditorInitialPath] = useState<string | null>(
    null,
  );
  const openInEditor = useCallback(
    (path: string) => {
      setEditorInitialPath(path);
      dispatch({ type: "set_side_panel", agentId: agent.id, panel: "editor" });
    },
    [dispatch, agent.id],
  );
  // The panel owns terminal status and sends this command after it receives the
  // first owner event. Repeated clicks replace this pending value, so a cold
  // panel opens with one command instead of racing a mount timer.
  const copyToTerminal = useCallback(
    (command: string) => {
      setPendingTerminalCommand(command);
      dispatch({
        type: "set_side_panel",
        agentId: agent.id,
        panel: "terminal",
      });
    },
    [dispatch, agent.id],
  );
  const handleTerminalCommandHandled = useCallback(
    () => setPendingTerminalCommand(null),
    [],
  );
  const [showAvatar, setShowAvatar] = useState(
    () => localStorage.getItem("isomux-show-avatar") !== "false",
  );
  const modelStyle = styleForModel(agent.modelFamily);
  const toggleAvatar = () =>
    setShowAvatar((prev) => {
      const next = !prev;
      localStorage.setItem("isomux-show-avatar", String(next));
      return next;
    });
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);
  const [showMicHint, setShowMicHint] = useState(false);
  const [voiceInputError, setVoiceInputError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  type StagedAttachment = Attachment & {
    id: string;
    uploading: boolean;
    error?: string;
  };
  const [stagedAttachments, setStagedAttachments] = useState<
    StagedAttachment[]
  >([]);
  const hasUploading = stagedAttachments.some((a) => a.uploading);
  const validAttachments = stagedAttachments.filter((a) => !a.error);
  const [draggingOver, setDraggingOver] = useState(false);
  const [editingLogEntryId, setEditingLogEntryId] = useState<string | null>(
    null,
  );
  const [sendError, setSendError] = useState(false);
  // Don't surface the inline error after a reconnect - `connected` flipping
  // back to true is enough signal to the user that their previous send
  // attempt is stale.
  const showSendError = sendError && !connected;
  const dragCounterRef = useRef(0);
  const swipeRef = useSwipeLeftRight(
    onSwipeLeft ?? (() => {}),
    onSwipeRight ?? (() => {}),
    isMobile,
  );
  const messagesRef: RefCallback<HTMLDivElement> = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      swipeRef(node);
    },
    // useSwipeLeftRight returns a stable callback (memoized internally), so
    // omitting swipeRef from deps is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Dismiss edit textarea when agent is no longer idle (e.g. another tab sent a message)
  useEffect(() => {
    if (agent.state !== "waiting_for_response" && editingLogEntryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditingLogEntryId(null);
    }
    // We only react to agent.state transitions, not to edit start/stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.state]);

  // Mobile keyboard fix: use visualViewport.height as the container height.
  // On mobile browsers, 100dvh/100vh do NOT shrink when the virtual keyboard
  // opens, so the input bar gets pushed behind it. By tracking the actual
  // visible viewport height and using position:fixed, the container always
  // matches exactly what's visible - keyboard or not. No scrollIntoView hacks.
  const [vpHeight, setVpHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const bannerH =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--banner-h",
          ),
        ) || 0;
      setVpHeight(vv.height - bannerH);
      window.scrollTo(0, 0);
      // When keyboard opens (viewport shrinks), scroll chat to bottom
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, [isMobile]);

  // Build merged command list for autocomplete, with origin labels and descriptions
  const agentCmds = slashCommands.get(agent.id);
  const { allCommands, skillOrigins, commandDescriptions } = useMemo(() => {
    const cmds: string[] = [];
    const origins = new Map<string, string>(); // name → origin label
    const descs = new Map<string, string>(); // name → description
    const originLabels: Record<string, string> = {
      user: "user skill",
      project: "project skill",
      plugin: "plugin skill",
      isomux: "isomux-bundled skill",
      claude: "claude skill",
    };
    if (agentCmds) {
      for (const c of agentCmds.commands) {
        // Handle both old string format and new { name, description } format
        const name = typeof c === "string" ? c : c.name;
        const desc = typeof c === "string" ? undefined : c.description;
        cmds.push(name);
        if (desc) descs.set(name, desc);
      }
      for (const s of agentCmds.skills) {
        if (!cmds.includes(s.name)) cmds.push(s.name);
        origins.set(s.name, originLabels[s.origin] ?? "skill");
        if (s.description) descs.set(s.name, s.description);
      }
    }
    return {
      allCommands: cmds.sort(),
      skillOrigins: origins,
      commandDescriptions: descs,
    };
  }, [agentCmds]);

  // Filter commands based on input
  const showAutocomplete =
    input.startsWith("/") && !input.includes(" ") && input.length > 0;
  const partial = input.slice(1).toLowerCase();
  const filteredCommands = useMemo(() => {
    if (!showAutocomplete) return [];
    if (partial === "") return allCommands;
    return allCommands.filter((c) => c.toLowerCase().startsWith(partial));
  }, [showAutocomplete, partial, allCommands]);

  // Reset selection when filter changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIdx(0);
  }, [filteredCommands.length, partial]);

  // Re-enable auto-scroll when logs are cleared (e.g. /resume, /clear)
  const prevLogsLen = useRef(logs.length);
  useEffect(() => {
    if (logs.length === 0 && prevLogsLen.current > 0) {
      setAutoScroll(true);
    }
    prevLogsLen.current = logs.length;
  }, [logs.length]);

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    const el = scrollRef.current;
    // Defer scroll until after browser layout so scrollHeight is final.
    // Double-rAF ensures content (images, code blocks, etc.) has been measured.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Skip if the user has an active selection inside the log - a
        // scrollTop assignment here combined with sibling DOM churn (e.g.
        // the sticky avatar remounting on agent.state change) clears it.
        const sel = window.getSelection();
        if (
          sel &&
          !sel.isCollapsed &&
          sel.anchorNode &&
          el.contains(sel.anchorNode)
        )
          return;
        el.scrollTop = el.scrollHeight;
      });
    });
    // `slideView` is a dep so returning from the deck re-pins to the bottom via
    // this same path when the viewer was following it (scrollRef is null while
    // the deck is shown, so the guard makes entering the deck a no-op).
  }, [logs, autoScroll, agent.state, slideView]);

  // Returning from the deck to chat: restore the exact scroll position the
  // viewer left from, whichever way the deck was entered or left (the header
  // toggle, or the Slide Mode gate flipping in Device Settings). Only when NOT
  // following the bottom - the autoScroll effect above owns the bottom-follow
  // case. useLayoutEffect so the restored position paints without a scrollTop-0
  // flash. The restore itself fires a scroll event, which just re-records the
  // same position.
  useLayoutEffect(() => {
    if (slideView) return;
    const el = scrollRef.current;
    const saved = savedChatScrollRef.current;
    if (!el || !saved || saved.agentId !== agent.id || autoScroll) return;
    el.scrollTop = saved.top;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideView]);

  // Auto-resize textarea and place cursor at end when draft is restored
  useEffect(() => {
    if (textareaRef.current && input) {
      autoResize(textareaRef.current);
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
    // Mount-only - we read `input` at mount and don't re-apply selection on
    // every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+` to toggle terminal panel
  useEffect(() => {
    function handleTerminalShortcut(e: KeyboardEvent) {
      if (isMobile || !features.terminal) return;
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setTerminalOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleTerminalShortcut);
    return () => window.removeEventListener("keydown", handleTerminalShortcut);
  }, [isMobile, features.terminal, setTerminalOpen]);

  // Ctrl+E to toggle editor panel. Sharing the side slot with the terminal -
  // opening one closes the other for v1 (40% width × two panels would crush
  // the chat).
  useEffect(() => {
    function handleEditorShortcut(e: KeyboardEvent) {
      if (isMobile || !features.editor) return;
      if (
        e.key === "e" &&
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        // Only intercept when no editor input is focused - Ctrl+E is also
        // "go to end of line" in the textarea on some platforms.
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
        if (tag === "textarea" || tag === "input") return;
        e.preventDefault();
        setEditorOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleEditorShortcut);
    return () => window.removeEventListener("keydown", handleEditorShortcut);
  }, [isMobile, features.editor, setEditorOpen]);

  // Cite-from-selection: when the boss highlights text in the chat log, show
  // a floating "Cite" pill that inserts the selection into the draft as a
  // triple-quoted block. Gated to pointer-fine devices for v1 - Nil flagged
  // mobile scroll as already finicky and asked us to never regress it. The
  // hook is a pure observer (no scroll/focus side-effects); the click handler
  // below (handleCite) is the only place we mutate draft / focus / selection.
  // Scroll-hide lives in handleScroll below - keeping the hook
  // selection-only, with the chat's existing scroll path owning geometry
  // invalidation.
  const citeEnabled = !isTouchPrimary && !editingLogEntryId;
  const { cite, clearCite } = useSelectionCite(scrollRef, citeEnabled);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    savedChatScrollRef.current = { agentId: agent.id, top: scrollTop };
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    recomputePinned();
    // Hide cite pill when the chat scrolls - its cached viewport rect goes
    // stale and `selectionchange` won't fire for a pure scroll. The hook
    // could listen at document level, but routing through this existing
    // handler avoids a second DOM listener and keeps the hook focused on
    // selection. Guard avoids a redundant render on every scroll event.
    if (cite) clearCite();
  }

  const isBusy = agent.state === "thinking" || agent.state === "tool_executing";

  // Pin a user message to the top of the chat when none are visible in the
  // viewport, so the user always has context for what they asked. The pinned
  // one is the most-recent user_message that's scrolled above the viewport.
  // We measure positions from the DOM (rather than relying on IntersectionObserver
  // history) because IO only fires on isIntersecting flips - when the auto-scroll
  // jumps from top to bottom on initial mount, middle messages go below→above
  // without ever being visible, and IO never fires for them.
  const userMsgNodesRef = useRef<Map<string, HTMLElement>>(new Map());
  // Stable per-id ref callbacks: returning the same function for the same id
  // across renders keeps React from triggering cleanup+setup on every render.
  const userMsgRefCbsRef = useRef<
    Map<string, (node: HTMLDivElement | null) => void>
  >(new Map());
  const getUserMsgRefCb = useCallback((id: string) => {
    let cb = userMsgRefCbsRef.current.get(id);
    if (!cb) {
      cb = (node: HTMLDivElement | null) => {
        if (node) userMsgNodesRef.current.set(id, node);
        else {
          userMsgNodesRef.current.delete(id);
          userMsgRefCbsRef.current.delete(id);
        }
      };
      userMsgRefCbsRef.current.set(id, cb);
    }
    return cb;
  }, []);
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(null);
  const recomputePinned = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    for (let i = logs.length - 1; i >= 0; i--) {
      const e = logs[i];
      if (e.kind !== "user_message") continue;
      const node = userMsgNodesRef.current.get(e.id);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (r.bottom > rootRect.top && r.top < rootRect.bottom) {
        // visible - no pin
        setPinnedMessageId(null);
        return;
      }
      if (r.bottom <= rootRect.top) {
        // first one above the viewport (iterating newest→oldest) wins
        setPinnedMessageId(e.id);
        return;
      }
      // else: below viewport, keep looking earlier
    }
    setPinnedMessageId(null);
  }, [logs]);
  // Recompute after every render that could affect positions, on the next
  // frame so layout has settled (including auto-scroll's double-rAF).
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(recomputePinned),
    );
    return () => cancelAnimationFrame(id);
  }, [recomputePinned, agent.state]);
  const pinnedMessage = useMemo(
    () =>
      pinnedMessageId
        ? (logs.find((e) => e.id === pinnedMessageId) ?? null)
        : null,
    [logs, pinnedMessageId],
  );
  function scrollToPinnedMessage() {
    if (!pinnedMessage) return;
    const target = userMsgNodesRef.current.get(pinnedMessage.id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Do not collapse the trailing live tool batch: active tool work stays
  // visible as it arrives, while settled history remains stable even when one
  // agent turn runs for hours.
  const liveTailIds = useMemo(
    () => liveTailEntryIds(logs, isBusy),
    [isBusy, logs],
  );
  const rawToolGroups = useMemo(
    () => findRawToolCallGroups(logs, liveTailIds),
    [liveTailIds, logs],
  );
  const rawToolGroupByFirstId = useMemo(
    () => new Map(rawToolGroups.map((group) => [group.firstId, group])),
    [rawToolGroups],
  );
  const groupedChildIds = useMemo(
    () =>
      new Set(
        rawToolGroups.flatMap((group) =>
          group.entries.slice(1).map((entry) => entry.id),
        ),
      ),
    [rawToolGroups],
  );

  // Compute agent turns: group entries between user_messages
  // For each entry, determine if it's the last in its agent turn
  const turnData = useMemo(() => {
    // Identify turn boundaries (user_message entries start a new turn)
    // Agent turn = all non-user entries after a user message, until the next user message
    let currentTurn: { startIdx: number; entries: LogEntry[] } = {
      startIdx: 0,
      entries: [],
    };
    const turns: { startIdx: number; entries: LogEntry[] }[] = [];

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      if (entry.kind === "user_message") {
        // Close previous agent turn if it has entries
        if (currentTurn.entries.length > 0) {
          turns.push(currentTurn);
        }
        // User messages are their own "turn" (no grouping needed)
        turns.push({ startIdx: i, entries: [entry] });
        currentTurn = { startIdx: i + 1, entries: [] };
      } else {
        currentTurn.entries.push(entry);
      }
    }
    if (currentTurn.entries.length > 0) {
      turns.push(currentTurn);
    }

    // Build per-entry lookup
    const entryMap = new Map<
      string,
      { isLastInTurn: boolean; turnEntries: LogEntry[] }
    >();
    for (const turn of turns) {
      if (
        turn.entries.length === 1 &&
        turn.entries[0].kind === "user_message"
      ) {
        entryMap.set(turn.entries[0].id, {
          isLastInTurn: false,
          turnEntries: [],
        });
        continue;
      }
      // Find the last entry that will actually render. Folded tool_results
      // are hidden, so the turn-level copy button needs to land on the
      // preceding visible entry (usually the matching tool_call).
      const lastVisibleIdx = lastVisibleEntryIndex(
        turn.entries,
        groupedChildIds,
      );
      for (let i = 0; i < turn.entries.length; i++) {
        entryMap.set(turn.entries[i].id, {
          isLastInTurn: i === lastVisibleIdx,
          turnEntries: turn.entries,
        });
      }
    }

    return entryMap;
  }, [logs, groupedChildIds]);

  const getConversationText = useCallback(() => serializeEntries(logs), [logs]);

  const handleCancelEdit = useCallback(() => setEditingLogEntryId(null), []);
  const handleSubmitEdit = useCallback(
    (id: string, newText: string) => {
      setEditingLogEntryId(null);
      // Fire-and-forget: the corrected turn streams back over WS; the ack is
      // ignored. username is server-derived (attributionFor), not body-sent.
      apiFetch("PATCH", `/api/agents/${agent.id}/messages/${id}`, {
        newText,
        device: device || undefined,
      }).catch(() => {});
    },
    [agent.id, device],
  );

  const handleCopy = useCallback(async () => {
    const text = getConversationText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [getConversationText]);

  const baseAgentActions: NavAction[] = [
    ...(onOpenTasks
      ? [{ id: "tasks", icon: TasksIcon, label: "Tasks", onClick: onOpenTasks }]
      : []),
    ...(logs.length > 0
      ? [
          {
            id: "copy",
            icon: copied ? CheckIcon : CopyIcon,
            label: copied ? "Copied" : "Copy",
            onClick: handleCopy,
            active: copied,
          },
        ]
      : []),
    {
      id: "settings",
      icon: AgentIcon,
      label: "Agent",
      onClick: onEditAgent,
      title: "Agent settings",
    },
    {
      id: "viewAvatar",
      icon: EyeIcon,
      label: "Avatar",
      onClick: toggleAvatar,
      active: showAvatar,
      title: "View avatar",
    },
    {
      id: "theme",
      icon: mode === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />,
      label: "Theme",
      onClick: () => setThemePickerOpen(true),
      title: "Change theme",
    },
  ];

  const desktopAgentActions: NavAction[] = (() => {
    let acts = baseAgentActions;
    if (features.editor) {
      acts = [
        ...acts,
        {
          id: "editor",
          icon: EditorIcon,
          label: "Editor",
          onClick: () => setEditorOpen((v) => !v),
          active: editorOpen,
          title: "Open file editor (Ctrl+E)",
        },
      ];
    }
    if (features.terminal) {
      acts = [
        ...acts,
        {
          id: "terminal",
          icon: TerminalIcon,
          label: "Terminal",
          onClick: () => setTerminalOpen((v) => !v),
          active: terminalOpen,
          title: "Open terminal (Ctrl+`)",
        },
      ];
    }
    return acts;
  })();

  // Mobile overflow menu - adds Editor and Terminal entries when their
  // features are enabled. The flow mirrors desktop (full-screen overlay
  // instead of a side panel - see the {isMobile && ... overlay blocks below).
  const mobileAgentActions: NavAction[] = (() => {
    let acts = baseAgentActions;
    if (features.editor) {
      acts = [
        ...acts,
        {
          id: "editor",
          icon: EditorIcon,
          label: editorOpen ? "Close editor" : "Editor",
          onClick: () => setEditorOpen((v) => !v),
          active: editorOpen,
        },
      ];
    }
    if (features.terminal) {
      acts = [
        ...acts,
        {
          id: "terminal",
          icon: TerminalIcon,
          label: terminalOpen ? "Close terminal" : "Terminal",
          onClick: () => setTerminalOpen((v) => !v),
          active: terminalOpen,
        },
      ];
    }
    return acts;
  })();

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  const SpeechRecognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition;

  // The draft text before voice started + every finalized speech segment since.
  const dictationRef = useRef(startDictationSession(""));

  function startListening() {
    if (isListeningRef.current || !SpeechRecognition) return;
    setVoiceInputError(null);
    isListeningRef.current = true;
    setIsListening(true);
    dictationRef.current = startDictationSession(inputRef.current);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    // The Web Speech API has no auto-detect: it transcribes whatever locale it
    // is told and mangles anything else, so this has to come from somewhere.
    // The user's language preference if they have set one, otherwise whatever
    // the browser reports (task e80c39c4; it was pinned to en-US before).
    recognition.lang = speechLocale;
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimRaw = "";
      const finalized: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalized.push(t);
        } else {
          interimRaw = joinSpoken(interimRaw, t);
        }
      }
      dictationRef.current = advanceDictationSession(
        dictationRef.current,
        finalized,
        interimRaw,
      );
      dispatch({
        type: "set_draft",
        agentId: agent.id,
        text: dictationRef.current.display,
      });
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          autoResize(el);
          // Keep the latest dictated text in view as the composer fills.
          el.scrollTop = el.scrollHeight;
        }
      });
    };
    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);
    };
    recognition.onerror = (event) => {
      isListeningRef.current = false;
      setIsListening(false);
      const message = voiceInputErrorMessage(event.error);
      if (message) setVoiceInputError(message);
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopListening(discard?: boolean) {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (discard) {
      // Send path: the composer was just cleared, so drop any pending final
      // result. abort() discards it, and detaching onresult stops a trailing
      // event from repopulating the box. onend still resets the listening flag.
      recognition.onresult = null;
      recognition.abort();
    } else {
      recognition.stop();
    }
  }

  // Ctrl+Space push-to-talk. Latest-ref the handlers so the mount-only
  // listener dispatches to the current agent even if agent.id changes
  // while LogView stays mounted (avoids stale-closure on dispatch / agent.id).
  const startListeningRef = useRef(startListening);
  const stopListeningRef = useRef(stopListening);
  startListeningRef.current = startListening;
  stopListeningRef.current = stopListening;
  useEffect(() => {
    if (!SpeechRecognition || !window.isSecureContext) return;
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.code === "Space" &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.repeat
      ) {
        e.preventDefault();
        startListeningRef.current();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat) {
        stopListeningRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      recognitionRef.current?.stop();
    };
    // SpeechRecognition is read once at mount; handlers go through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > 200 * 1024 * 1024) {
        const id = Math.random().toString(36).slice(2, 10);
        setStagedAttachments((prev) => [
          ...prev,
          {
            id,
            filename: "",
            originalName: file.name,
            mediaType: file.type || "application/octet-stream",
            size: file.size,
            uploading: false,
            error: "File too large (max 200MB)",
          },
        ]);
        continue;
      }
      const id = Math.random().toString(36).slice(2, 10);
      setStagedAttachments((prev) => [
        ...prev,
        {
          id,
          filename: "",
          originalName: file.name,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          uploading: true,
        },
      ]);
      const formData = new FormData();
      formData.append("file", file);
      fetch(`/api/upload/${agent.id}`, { method: "POST", body: formData })
        .then((res) => {
          if (!res.ok) throw new Error(`Upload failed (${res.status})`);
          return res.json();
        })
        .then((data: { attachments: Attachment[] }) => {
          const att = data.attachments[0];
          setStagedAttachments((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, ...att, uploading: false } : s,
            ),
          );
        })
        .catch((err) => {
          setStagedAttachments((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, uploading: false, error: err.message } : s,
            ),
          );
        });
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeStaged(id: string) {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDraggingOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDraggingOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDraggingOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      handleFileSelect(dt.files);
    }
    // If no files, let default text paste through
  }

  // Insert a multi-line block into the draft: at the caret when the textarea
  // is focused, appended at the end otherwise, always separated from
  // surrounding text by newlines. Shared by the cite pill and the terminal
  // "send to chat" affordance.
  function insertBlockIntoDraft(block: string) {
    const ta = textareaRef.current;
    const current = inputRef.current;

    let newDraft: string;
    let caretPos: number;

    if (ta && document.activeElement === ta) {
      // Insert at the textarea caret, replacing any active selection in the
      // textarea. selectionStart/End are always defined for a focused
      // textarea - fall back to end-of-draft just to be safe with edge
      // browser quirks.
      const start = ta.selectionStart ?? current.length;
      const end = ta.selectionEnd ?? current.length;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leadSep = before === "" || before.endsWith("\n") ? "" : "\n";
      const trailSep = after === "" || after.startsWith("\n") ? "" : "\n";
      const insertion = leadSep + block + trailSep;
      newDraft = before + insertion + after;
      caretPos = before.length + insertion.length;
    } else {
      // Append. Separate from any existing draft with a blank line so a
      // half-written prompt and the citation don't smush together.
      if (current === "") {
        newDraft = block;
      } else {
        const sep = current.endsWith("\n\n")
          ? ""
          : current.endsWith("\n")
            ? "\n"
            : "\n\n";
        newDraft = current + sep + block;
      }
      caretPos = newDraft.length;
    }

    setInput(newDraft);
    // The textarea is controlled - wait one frame for React to flush the new
    // value into the DOM, then focus + position caret + resize. preventScroll
    // keeps the chat from jumping when the textarea grabs focus.
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      ta2.focus({ preventScroll: true });
      ta2.setSelectionRange(caretPos, caretPos);
      autoResize(ta2);
    });
  }

  function handleCite(text: string) {
    insertBlockIntoDraft(`Cited text:\n"""\n${text}\n"""\n`);
    // Collapse the chat selection so the pill goes away. selectionchange will
    // null out the hook state too, but clearCite first for snappy feedback.
    clearCite();
    window.getSelection()?.removeAllRanges();
  }

  // Skills popover pick. A no-arg command (autoRun) EXECUTES immediately -
  // same fire-and-forget POST as handleSend, with the bare `/name` as the
  // message - instead of being copied into the draft. Everything else (skills,
  // and commands that take an argument) inserts `/name ` at the caret so the
  // user can type the rest. The popover only opens on an empty composer, so
  // auto-run never discards typed text.
  function handleSkillPick(name: string, autoRun?: boolean) {
    // Only a literal true executes - any other value (mixed-version or replay
    // wire data) falls through to the safe insert path.
    if (autoRun === true) {
      setSkillsOpen(false);
      if (!connected) {
        setSendError(true);
        return;
      }
      apiFetch("POST", `/api/agents/${agent.id}/messages`, {
        text: `/${name}`,
        device: device || undefined,
      }).catch(() => {});
      setSendError(false);
      setAutoScroll(true);
      return;
    }
    const current = inputRef.current;
    const ta = textareaRef.current;
    const snippet = `/${name} `;
    const start = Math.min(
      ta?.selectionStart ?? current.length,
      current.length,
    );
    const end = Math.min(ta?.selectionEnd ?? current.length, current.length);
    const newDraft = current.slice(0, start) + snippet + current.slice(end);
    const caretPos = start + snippet.length;
    setInput(newDraft);
    setSkillsOpen(false);
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      ta2.focus({ preventScroll: true });
      ta2.setSelectionRange(caretPos, caretPos);
      autoResize(ta2);
    });
  }

  // Terminal "send to chat": wrap the terminal selection in a fenced code
  // block and add it to the draft. The fence is longer than any backtick run
  // inside the selection so terminal output containing ``` can't break out.
  function handleTerminalSendToChat(text: string) {
    const body = text.replace(/\s+$/, "");
    if (!body) return;
    const longestRun = (body.match(/`+/g) ?? []).reduce(
      (m, r) => Math.max(m, r.length),
      0,
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    insertBlockIntoDraft(`${fence}\n${body}\n${fence}\n`);
  }

  function handleSend(opts?: { sendNow?: boolean }) {
    const text = input.trim();
    if (hasUploading || editingLogEntryId) return;
    if (!text && validAttachments.length === 0) {
      // Ctrl/Cmd+Enter with an empty composer still means "deliver the queue
      // now" - hit the same endpoint as the Send-now button instead of
      // silently doing nothing. No-op when nothing is queued.
      if (opts?.sendNow && (agent.queue ?? []).length > 0) {
        apiFetch("POST", `/api/agents/${agent.id}/send-now`).catch(() => {});
      }
      return;
    }
    const attachments =
      validAttachments.length > 0
        ? validAttachments.map(
            ({ id: _id, uploading: _u, error: _e, ...att }) => att,
          )
        : undefined;
    if (!connected) {
      // Socket isn't open - the message route is reachable over HTTP, but the
      // streamed echo won't arrive, so a "sent" message would mislead. Leave the
      // composer state intact so the user can retry once the banner clears
      // (matches the old send()===false path). The top-level ConnectionBanner
      // explains the broader state.
      setSendError(true);
      return;
    }
    // Fire-and-forget: the user_message echo + reply stream back over WS; the
    // ack ({ messageId: "" } for a USER send) is ignored. username is
    // server-derived (attributionFor), not body-sent. sendNow (Ctrl/Cmd+Enter)
    // asks the server to interrupt the current turn and flush the queue right
    // after this message lands in it - the flag is inert when the agent is
    // idle (plain send) or the message takes a non-queue path (slash command,
    // permission/multi-step reply), so it's always safe to set.
    apiFetch("POST", `/api/agents/${agent.id}/messages`, {
      text,
      device: device || undefined,
      attachments,
      ...(opts?.sendNow ? { sendNow: true } : {}),
    }).catch(() => {});
    setSendError(false);
    setInput("");
    setStagedAttachments([]);
    stopListening(true);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setAutoScroll(true);
  }

  return (
    <div
      style={{
        ...(isMobile
          ? {
              position: "fixed" as const,
              top: 0,
              left: 0,
              right: 0,
              height:
                vpHeight != null
                  ? vpHeight
                  : "calc(100dvh - var(--banner-h, 0px))",
              overflow: "hidden",
            }
          : {
              height: "calc(100vh - var(--banner-h, 0px))",
            }),
        display: "flex",
        flexDirection: isMobile ? "row" : "column",
        background: "var(--bg-base)",
        animation: "termEnter 0.3s ease-out",
      }}
    >
      {!isMobile && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            justifyContent: "space-between",
            padding: "0 16px 0 0",
            height: 48,
            background: "var(--bg-surface)",
            borderBottom: "1px solid var(--border-strong)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 16px",
              border: "none",
              borderRight: "1px solid var(--border-medium)",
              background: "var(--btn-surface)",
              color: "var(--text-dim)",
              fontSize: 13,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ← Back to Office
          </button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              flex: 1,
              minWidth: 0,
              marginLeft: 12,
            }}
          >
            <span style={{ flexShrink: 0 }}>
              <StatusLight state={agent.state} size={8} />
            </span>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 1,
                flexShrink: 0,
                minWidth: 0,
              }}
            >
              <span
                onClick={onEditAgent}
                style={{
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  lineHeight: 1.2,
                }}
                title="Edit agent"
              >
                {agent.name}
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  lineHeight: 1,
                }}
              >
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    color: "var(--text-ghost)",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  {familyDisplayLabel(agent.modelFamily)}
                </span>
                {/* Only when the model name doesn't already give the engine
                    away - "GPT-5.6 Sol · codex" says codex twice (task
                    176a5085). An unrecognized Codex slug still gets the badge,
                    since the raw slug alone doesn't identify the backend. */}
                {agent.agentType !== "claude" &&
                  !modelLabelImpliesEngine(agent.modelFamily) && (
                    <>
                      <span style={{ color: "var(--text-ghost)" }}>
                        &middot;
                      </span>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono',monospace",
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                          color: "var(--accent-blue, #5eafff)",
                          whiteSpace: "nowrap",
                        }}
                        title={`Backend: ${agent.agentType}`}
                      >
                        {agent.agentType}
                      </span>
                    </>
                  )}
              </span>
            </div>
            {STATE_LABELS[agent.state] && (
              <HeaderTimer
                state={agent.state}
                stateChangedAt={stateChangedAt.get(agent.id)}
              />
            )}
            {agent.pendingPrompt && !interaction && (
              <PendingPromptLabel kind={agent.pendingPrompt} />
            )}
            {/* Topic (conversation summary) stacked over cwd (task efdabed3):
            frees horizontal header space for the upcoming Slide Mode toggle. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 1,
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 0,
                  lineHeight: 1.2,
                }}
              >
                {agent.topic && agent.topic !== "..." && !editingTopic && (
                  <>
                    <span
                      onClick={() => {
                        setEditingTopic(true);
                        setTopicDraft(agent.topic ?? "");
                        setTimeout(() => topicInputRef.current?.focus(), 0);
                      }}
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 13,
                        cursor: "text",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                      title={agent.topic ?? "Click to edit topic"}
                    >
                      {agent.topic}
                    </span>
                    <button
                      onClick={() => {
                        apiFetch(
                          "DELETE",
                          `/api/agents/${agent.id}/topic`,
                        ).catch(() => {});
                      }}
                      disabled={!canRegenerateTopic}
                      title={
                        canRegenerateTopic
                          ? "Regenerate topic from conversation"
                          : "No conversation history to summarize"
                      }
                      style={{
                        background: "none",
                        border: "none",
                        cursor: canRegenerateTopic ? "pointer" : "default",
                        color: "var(--text-secondary)",
                        fontSize: 15,
                        padding: "0 4px",
                        opacity: canRegenerateTopic ? 0.8 : 0.3,
                        transition: "opacity 0.2s",
                        lineHeight: 1,
                      }}
                    >
                      ↻
                    </button>
                  </>
                )}
                {agent.topic === "..." && (
                  <span style={{ color: "var(--text-ghost)", fontSize: 13 }}>
                    ...
                  </span>
                )}
                {editingTopic && (
                  <input
                    ref={topicInputRef}
                    value={topicDraft}
                    onChange={(e) => setTopicDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const trimmed = topicDraft.trim();
                        if (trimmed && trimmed !== agent.topic) {
                          apiFetch("PUT", `/api/agents/${agent.id}/topic`, {
                            topic: trimmed,
                          } satisfies TopicReq).catch(() => {});
                        }
                        topicSavedRef.current = true;
                        setEditingTopic(false);
                      }
                      if (e.key === "Escape") {
                        topicSavedRef.current = true;
                        setEditingTopic(false);
                      }
                    }}
                    onBlur={() => {
                      if (topicSavedRef.current) {
                        topicSavedRef.current = false;
                        setEditingTopic(false);
                        return;
                      }
                      const trimmed = topicDraft.trim();
                      if (trimmed && trimmed !== agent.topic) {
                        apiFetch("PUT", `/api/agents/${agent.id}/topic`, {
                          topic: trimmed,
                        } satisfies TopicReq).catch(() => {});
                      }
                      setEditingTopic(false);
                    }}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border-medium)",
                      borderRadius: 4,
                      color: "var(--text-muted)",
                      fontSize: 12,
                      padding: "1px 6px",
                      outline: "none",
                      width: 200,
                    }}
                  />
                )}
              </span>
              <span
                title={agent.cwd}
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {shortenCwd(agent.cwd)}
              </span>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              marginLeft: 12,
              gap: 10,
            }}
          >
            <SubscriptionPill
              // Remount on agent/engine change so the pinned-limit state is
              // re-read for the new identity instead of being synced.
              key={`${agent.id}:${agent.agentType}`}
              usage={agent.subscriptionUsage}
              agentId={agent.id}
              provider={agent.agentType}
            />
            <ContextBattery usage={agent.contextUsage} />
            {/* Reads and flips the PREF, not the gated `slideView`: inside this
                branch the gate is on so the two agree, but a toggle driven by
                the derived value would write a gate-forced false back over the
                saved pref if it ever rendered ungated. */}
            {slideModeEnabled && (
              <SlideToggleButton
                active={slideViewPref}
                onClick={() => applySlideView(!slideViewPref)}
              />
            )}
            <NavActions actions={desktopAgentActions} viewport="desktop" />
          </div>
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
          position: "relative",
        }}
      >
        <div
          className="log-view-column"
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            position: "relative",
            containerType: "inline-size",
          }}
        >
          {/* Header */}
          {isMobile && (
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "stretch",
                padding: "0 12px 0 0",
                paddingTop: "env(safe-area-inset-top, 0px)",
                background: "var(--bg-surface)",
                borderBottom: "1px solid var(--border-strong)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={onBack}
                style={{
                  padding: "12px 14px",
                  border: "none",
                  borderRight: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-dim)",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                ←
              </button>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  overflow: "hidden",
                  padding: "8px 10px",
                  gap: 2,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusLight state={agent.state} size={8} />
                  <span
                    onClick={onEditAgent}
                    style={{
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      fontSize: 15,
                      cursor: "pointer",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.name}
                  </span>
                  {STATE_LABELS[agent.state] && (
                    <HeaderTimer
                      state={agent.state}
                      stateChangedAt={stateChangedAt.get(agent.id)}
                    />
                  )}
                  {agent.pendingPrompt && !interaction && (
                    <PendingPromptLabel kind={agent.pendingPrompt} />
                  )}
                  <SubscriptionPill
                    key={`${agent.id}:${agent.agentType}`}
                    usage={agent.subscriptionUsage}
                    agentId={agent.id}
                    provider={agent.agentType}
                    isMobile
                  />
                  <ContextBattery usage={agent.contextUsage} isMobile />
                  {slideModeEnabled && (
                    <SlideToggleButton
                      active={slideViewPref}
                      onClick={() => applySlideView(!slideViewPref)}
                    />
                  )}
                  <NavActions actions={mobileAgentActions} viewport="mobile" />
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: 16,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono',monospace",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                    }}
                  >
                    {shortenCwd(agent.cwd)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {slideView ? (
            <DeckView
              agent={agent}
              logs={logs}
              isMobile={isMobile}
              draft={input}
              onDraftChange={setInput}
              onSend={() => handleSend()}
              onExitDeck={() => applySlideView(false)}
            />
          ) : (
            <>
              {/* Pinned user message - sits between the header and the messages
          when no user_message is currently visible in the scroll viewport.
          Click scrolls the conversation back to that message. */}
              {pinnedMessage && (
                <div
                  onClick={scrollToPinnedMessage}
                  title={pinnedMessage.content}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: isMobile ? "6px 12px" : "6px 24px",
                    background: "var(--bg-subtle)",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-ghost)",
                      flexShrink: 0,
                      fontWeight: 600,
                    }}
                  >
                    ↑ you:
                  </span>
                  <span
                    style={{
                      flex: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                  >
                    {pinnedMessage.content}
                  </span>
                  <span
                    style={{
                      color: "var(--text-ghost)",
                      flexShrink: 0,
                      fontSize: 11,
                      lineHeight: 1,
                    }}
                  >
                    ↑
                  </span>
                </div>
              )}

              {/* Messages */}
              <div
                ref={messagesRef}
                onScroll={handleScroll}
                style={{
                  flex: 1,
                  overflowY: "auto",
                  overflowX: "hidden",
                  padding: isMobile ? "12px 12px" : "16px 24px",
                  color: "var(--text-secondary)",
                  position: "relative",
                }}
              >
                {/* Floating agent portrait - only mount when visible, so the
            sticky+backdrop-filter element doesn't sit in the scroll
            container's layer tree when hidden (suspected to deactivate
            selections on layout commit). */}
                {showAvatar && (
                  <div
                    style={{
                      position: "sticky",
                      top: isMobile ? 12 : 16,
                      float: "right",
                      marginRight: 0,
                      zIndex: 10,
                      height: 78,
                      display: "flex",
                      alignItems: "flex-end",
                      justifyContent: "center",
                    }}
                  >
                    <MiniGhostCluster
                      presences={presences}
                      selfConnectionId={sessionContext?.connectionId ?? null}
                      size={30}
                      max={3}
                      overlap={-8}
                      paintedHitTest
                      filter={(presence) =>
                        presence.viewMode === "log" &&
                        presence.focusedAgentId === agent.id
                      }
                      ghostStyle={{
                        transform: `translateY(${ghostBodyBottomOffset(30)}px)`,
                      }}
                    />
                    <div
                      onClick={onEditAgent}
                      style={{
                        width: 62,
                        height: 78,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 8,
                        border: `2px solid ${modelStyle.border}`,
                        background: modelStyle.bg,
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                        cursor: "pointer",
                        transition: "opacity 0.2s",
                      }}
                      title="Edit agent"
                    >
                      <Character
                        key={agent.state}
                        state={agent.state}
                        outfit={agent.outfit}
                      />
                    </div>
                  </div>
                )}
                {logs.length === 0 && (
                  <div
                    style={{
                      color: "var(--text-ghost)",
                      textAlign: "center",
                      marginTop: 40,
                    }}
                  >
                    {connected
                      ? "Send a message to start a conversation."
                      : "Loading..."}
                  </div>
                )}
                {logs.map((entry) => {
                  if (entry.metadata?.interactionFallback === true) return null;
                  if (groupedChildIds.has(entry.id)) return null;
                  const td = turnData.get(entry.id);
                  const rawToolGroup = rawToolGroupByFirstId.get(entry.id);
                  const canEditMsg =
                    entry.kind === "user_message" &&
                    agent.state === "waiting_for_response" &&
                    !editingLogEntryId &&
                    agent.capabilities.edit;
                  const isUserMsg = entry.kind === "user_message";
                  return (
                    <div
                      key={entry.id}
                      ref={isUserMsg ? getUserMsgRefCb(entry.id) : undefined}
                    >
                      {rawToolGroup ? (
                        <RawToolCallGroupCard
                          entries={rawToolGroup.entries}
                          isLastInTurn={td?.isLastInTurn}
                          turnEntries={td?.turnEntries}
                          isMobile={isMobile}
                          onCopyToTerminal={
                            features.terminal ? copyToTerminal : undefined
                          }
                        />
                      ) : (
                        <LogEntryCard
                          entry={entry}
                          isLastInTurn={td?.isLastInTurn}
                          turnEntries={td?.turnEntries}
                          isMobile={isMobile}
                          canEdit={canEditMsg}
                          isEditing={editingLogEntryId === entry.id}
                          onStartEdit={setEditingLogEntryId}
                          onCancelEdit={handleCancelEdit}
                          onSubmitEdit={handleSubmitEdit}
                          onOpenInEditor={
                            features.editor ? openInEditor : undefined
                          }
                          onCopyToTerminal={
                            features.terminal ? copyToTerminal : undefined
                          }
                        />
                      )}
                    </div>
                  );
                })}
                {interaction && (
                  <ChoiceInteractionCard interaction={interaction} />
                )}
                <ActivityIndicator
                  state={agent.state}
                  stateChangedAt={stateChangedAt.get(agent.id)}
                  agentId={agent.id}
                />
              </div>

              {/* Input */}
              <div
                style={{
                  position: "relative",
                  flexShrink: 0,
                  padding: isMobile
                    ? "10px 12px 10px 11px"
                    : "10px 24px 10px 11px",
                  paddingBottom: isMobile
                    ? "calc(10px + env(safe-area-inset-bottom, 0px))"
                    : undefined,
                  borderTop: draggingOver
                    ? "2px solid var(--green)"
                    : "2px solid var(--border-strong)",
                  background: draggingOver
                    ? "var(--bg-hover)"
                    : "var(--bg-surface)",
                  transition: "background 0.15s, border-color 0.15s",
                }}
              >
                {/* Scroll to bottom - anchored above the composer's top edge so it
            can never overlap the input controls, no matter how tall the
            composer grows (multiline draft, queue chips, attachments). */}
                {!autoScroll && (
                  <button
                    onClick={() => {
                      if (scrollRef.current) {
                        scrollRef.current.scrollTop =
                          scrollRef.current.scrollHeight;
                      }
                      setAutoScroll(true);
                    }}
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 12px)",
                      right: 32,
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      border: "1px solid var(--border-medium)",
                      background: "var(--bg-surface)",
                      color: "var(--text-muted)",
                      fontSize: 16,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                      zIndex: 5,
                      transition: "opacity 0.15s",
                    }}
                    title="Scroll to bottom"
                  >
                    ↓
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
                <SessionSwapIndicator
                  swapping={agent.sessionSwapping ?? false}
                />
                {showSendError && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 8,
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: "var(--red-bg, rgba(192,57,43,0.12))",
                      border: "1px solid var(--red, #c0392b)",
                      color: "var(--red, #c0392b)",
                      fontSize: isMobile ? 12 : 11,
                      fontWeight: 600,
                    }}
                  >
                    <span>⚠</span>
                    <span>
                      Couldn't send - reconnecting. Your message is still in the
                      box; try again once the banner clears.
                    </span>
                  </div>
                )}
                {voiceInputError && (
                  <div
                    role="alert"
                    style={{
                      marginBottom: 8,
                      color: "var(--red)",
                      fontSize: isMobile ? 12 : 11,
                    }}
                  >
                    {voiceInputError}
                  </div>
                )}
                <QueueChips
                  queue={agent.queue ?? []}
                  agentId={agent.id}
                  isMobile={isMobile}
                />
                {stagedAttachments.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginBottom: 8,
                    }}
                  >
                    {stagedAttachments.map((att) => (
                      <div
                        key={att.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 8px",
                          borderRadius: 6,
                          background: att.error
                            ? "var(--red-bg)"
                            : "var(--bg-hover)",
                          border: `1px solid ${att.error ? "var(--red)" : "var(--border)"}`,
                          fontSize: isMobile ? 13 : 11,
                          fontFamily: "'JetBrains Mono',monospace",
                          color: att.error
                            ? "var(--red)"
                            : "var(--text-secondary)",
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
                            uploading…
                          </span>
                        )}
                        {att.error && (
                          <span style={{ fontSize: isMobile ? 11 : 10 }}>
                            {att.error}
                          </span>
                        )}
                        <button
                          onClick={() => removeStaged(att.id)}
                          style={{
                            background: "none",
                            border: "none",
                            color: att.error
                              ? "var(--red)"
                              : "var(--text-ghost)",
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
                {skillsOpen && input.trim() === "" && (
                  <SkillsPopover
                    skills={agentCmds?.skills ?? []}
                    commands={agentCmds?.commands ?? []}
                    isMobile={isMobile}
                    onPick={handleSkillPick}
                    onClose={() => setSkillsOpen(false)}
                  />
                )}
                <div
                  style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
                >
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
                      transition: "opacity 0.15s",
                    }}
                    title="Attach files"
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
                  {(agentCmds?.skills.length ?? 0) +
                    (agentCmds?.commands.length ?? 0) >
                    0 &&
                    // Only offered on an empty draft: slash commands/skills are
                    // recognized only as the very first thing in a message
                    // (agent-manager isSlash checks startsWith), so mid-draft
                    // insertion would produce text that never expands.
                    input.trim() === "" && (
                      // Plain-text "Sk" on purpose: decorative Unicode glyphs get
                      // hijacked by iOS Safari's emoji renderer (see the ▶ note in
                      // TerminalPanel), and plain text needs no such gating.
                      <button
                        data-skills-toggle
                        onClick={() => setSkillsOpen((o) => !o)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: skillsOpen
                            ? "var(--green)"
                            : "var(--text-muted)",
                          cursor: "pointer",
                          // Flex-center the glyph in the same 20px box the paperclip
                          // occupies, then nudge up to optically match the svg's
                          // baseline-driven position (it sat visibly low before).
                          display: "flex",
                          alignItems: "center",
                          height: 20,
                          position: "relative",
                          top: -2,
                          fontSize: 12,
                          fontWeight: 700,
                          fontFamily: "'JetBrains Mono',monospace",
                          flexShrink: 0,
                          opacity: skillsOpen ? 1 : 0.7,
                          transition: "opacity 0.15s, color 0.15s",
                        }}
                        title="Skills & commands"
                      >
                        Sk
                      </button>
                    )}
                  <span
                    style={{
                      color: isBusy ? "var(--text-ghost)" : "var(--green)",
                      fontWeight: 600,
                      lineHeight: "20px",
                      position: "relative",
                      top: -2,
                    }}
                  >
                    &#10095;
                  </span>
                  <div style={{ flex: 1, position: "relative", top: -2 }}>
                    {showAutocomplete && filteredCommands.length > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: "100%",
                          left: 0,
                          right: 0,
                          marginBottom: 4,
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-medium)",
                          borderRadius: 8,
                          maxHeight: 200,
                          overflowY: "auto",
                          boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
                          zIndex: 10,
                        }}
                      >
                        {filteredCommands.map((cmd, i) => {
                          const originLabel = skillOrigins.get(cmd);
                          const desc = commandDescriptions.get(cmd);
                          return (
                            <div
                              key={cmd}
                              ref={
                                i === selectedIdx
                                  ? (el) =>
                                      el?.scrollIntoView({ block: "nearest" })
                                  : undefined
                              }
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setInput(`/${cmd} `);
                                textareaRef.current?.focus();
                              }}
                              onMouseEnter={() => setSelectedIdx(i)}
                              style={{
                                padding: "6px 12px",
                                cursor: "pointer",
                                background:
                                  i === selectedIdx
                                    ? "var(--bg-subtle)"
                                    : "transparent",
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              <span
                                style={{
                                  color: "var(--green)",
                                  fontFamily: "'JetBrains Mono',monospace",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  flexShrink: 0,
                                }}
                              >
                                /{cmd}
                              </span>
                              {originLabel && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    color: "var(--text-ghost)",
                                    background: "var(--bg-base)",
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    flexShrink: 0,
                                  }}
                                >
                                  {originLabel}
                                </span>
                              )}
                              {desc && (
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: "var(--text-ghost)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {desc}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <textarea
                      ref={textareaRef}
                      value={input}
                      onPaste={handlePaste}
                      onChange={(e) => {
                        setInput(e.target.value);
                        autoResize(e.target);
                      }}
                      onKeyDown={(e) => {
                        // While the OS IME is composing (CJK / accent input), let
                        // the composition consume Enter and other keys; we don't
                        // want to send, autocomplete, or abort mid-composition.
                        if (e.nativeEvent.isComposing) return;
                        // Autocomplete navigation
                        if (showAutocomplete && filteredCommands.length > 0) {
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setSelectedIdx((prev) =>
                              prev > 0 ? prev - 1 : filteredCommands.length - 1,
                            );
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setSelectedIdx((prev) =>
                              prev < filteredCommands.length - 1 ? prev + 1 : 0,
                            );
                            return;
                          }
                          if (e.key === "Tab") {
                            e.preventDefault();
                            const selected = filteredCommands[selectedIdx];
                            if (selected) {
                              setInput(`/${selected} `);
                            }
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            const selected = filteredCommands[selectedIdx];
                            // If exact match, send it; otherwise autocomplete
                            if (
                              selected &&
                              partial === selected.toLowerCase()
                            ) {
                              // Exact match - fall through to send
                            } else if (selected) {
                              e.preventDefault();
                              setInput(`/${selected} `);
                              return;
                            }
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setInput("");
                            return;
                          }
                        }
                        if (
                          e.key === "Enter" &&
                          (e.ctrlKey || e.metaKey) &&
                          !isTouchPrimary
                        ) {
                          // Ctrl/Cmd+Enter: "deliver now". Identical to plain Enter
                          // when the agent is idle; when it's busy, the server
                          // interrupts the current turn and flushes the queue (same
                          // machinery as the Send-now button). Must be checked
                          // BEFORE the plain-Enter branch below, whose condition
                          // also matches modifier+Enter.
                          e.preventDefault();
                          handleSend({ sendNow: true });
                          return;
                        }
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
                        if (
                          e.key === "c" &&
                          (e.ctrlKey || e.metaKey) &&
                          isBusy
                        ) {
                          // Don't intercept Ctrl/Cmd+C while the user has a real
                          // selection - they're trying to copy. The textarea is no
                          // longer disabled while busy (typing now queues), so this
                          // path is more reachable than before.
                          const sel = window.getSelection()?.toString() ?? "";
                          if (!sel) {
                            e.preventDefault();
                            sendAbortDebounced(agent.id);
                          }
                        }
                      }}
                      placeholder={
                        editingLogEntryId
                          ? "Editing message above..."
                          : isBusy
                            ? isMobile
                              ? "Type to queue..."
                              : `Type to queue - sends when current turn ends · ${(navigator.platform || "").includes("Mac") ? "⌘" : "Ctrl+"}Enter to send now`
                            : isMobile
                              ? "Type a message..."
                              : "Type a message or / for commands..."
                      }
                      autoFocus={!isMobile}
                      rows={1}
                      style={{
                        width: "100%",
                        background: "transparent",
                        border: "none",
                        outline: "none",
                        color:
                          isBusy || editingLogEntryId
                            ? "var(--text-muted)"
                            : "var(--text-secondary)",
                        fontFamily: "'JetBrains Mono',monospace",
                        fontSize: isMobile ? 16 : 13,
                        caretColor: "var(--green)",
                        resize: "none",
                        padding: "0 0 4px",
                        lineHeight: "20px",
                        maxHeight: 200,
                        overflowY: "auto",
                      }}
                    />
                  </div>
                  {SpeechRecognition && window.isSecureContext ? (
                    <button
                      // Toggle: click to start dictation, click again to stop.
                      onClick={() => {
                        if (isListeningRef.current) stopListening();
                        else startListening();
                      }}
                      style={{
                        flexShrink: 0,
                        // Pin to the row's bottom edge (viewport-stable) so the
                        // button doesn't ride up as dictation fills the textarea.
                        // marginTop -9 keeps the single-line position unchanged.
                        alignSelf: "flex-end",
                        width: 36,
                        height: 36,
                        marginTop: -9,
                        touchAction: "none",
                        borderRadius: 6,
                        border: isListening
                          ? "1px solid var(--red)"
                          : "1px solid var(--border)",
                        background: isListening
                          ? "rgba(255,50,50,0.15)"
                          : "transparent",
                        color: isListening ? "var(--red)" : "var(--text-muted)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                        transition: "all 0.15s",
                        animation: isListening
                          ? "mic-pulse 1.5s ease-in-out infinite"
                          : "none",
                        userSelect: "none",
                        WebkitUserSelect: "none",
                      }}
                      title="Click to talk (Ctrl+Space to hold)"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="1" width="6" height="12" rx="3" />
                        <path d="M5 10a7 7 0 0 0 14 0" />
                        <line x1="12" y1="17" x2="12" y2="23" />
                        <line x1="8" y1="23" x2="16" y2="23" />
                      </svg>
                    </button>
                  ) : SpeechRecognition && !window.isSecureContext ? (
                    <div
                      style={{
                        position: "relative",
                        flexShrink: 0,
                        alignSelf: "flex-end",
                      }}
                    >
                      <button
                        onClick={() => setShowMicHint((v) => !v)}
                        style={{
                          width: 36,
                          height: 36,
                          marginTop: -9,
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "transparent",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                          opacity: 0.4,
                        }}
                        title="Voice input requires HTTPS"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="1" width="6" height="12" rx="3" />
                          <path d="M5 10a7 7 0 0 0 14 0" />
                          <line x1="12" y1="17" x2="12" y2="23" />
                          <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                      </button>
                      {showMicHint && (
                        <div
                          style={{
                            position: "absolute",
                            bottom: "calc(100% + 8px)",
                            right: 0,
                            width: 320,
                            background: "var(--bg-surface)",
                            border: "1px solid var(--border-medium)",
                            borderRadius: 8,
                            padding: "12px 14px",
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                            zIndex: 20,
                            animation: "fadeIn 0.1s ease-out",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 600,
                              marginBottom: 8,
                              color: "var(--text-primary)",
                            }}
                          >
                            Voice input requires HTTPS
                          </div>
                          <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
                            Enable HTTPS in your{" "}
                            <span style={{ color: "var(--text-primary)" }}>
                              Tailscale admin console
                            </span>{" "}
                            (DNS page), then run these on the host (use the
                            built-in terminal):
                          </div>
                          <code
                            style={{
                              display: "block",
                              background: "var(--bg-base)",
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              padding: "8px 10px",
                              fontSize: 11,
                              fontFamily: "'JetBrains Mono',monospace",
                              color: "var(--text-secondary)",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-all",
                              lineHeight: 1.6,
                            }}
                          >
                            {`sudo tailscale set --operator=$USER\ntailscale serve --bg http://localhost:${window.location.port || "4000"}`}
                          </code>
                          <div
                            style={{
                              marginTop: 8,
                              lineHeight: 1.5,
                              color: "var(--text-muted)",
                            }}
                          >
                            Visit the HTTPS URL Tailscale prints (e.g.{" "}
                            <code
                              style={{
                                background: "var(--bg-base)",
                                padding: "1px 5px",
                                borderRadius: 3,
                                fontFamily: "'JetBrains Mono',monospace",
                                fontSize: 11,
                              }}
                            >
                              https://my-mac-mini.&lt;tailnet&gt;.ts.net
                            </code>
                            ).
                          </div>
                          <button
                            onClick={() => setShowMicHint(false)}
                            style={{
                              position: "absolute",
                              top: 8,
                              right: 10,
                              background: "none",
                              border: "none",
                              color: "var(--text-ghost)",
                              cursor: "pointer",
                              fontSize: 14,
                              padding: 0,
                            }}
                          >
                            &times;
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                  {isMobile &&
                    (isBusy &&
                    (agent.queue ?? []).length === 0 &&
                    !input.trim() &&
                    validAttachments.length === 0 ? (
                      <button
                        onClick={() => sendAbortDebounced(agent.id)}
                        style={{
                          flexShrink: 0,
                          alignSelf: "flex-end",
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          border: "1px solid var(--red)",
                          background: "transparent",
                          color: "var(--red)",
                          fontSize: 16,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          lineHeight: 1,
                        }}
                        title="Abort"
                      >
                        ■
                      </button>
                    ) : (
                      <button
                        // Wrapped so the click's MouseEvent doesn't leak into
                        // handleSend's opts parameter.
                        onClick={() => handleSend()}
                        disabled={
                          (!input.trim() && validAttachments.length === 0) ||
                          hasUploading ||
                          !!editingLogEntryId
                        }
                        style={{
                          flexShrink: 0,
                          alignSelf: "flex-end",
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          border: "none",
                          background:
                            (input.trim() || validAttachments.length > 0) &&
                            !hasUploading &&
                            !editingLogEntryId
                              ? "var(--green)"
                              : "var(--bg-hover)",
                          color:
                            (input.trim() || validAttachments.length > 0) &&
                            !hasUploading &&
                            !editingLogEntryId
                              ? "var(--bg-base)"
                              : "var(--text-ghost)",
                          fontSize: 16,
                          cursor:
                            (input.trim() || validAttachments.length > 0) &&
                            !hasUploading &&
                            !editingLogEntryId
                              ? "pointer"
                              : "default",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          lineHeight: 1,
                          transition: "background 0.15s, color 0.15s",
                        }}
                        title={isBusy ? "Queue message" : "Send"}
                      >
                        ▲
                      </button>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
        {features.terminal && !isMobile && terminalOpen && (
          <div
            ref={terminalContainerRef}
            style={{
              width: terminalWidth,
              flexShrink: 0,
              position: "relative",
            }}
          >
            <PanelResizer
              panelRef={terminalContainerRef}
              min={PANEL_MIN.terminal}
              getMax={getTerminalMax}
              onCommit={commitTerminalWidth}
            />
            <TerminalPanel
              agentId={agent.id}
              onClose={() => setTerminalOpen(false)}
              autoFocus={terminalAutoFocus}
              onSendToChat={handleTerminalSendToChat}
              pendingCommand={pendingTerminalCommand}
              onCommandHandled={handleTerminalCommandHandled}
            />
          </div>
        )}
        {features.editor && !isMobile && editorOpen && (
          <div
            ref={editorContainerRef}
            style={{ width: editorWidth, flexShrink: 0, position: "relative" }}
          >
            <PanelResizer
              panelRef={editorContainerRef}
              min={PANEL_MIN.editor}
              getMax={getEditorMax}
              onCommit={commitEditorWidth}
            />
            <EditorPanel
              agentId={agent.id}
              initialPath={editorInitialPath}
              onClose={() => setEditorOpen(false)}
              onPathOpened={() => setEditorInitialPath(null)}
            />
          </div>
        )}
      </div>
      {/* Mobile side panel: full-screen overlay above the chat column. The
        outer LogView is position:fixed and sized to vpHeight on mobile, so
        this absolute child inherits the visible viewport via height: 100%
        - when the soft keyboard opens vpHeight shrinks and we shrink
        with it. paddingTop honors the safe-area inset so the panel header
        clears the camera notch / Dynamic Island on iOS. */}
      {isMobile && features.terminal && terminalOpen && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "100%",
            paddingTop: "env(safe-area-inset-top, 0px)",
            boxSizing: "border-box",
            background: "var(--bg-base)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <TerminalPanel
            agentId={agent.id}
            onClose={() => setTerminalOpen(false)}
            autoFocus={terminalAutoFocus}
            mobile
            pendingCommand={pendingTerminalCommand}
            onCommandHandled={handleTerminalCommandHandled}
            // On mobile the terminal is a full-screen overlay covering the
            // composer, so also close it - otherwise the insert would be
            // invisible and the tap would appear to do nothing.
            onSendToChat={(text) => {
              handleTerminalSendToChat(text);
              setTerminalOpen(false);
            }}
          />
        </div>
      )}
      {isMobile && features.editor && editorOpen && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "100%",
            // Symmetric notch + home-indicator insets so the editor chrome
            // never sits under the camera island or the home bar. The editor
            // has no soft-key bar (CodeMirror 6 handles touch input natively),
            // so we don't need the keyboard-aware bottom-pad gymnastics that
            // TerminalPanel does.
            paddingTop: "env(safe-area-inset-top, 0px)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            boxSizing: "border-box",
            background: "var(--bg-base)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <EditorPanel
            agentId={agent.id}
            initialPath={editorInitialPath}
            onClose={() => setEditorOpen(false)}
            onPathOpened={() => setEditorInitialPath(null)}
            mobile
          />
        </div>
      )}
      <ThemePicker
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
      />
      {cite && scrollRef.current && (
        <CiteSelectionButton
          cite={cite}
          containerRect={scrollRef.current.getBoundingClientRect()}
          onClick={() => handleCite(cite.text)}
        />
      )}
    </div>
  );
}
