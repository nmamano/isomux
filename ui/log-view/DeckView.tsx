import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, LogEntry, SlideRecord } from "../../shared/types.ts";
import {
  buildDeckTurns,
  restoredDeckPos,
  settledDeckPos,
  shouldRequestSlide,
  slideContentDigest,
  type DeckTurn,
} from "../../shared/slide-turns.ts";
import {
  SLIDE_W,
  SLIDE_H,
  buildSlideSrcDoc,
  buildSlideMeasureSrcDoc,
  slideDisplayHeight,
} from "../../shared/slide-frame.ts";
import type { EnsureSlideRes } from "../../shared/contract-shapes.ts";
import { apiFetch } from "../api.ts";
import { getSlidePos, setSlidePos } from "../device-settings.ts";
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

// What the deck shows for a slide that isn't here yet is decided by REPORTED
// state, never by elapsed time: the spinner while it is pending, the raw-answer
// fallback once the server says the generation failed (`slide_failed`, or an
// `unavailable` ensure response). A timeout can't tell a failure from a slow
// generation — and generation genuinely takes 17-30s — so any threshold either
// slanders working slides or hides real failures.
//
// The one thing time is still good for: a request the server dropped WITHOUT
// reporting an outcome (its conversation reset, its turn forked away, or the
// server restarted mid-generation). This window is how long we let such a
// request sit before quietly asking again. It never changes what is on screen,
// so it can afford to be well clear of the slowest real generation.
const ORPHAN_RETRY_MS = 120_000;

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
  const { slides, slideFailed, connected } = useAppState();
  const dispatch = useDispatch();
  const slidesForAgent = slides.get(agent.id);
  // Turns whose generation the server reported as failed. A failure is terminal:
  // no auto-retry (a formatter that broke the slide contract on this turn will
  // most likely break it again), so the raw answer stands until the viewer
  // asks again with ↻.
  const failedForAgent = slideFailed.get(agent.id);

  // Deck positions, in display order (timestamp; stable sort keeps arrival order
  // on ties) — the same 1:1 mapping the server keys slides on.
  const turns = useMemo<DeckTurn[]>(() => {
    const ordered = [...logs].sort((a, b) => a.timestamp - b.timestamp);
    return buildDeckTurns(ordered);
  }, [logs]);

  const [index, setIndex] = useState(0);
  const didInitRef = useRef(false);
  // Gates the position-save effect so the stale index=0 present on the mount
  // commit (before the restore below is applied) never clobbers the saved
  // position. Flipped true on the first save-effect run after init.
  const hasRestoredRef = useRef(false);
  // Deck length at the previous render, so "follow newest" can test whether the
  // viewer was on the last slide BEFORE a new turn grew the deck — see
  // settledDeckPos/nextDeckIndex. Recomputing at-end against the already-grown
  // list reads false for the very growth being reacted to and drops the follow.
  const prevLenRef = useRef(0);
  const active = isAgentActive(agent);

  // First load: RESTORE the last-viewed position (per-device-per-agent) — land
  // back on the saved slide if the viewer had left NOT on the last slide,
  // otherwise on the newest (also the slide they want generated first). Later
  // renders: settle the index as the deck grows/shrinks (clamp, or follow newest
  // if they were on the last slide before it grew). BOTH branches persist the
  // settled position directly, not via a state-change effect: a restored index
  // that clamps to the new last slide (or to 0, where setIndex can't trigger a
  // save) must record atEnd, and a length change that flips atEnd without moving
  // index (e.g. a shrink making the unchanged cursor the last slide) must too.
  // This effect's `index` closure is the committed value for the render that
  // carried this length change (true even if React batched a navigation update
  // in), so `pos` is the single source for both what we show and what we save.
  useEffect(() => {
    const prevLen = prevLenRef.current;
    prevLenRef.current = turns.length;
    if (turns.length === 0) return;
    const pos = didInitRef.current
      ? settledDeckPos(index, prevLen, turns.length)
      : restoredDeckPos(getSlidePos(agent.id), turns.length);
    didInitRef.current = true;
    setIndex(pos.index);
    setSlidePos(agent.id, pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length]);

  // Persist navigation (an index change with no length change — arrows, buttons,
  // Home/End/Latest). Length-driven index changes are already persisted above;
  // this re-save of an identical value is harmless. Keyed on index ONLY;
  // turns.length is read (current at run time) but omitted so this never fires on
  // the pre-advance render. Skips exactly one run after init: on the mount commit
  // index is still the pre-restore 0, which must not clobber the restored value.
  useEffect(() => {
    if (!didInitRef.current || turns.length === 0) return;
    if (!hasRestoredRef.current) {
      hasRestoredRef.current = true;
      return;
    }
    setSlidePos(agent.id, { index, atEnd: index >= turns.length - 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, agent.id]);

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
      } else if (e.key === "Home") {
        e.preventDefault();
        setIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setIndex(Math.max(0, turns.length - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turns.length]);

  // Per-turn request bookkeeping: entryId → time we POSTed ensure-slide. Dedupes
  // requests across renders, and dates them for the orphan retry.
  const requestedRef = useRef<Map<string, number>>(new Map());
  // A ticking clock, advanced by the interval below, so the orphan window is
  // derived from state (pure to read in render) rather than Date.now().
  const [nowTs, setNowTs] = useState(0);

  // Ensure the focused slide + its two neighbors. There is NO client-side
  // "is the turn settled?" guess: the server authoritatively gates generation on
  // the turn's terminal fact (an in-flight newest turn comes back `pending` and
  // is filled by slide_ready when it completes). We just request what's visible.
  useEffect(() => {
    if (turns.length === 0) return;
    const wanted = [index, index + 1, index - 1].filter(
      (i) => i >= 0 && i < turns.length,
    );
    for (const i of wanted) {
      const turn = turns[i];
      const cached = slidesForAgent?.get(turn.entryId);
      // A cached record carrying a digest is verified (written by the terminal
      // gate for content immutable within the conversation), so it's skipped; a
      // miss or a DIGESTLESS legacy record (a stale placeholder the turn outgrew,
      // or a slide the old code rendered from a half-stream) is (re)validated by
      // the server. The digest is compared only to catch a stored PLACEHOLDER for
      // a turn that has since gained an answer — the one stale state the deck
      // can't otherwise leave. See shouldRequestSlide.
      const reqAt = requestedRef.current.get(turn.entryId);
      // A request past the orphan window counts as no longer in flight, so one
      // the server dropped without reporting an outcome is asked again instead
      // of orphaning the deck forever. A slow-but-live generation just re-asks
      // and the server dedupes into the running one.
      const inFlight = reqAt !== undefined && nowTs - reqAt <= ORPHAN_RETRY_MS;
      // A reported failure is terminal (shouldRequestSlide gates it): leave that
      // turn alone until the viewer retries.
      if (
        !shouldRequestSlide(
          cached,
          inFlight,
          failedForAgent?.has(turn.entryId),
          slideContentDigest(turn),
        )
      )
        continue;
      requestedRef.current.set(turn.entryId, Date.now());
      ensure(turn.entryId, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, turns, slidesForAgent, failedForAgent, agent.id, nowTs]);

  // Clear the in-flight marker once a slide actually lands for that turn (via the
  // slide_ready WS push, or the ready response). requestedRef is IN-FLIGHT state,
  // not "ever requested": a request that reaches a terminal outcome must free the
  // entry so a later content change can re-request. A pending request with no
  // slide yet stays marked (so we don't spam re-requests before it resolves).
  useEffect(() => {
    if (!slidesForAgent) return;
    for (const entryId of requestedRef.current.keys()) {
      if (slidesForAgent.get(entryId)) requestedRef.current.delete(entryId);
    }
  }, [slidesForAgent]);

  // While a VISIBLE turn still lacks a VERIFIED slide and hasn't been reported
  // failed, tick so the request effect above can re-ask once the orphan window
  // lapses. Nothing on screen depends on this clock any more — it only paces
  // retries.
  //
  // The predicate IS the request effect's own condition minus the in-flight
  // marker (`shouldRequestSlide(cached, false, failed, digest)`), so the two can
  // never drift. Absence alone is NOT enough: a digestless legacy record
  // is unverifiable and is being reconciled, but unlike a placeholder (which the
  // invalidate path deletes) it stays in the store, so an absence-only test
  // would leave the clock stopped and that record would never retry.
  //
  // Keyed on the same visible window as the request effect, `index` included:
  // navigating to an unverified turn starts a request without changing `turns`
  // or `slidesForAgent`, and requestedRef is a ref — so without `index` here the
  // clock would never start for it and an orphaned request would never retry.
  useEffect(() => {
    const anyPending = [index, index + 1, index - 1]
      .filter((i) => i >= 0 && i < turns.length)
      .some((i) =>
        shouldRequestSlide(
          slidesForAgent?.get(turns[i].entryId),
          false,
          failedForAgent?.has(turns[i].entryId),
          slideContentDigest(turns[i]),
        ),
      );
    if (!anyPending) return;
    // The interval alone drives the clock — no immediate set, which would be a
    // render-in-effect. Until the first tick nowTs stays behind the request
    // stamps, which reads as "in flight": the safe direction.
    const h = setInterval(() => setNowTs(Date.now()), 5000);
    return () => clearInterval(h);
  }, [index, turns, slidesForAgent, failedForAgent]);

  function ensure(
    entryId: string,
    opts: { force?: boolean; feedback?: string },
  ) {
    // The exact record shown at request time. Only a stale PLACEHOLDER is worth
    // replacing with a spinner (its "No answer" card is misleading); a rendered
    // slide being reconciled stays on screen until its replacement lands, which
    // is smoother. Captured now, not when the response returns.
    const prevSlide = slidesForAgent?.get(entryId);
    apiFetch<EnsureSlideRes>(
      "POST",
      `/api/agents/${agent.id}/slides/${entryId}`,
      opts,
    )
      .then((res) => {
        if (res.status === "ready") {
          // Terminal: the slide is in hand. Clear the in-flight marker (a later
          // content change may legitimately re-request) and hand it to the store.
          requestedRef.current.delete(entryId);
          dispatch({
            type: "slide_ready",
            agentId: agent.id,
            sessionId: "",
            entryId,
            slide: res.slide,
          });
        } else if (res.status === "unavailable") {
          // Terminal: there is no live turn to render (the conversation is gone,
          // or this turn isn't in it). Same standing as a reported failure — show
          // the raw answer with ↻ rather than spinning forever, and stop asking.
          requestedRef.current.delete(entryId);
          dispatch({
            type: "slide_failed",
            agentId: agent.id,
            sessionId: "",
            entryId,
            reason: "unavailable",
          });
        } else if (res.status === "pending" && prevSlide?.placeholder) {
          // Still in flight (keep the marker): the server is regenerating a stale
          // placeholder we currently show. Drop it — compare-and-delete, so a
          // slide_ready that already replaced it wins — so the deck shows the
          // Generating spinner meanwhile. The slide arrives via the slide_ready
          // WS push, which clears the marker (see the effect below).
          dispatch({
            type: "slide_invalidate",
            agentId: agent.id,
            entryId,
            prevSlide,
          });
        }
      })
      .catch(() => {
        // Let it retry: drop the marker so a later pass can re-request.
        requestedRef.current.delete(entryId);
      });
  }

  function regen(entryId: string, feedback?: string) {
    requestedRef.current.set(entryId, Date.now());
    // An explicit retry retires the failure mark, so the deck goes back to the
    // spinner (and the request effect resumes owning this turn).
    dispatch({ type: "slide_retry", agentId: agent.id, entryId });
    ensure(entryId, { force: true, feedback });
  }

  const cur = turns[index];
  const curSlide = cur ? slidesForAgent?.get(cur.entryId) : undefined;
  const isNewest = index === turns.length - 1;
  // The raw-answer fallback is shown for a REPORTED failure and nothing else.
  // Every other reason a slide isn't here — the turn hasn't settled, the request
  // is parked server-side, the formatter is still working — is a spinner, for as
  // long as it takes.
  const curFailed = !curSlide && !!cur && !!failedForAgent?.has(cur.entryId);
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
            failed={curFailed}
            isNewest={isNewest}
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
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-light)",
                  borderRadius: 12,
                  padding: "2px 10px",
                }}
              >
                {index + 1} / {turns.length}
              </span>
              {index < turns.length - 1 && (
                <button
                  onClick={() => setIndex(turns.length - 1)}
                  title="Jump to the latest slide (End)"
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-light)",
                    borderRadius: 12,
                    padding: "2px 10px",
                    cursor: "pointer",
                  }}
                >
                  Latest
                </button>
              )}
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
  failed,
  isNewest,
  fallbackTurn,
  onRegen,
}: {
  slide: SlideRecord | undefined;
  failed: boolean;
  isNewest: boolean;
  fallbackTurn: DeckTurn | undefined;
  onRegen: (feedback?: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  // Natural content height of the current slide's HTML, measured offscreen at
  // width 1280 (see MeasureFrame). null until measured. Only used for the
  // model-HTML branch; placeholder/fallback are app-rendered and always fit.
  const [measuredH, setMeasuredH] = useState<number | null>(null);

  // The height the slide is laid out at. Model HTML taller than the 720 canvas
  // is rendered at its natural height (see slideDisplayHeight) and scaled down
  // whole, so it is never clipped and never scrolls; shorter content keeps the
  // 720 card. Placeholder/fallback are app-rendered and always use 720.
  const isHtml = !!(slide && slide.html);
  const contentH = isHtml ? slideDisplayHeight(measuredH) : SLIDE_H;

  // Re-fit whenever the pane resizes OR the measured height arrives/changes, so
  // an overfull slide reflows from the provisional 720 to its true height.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const recompute = () => {
      const r = el.getBoundingClientRect();
      const pad = 24;
      const s = Math.min(
        (r.width - pad * 2) / SLIDE_W,
        (r.height - pad * 2) / contentH,
      );
      setScale(s > 0 ? s : 0.1);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentH]);

  // Wrap a natural-size (1280 × h) node in the scaled, centered frame.
  const frame = (inner: React.ReactNode, h: number = SLIDE_H) => (
    <div style={{ width: SLIDE_W * scale, height: h * scale }}>
      <div
        style={{
          width: SLIDE_W,
          height: h,
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
    regenerable = true; // let the viewer force a refresh (Nil: missing refresh)
  } else if (slide && slide.html) {
    body = (
      <>
        {/* Offscreen sizing pass — reads natural height, renders nothing. */}
        <MeasureFrame html={slide.html} onMeasured={setMeasuredH} />
        {frame(
          <iframe
            title="slide"
            sandbox=""
            srcDoc={buildSlideSrcDoc(slide.html, contentH)}
            width={SLIDE_W}
            height={contentH}
            style={{
              border: 0,
              borderRadius: 8,
              boxShadow: "0 8px 40px rgba(0,0,0,0.45)",
              background: "#0f1117",
            }}
          />,
          contentH,
        )}
      </>
    );
    regenerable = true;
  } else if (failed && fallbackTurn) {
    body = frame(<FallbackInner turn={fallbackTurn} />);
    regenerable = true; // a failed generation must still offer retry
  } else {
    // The newest position reads "Generating" (its turn is still producing an
    // answer, or its slide is being designed); a past position just designs.
    body = <Spinner label={isNewest ? "Generating" : "Designing slide"} />;
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

// Offscreen iframe that measures a slide's natural content height at width 1280
// so the display frame can be sized to never clip (design: item 2 in the Slide
// Mode polish; internal-docs/slide-mode-design.md).
//
// SECURITY: the DISPLAY iframe stays sandbox="" (opaque origin, fully isolated).
// Only THIS measurement copy adds sandbox="allow-same-origin", purely so the
// parent can read contentDocument.scrollHeight. That does NOT weaken the model-
// HTML boundary:
//   - No script can run: allow-scripts is absent AND the CSP is script-src
//     'none' (defense in depth) — even a prompt-injected <script> is inert.
//   - No network: the CSP's default-src 'none' (img/font/connect/... 'none')
//     blocks every subresource and fetch, identical to the display frame.
//   - allow-same-origin only grants the PARENT read access to a script-dead,
//     network-dead document. With no script, the framed HTML cannot touch the
//     parent's origin, storage, or cookies. The parent merely reads a number.
// The frame is inert and offscreen (hidden, non-interactive) and is destroyed
// when the slide changes (SlideStage is keyed by entryId).
function MeasureFrame({
  html,
  onMeasured,
}: {
  html: string;
  onMeasured: (h: number) => void;
}) {
  return (
    <iframe
      aria-hidden="true"
      tabIndex={-1}
      title="slide measurement"
      sandbox="allow-same-origin"
      srcDoc={buildSlideMeasureSrcDoc(html)}
      width={SLIDE_W}
      height={SLIDE_H}
      style={{
        position: "absolute",
        left: -99999,
        top: 0,
        width: SLIDE_W,
        height: SLIDE_H,
        border: 0,
        visibility: "hidden",
        pointerEvents: "none",
      }}
      onLoad={(e) => {
        // Same-origin (allow-same-origin) → contentDocument is readable. If it
        // is somehow null, we leave the default 720 in place (graceful: the
        // slide renders as before, no crash).
        const doc = e.currentTarget.contentDocument;
        if (!doc) return;
        const h = Math.max(
          doc.documentElement?.scrollHeight ?? 0,
          doc.body?.scrollHeight ?? 0,
        );
        if (h > 0) onMeasured(h);
      }}
    />
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

// Shown when the server reported the generation as failed (or that there is no
// live turn to render): the raw answer on a plain template, so the viewer still
// gets the content. Regenerate stays available via the ↻ control.
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
          // FIXED height, not maxHeight: the stage above is flex:1, so a bar
          // that grew with the prompt's length would resize the stage and move
          // the vertically-centred nav arrows on every slide. A constant height
          // keeps them in one place; longer prompts scroll within the bar.
          height: 92,
          boxSizing: "border-box",
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
        // Match the frozen prompt bar's height at rest so the stage — and the
        // nav arrows centred in it — don't shift when you reach the newest
        // slide. It still grows as the draft wraps, which is user-driven.
        minHeight: 92,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
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
