import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, LogEntry, SlideRecord } from "../../shared/types.ts";
import { buildDeckTurns, type DeckTurn } from "../../shared/slide-turns.ts";
import {
  SLIDE_W,
  SLIDE_H,
  buildSlideSrcDoc,
} from "../../shared/slide-frame.ts";
import type { EnsureSlideRes } from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { useAppState, useDispatch } from "../store.tsx";

// Slide Mode deck view (design: internal-docs/slide-mode-design.md).
//
// Renders the conversation as a deck — one position per assistant turn, 1:1 with
// the chat (placeholders included) — instead of the message list. Slides are
// self-contained inline-styled HTML fragments rendered ONLY inside a sandboxed
// iframe with a restrictive CSP (shared/slide-frame.ts); the fragment never
// touches the app DOM. Nav with ←/→ (buttons + arrow keys), a counter, the
// turn's frozen prompt beneath each slide, and the composer on the newest
// position (wired to the parent's normal send path).

// How long a requested slide may stay pending before we show the text fallback.
const PENDING_FALLBACK_MS = 20_000;

function isAgentActive(agent: AgentInfo): boolean {
  return agent.state === "thinking" || agent.state === "tool_executing";
}

export function DeckView({
  agent,
  logs,
  isMobile,
  draft,
  onDraftChange,
  onSend,
  onExitDeck,
}: {
  agent: AgentInfo;
  logs: LogEntry[];
  isMobile?: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onExitDeck: () => void;
}) {
  const { slides, connected } = useAppState();
  const dispatch = useDispatch();
  const slidesForAgent = slides.get(agent.id);

  // Deck positions, in display order (timestamp; stable sort keeps arrival order
  // on ties) — the same 1:1 mapping the server keys slides on.
  const turns = useMemo<DeckTurn[]>(() => {
    const ordered = [...logs].sort((a, b) => a.timestamp - b.timestamp);
    return buildDeckTurns(ordered);
  }, [logs]);

  const [index, setIndex] = useState(0);
  const atEndRef = useRef(true);
  const active = isAgentActive(agent);

  // Track "was on the last slide" so a new turn auto-advances only then.
  const wasAtEnd = index >= turns.length - 1;
  useEffect(() => {
    atEndRef.current = wasAtEnd;
  }, [wasAtEnd]);

  // Clamp / auto-advance when the deck grows or shrinks.
  useEffect(() => {
    const last = Math.max(0, turns.length - 1);
    setIndex((cur) => {
      if (cur > last) return last;
      if (atEndRef.current) return last;
      return cur;
    });
  }, [turns.length]);

  // ←/→ arrow-key navigation, scoped to ignore text-editing targets so the
  // feedback field / composer aren't hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => Math.min(turns.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turns.length]);

  // Per-turn request bookkeeping: entryId → time we POSTed ensure-slide. Drives
  // the pending→fallback timeout without re-requesting on every render.
  const requestedRef = useRef<Map<string, number>>(new Map());
  // A ticking clock, advanced by the interval below, so the fallback timeout is
  // derived from state (pure to read in render) rather than Date.now().
  const [nowTs, setNowTs] = useState(0);

  // Ensure the focused slide + its two neighbors. The newest position waits
  // until the agent settles so we never format a half-streamed turn.
  useEffect(() => {
    if (turns.length === 0) return;
    const wanted = [index, index + 1, index - 1].filter(
      (i) => i >= 0 && i < turns.length,
    );
    for (const i of wanted) {
      const turn = turns[i];
      if (slidesForAgent?.get(turn.entryId)) continue;
      if (requestedRef.current.has(turn.entryId)) continue;
      const isLast = i === turns.length - 1;
      if (isLast && active) continue;
      requestedRef.current.set(turn.entryId, Date.now());
      ensure(turn.entryId, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, turns, slidesForAgent, active, agent.id]);

  // While anything is pending, tick so an expired request flips to the fallback.
  useEffect(() => {
    const anyPending = turns.some(
      (t) =>
        !slidesForAgent?.get(t.entryId) && requestedRef.current.has(t.entryId),
    );
    if (!anyPending) return;
    setNowTs(Date.now());
    const h = setInterval(() => setNowTs(Date.now()), 2000);
    return () => clearInterval(h);
  }, [turns, slidesForAgent]);

  function ensure(
    entryId: string,
    opts: { force?: boolean; feedback?: string },
  ) {
    apiFetch<EnsureSlideRes>(
      "POST",
      `/api/agents/${agent.id}/slides/${entryId}`,
      opts,
    )
      .then((res) => {
        if (res.status === "ready") {
          dispatch({
            type: "slide_ready",
            agentId: agent.id,
            sessionId: "",
            entryId,
            slide: res.slide,
          });
        }
        // "pending" → the slide arrives via the slide_ready WS push.
        // "unavailable" → nothing to render; the fallback timeout covers it.
      })
      .catch(() => {
        // Let it retry: drop the marker so a later pass can re-request.
        requestedRef.current.delete(entryId);
      });
  }

  function regen(entryId: string, feedback?: string) {
    requestedRef.current.set(entryId, Date.now());
    ensure(entryId, { force: true, feedback });
  }

  const cur = turns[index];
  const curSlide = cur ? slidesForAgent?.get(cur.entryId) : undefined;
  const curPendingSince = cur
    ? requestedRef.current.get(cur.entryId)
    : undefined;
  const curExpired =
    !curSlide &&
    curPendingSince !== undefined &&
    nowTs - curPendingSince > PENDING_FALLBACK_MS;
  const isNewest = index === turns.length - 1;
  // A thin activity/attention cue (design § deck view stays thin): the agent is
  // working or blocked on a tool approval (both surface as thinking/
  // tool_executing — you can't see the stream in deck view), or it errored. A
  // question the agent asks is the slide's own content, so it isn't hidden; the
  // header toggle is always available to reach chat regardless.
  const needsAttention = agent.state === "error" || active;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-base)",
      }}
    >
      {/* Slide stage */}
      <div
        style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}
      >
        {turns.length === 0 ? (
          <EmptyStage />
        ) : (
          <SlideStage
            key={cur?.entryId}
            slide={curSlide}
            expired={curExpired}
            active={active && isNewest}
            fallbackTurn={cur}
            onRegen={(feedback) => cur && regen(cur.entryId, feedback)}
          />
        )}

        {/* Nav arrows + counter overlay */}
        {turns.length > 0 && (
          <>
            <NavArrow
              dir="prev"
              disabled={index <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            />
            <NavArrow
              dir="next"
              disabled={index >= turns.length - 1}
              onClick={() => setIndex((i) => Math.min(turns.length - 1, i + 1))}
            />
            <div
              style={{
                position: "absolute",
                bottom: 10,
                left: "50%",
                transform: "translateX(-50%)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 12,
                color: "var(--text-muted)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-light)",
                borderRadius: 12,
                padding: "2px 10px",
                pointerEvents: "none",
              }}
            >
              {index + 1} / {turns.length}
            </div>
          </>
        )}

        {/* Attention affordance: one tap back to chat when the agent is working/
            blocked or errored. */}
        {needsAttention && (
          <button
            onClick={onExitDeck}
            title="Open chat view"
            style={{
              position: "absolute",
              top: 10,
              left: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-medium)",
              borderRadius: 14,
              padding: "3px 10px",
              fontSize: 12,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: active ? "var(--orange)" : "var(--red)",
                flexShrink: 0,
              }}
            />
            {active ? "Working — open chat" : "Error — open chat"}
          </button>
        )}
      </div>

      {/* Prompt bar: the composer on the newest position, the frozen prompt on
          past ones. */}
      <PromptBar
        isNewest={isNewest || turns.length === 0}
        promptText={cur?.promptText ?? ""}
        isMobile={isMobile}
        connected={connected}
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
      />
    </div>
  );
}

// One rendered slide, its pending spinner, or the text fallback. All three
// framings share ScaledFrame so scaling/centering never diverges.
function SlideStage({
  slide,
  expired,
  active,
  fallbackTurn,
  onRegen,
}: {
  slide: SlideRecord | undefined;
  expired: boolean;
  active: boolean;
  fallbackTurn: DeckTurn | undefined;
  onRegen: (feedback?: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const recompute = () => {
      const r = el.getBoundingClientRect();
      const pad = 24;
      const s = Math.min(
        (r.width - pad * 2) / SLIDE_W,
        (r.height - pad * 2) / SLIDE_H,
      );
      setScale(s > 0 ? s : 0.1);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wrap a natural-size (1280x720) node in the scaled, centered frame.
  const frame = (inner: React.ReactNode) => (
    <div style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
      <div
        style={{
          width: SLIDE_W,
          height: SLIDE_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {inner}
      </div>
    </div>
  );

  let body: React.ReactNode;
  let regenerable = false;
  if (slide && slide.placeholder) {
    body = frame(<PlaceholderInner slide={slide} />);
  } else if (slide && slide.html) {
    body = frame(
      <iframe
        title="slide"
        sandbox=""
        srcDoc={buildSlideSrcDoc(slide.html)}
        width={SLIDE_W}
        height={SLIDE_H}
        style={{
          border: 0,
          borderRadius: 8,
          boxShadow: "0 8px 40px rgba(0,0,0,0.45)",
          background: "#0f1117",
        }}
      />,
    );
    regenerable = true;
  } else if (expired && fallbackTurn) {
    body = frame(<FallbackInner turn={fallbackTurn} />);
    regenerable = true; // a failed generation must still offer retry
  } else {
    body = (
      <Spinner
        label={active ? "Waiting for the turn to finish" : "Designing slide"}
      />
    );
  }

  return (
    <div
      ref={stageRef}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {body}
      {regenerable && <RegenControl onRegen={onRegen} />}
    </div>
  );
}

// The per-slide ↻ regenerate button + optional feedback field.
function RegenControl({ onRegen }: { onRegen: (feedback?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const submit = () => {
    onRegen(feedback.trim() || undefined);
    setFeedback("");
    setOpen(false);
  };
  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        right: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 6,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        title="Regenerate this slide"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-medium)",
          borderRadius: 6,
          color: "var(--text-secondary)",
          fontSize: 15,
          lineHeight: 1,
          padding: "4px 8px",
          cursor: "pointer",
        }}
      >
        {"↻"}
      </button>
      {open && (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What to change (optional)"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
            style={{
              width: 220,
              background: "var(--bg-surface-solid)",
              border: "1px solid var(--border-medium)",
              borderRadius: 6,
              color: "var(--text-primary)",
              fontSize: 12,
              padding: "5px 8px",
              outline: "none",
            }}
          />
          <button
            onClick={submit}
            style={{
              background: "var(--accent)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontSize: 12,
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            Redo
          </button>
        </div>
      )}
    </div>
  );
}

// Placeholder position: an empty / interrupted / tool-only turn. Natural size
// (1280x720); the parent frame() applies the scale.
function PlaceholderInner({ slide }: { slide: SlideRecord }) {
  return (
    <div
      style={{
        width: SLIDE_W,
        height: SLIDE_H,
        borderRadius: 8,
        background: "#14161c",
        border: "1px solid var(--border-light)",
        color: "#9aa3b2",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: 72,
        boxSizing: "border-box",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 30, color: "#e8eaf0", fontWeight: 600 }}>
        {slide.errorText ? "Turn failed" : "No answer to show"}
      </div>
      <div style={{ fontSize: 22, lineHeight: 1.4, maxWidth: 820 }}>
        {slide.errorText
          ? slide.errorText
          : "This turn produced no text (interrupted, or tool-only)."}
      </div>
    </div>
  );
}

// Client-side fallback when generation timed out: the raw answer on a plain
// template. Regenerate stays available via the ↻ control.
function FallbackInner({ turn }: { turn: DeckTurn }) {
  return (
    <div
      style={{
        width: SLIDE_W,
        height: SLIDE_H,
        borderRadius: 8,
        background: "#14161c",
        border: "1px solid var(--border-light)",
        color: "#e8eaf0",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: 72,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 22, color: "#9aa3b2" }}>
        Slide unavailable — showing the raw answer
      </div>
      <div
        style={{
          fontSize: 24,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
        }}
      >
        {turn.assistantText.slice(0, 1200)}
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        color: "var(--text-muted)",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          border: "3px solid var(--border-light)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <div style={{ fontSize: 13 }}>{label}</div>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

function EmptyStage() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: 14,
        padding: 24,
        textAlign: "center",
      }}
    >
      No turns yet. Send a message below to start the deck.
    </div>
  );
}

function NavArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous slide" : "Next slide"}
      style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        [dir === "prev" ? "left" : "right"]: 10,
        width: 40,
        height: 40,
        borderRadius: "50%",
        border: "1px solid var(--border-light)",
        background: "var(--bg-surface)",
        color: disabled ? "var(--text-ghost)" : "var(--text-secondary)",
        fontSize: 18,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Plain ASCII chevrons — no auto-emoji risk. */}
      {dir === "prev" ? "<" : ">"}
    </button>
  );
}

function PromptBar({
  isNewest,
  promptText,
  isMobile,
  connected,
  draft,
  onDraftChange,
  onSend,
}: {
  isNewest: boolean;
  promptText: string;
  isMobile?: boolean;
  connected: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
}) {
  if (!isNewest) {
    // Frozen prompt for a past slide.
    return (
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--border-light)",
          padding: isMobile ? "10px 12px" : "12px 24px",
          background: "var(--bg-surface)",
          color: "var(--text-secondary)",
          fontSize: 14,
          lineHeight: 1.4,
          maxHeight: 120,
          overflowY: "auto",
        }}
        title="The prompt that produced this slide"
      >
        <span style={{ color: "var(--text-dim)", marginRight: 8 }}>
          Prompt:
        </span>
        {promptText}
      </div>
    );
  }
  // Compact composer on the newest position — wired to the normal send path
  // (LogView.handleSend). It is intentionally minimal (no attachments/queue/
  // voice — those stay in chat view); it surfaces the disconnected state so a
  // send that can't reach the server doesn't look like a silent no-op.
  const canSend = !!draft.trim() && connected;
  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--border-light)",
        background: "var(--bg-surface)",
      }}
    >
      {!connected && (
        <div
          style={{
            padding: "4px 16px",
            fontSize: 12,
            color: "var(--orange)",
            borderBottom: "1px solid var(--border-light)",
          }}
        >
          Disconnected — reconnecting. Messages can't be sent yet.
        </div>
      )}
      <div
        style={{
          padding: isMobile ? "8px 10px" : "10px 16px",
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isMobile) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder="Message — appears as the next slide"
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            minHeight: 38,
            maxHeight: 120,
            background: "var(--bg-input, var(--bg-surface-solid))",
            border: "1px solid var(--border-medium)",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontSize: 14,
            lineHeight: 1.4,
            padding: "9px 12px",
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <button
          onClick={() => canSend && onSend()}
          disabled={!canSend}
          style={{
            background: canSend ? "var(--accent)" : "var(--bg-surface-solid)",
            color: canSend ? "#fff" : "var(--text-ghost)",
            border: "1px solid var(--border-medium)",
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 14,
            cursor: canSend ? "pointer" : "default",
            flexShrink: 0,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
