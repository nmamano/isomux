import { useEffect, useId, useRef, useState } from "react";
import type { SubscriptionUsageWire } from "../../shared/types.ts";
import { bandColor } from "./ContextBattery.tsx";
import { getUsagePin, setUsagePin, type UsagePin } from "../device-settings.ts";

// Subscription-allowance indicator (task df489513), rendered immediately left
// of the context battery. It answers a different question than its neighbor:
// the battery is "how full is THIS conversation", this pill is "how much of
// the PLAN the backend account is signed in to has been burned". The number
// comes from whichever window is closest to its limit (the server picks it and
// says so in `primaryIndex`); every window the backend reports is a popover
// row, and the leading one is marked there so the number is never ambiguous.
//
// Two deliberate differences from the battery:
//   - It DISAPPEARS when there's no reading, instead of showing an unknown
//     state. A Claude API-key / Bedrock / Vertex session has no plan quota at
//     all, so an "unknown" pill there would imply a number exists somewhere.
//   - It fills UP as usage grows, where the battery drains DOWN, and it's a
//     ring rather than a battery shell - two same-shaped meters with opposite
//     polarity sitting side by side would be a trap.
// The color bands are shared with the battery on purpose (bandColor: < 50 dim,
// 50-74 orange, >= 75 red), keyed off the used percentage.

// Circle geometry for the ring gauge, in the 24x24 viewBox.
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// A reading younger than this is presented as current; only older ones get the
// "Reading taken N ago" line in the popover.
const STALE_READING_MS = 15 * 60 * 1000;

// A short local date-and-time ("Sat 1 Aug, 09:00") in the viewer's own
// timezone - the reset matters to whoever is looking at the screen, not to the
// server.
function formatResetAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "2 days 5 hours" / "3 hours 10 min" / "12 min" - rounded, never seconds.
// Exported for tests.
export function formatTimeUntil(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days && hours) return `${plural(days, "day")} ${plural(hours, "hour")}`;
  if (days) return plural(days, "day");
  if (hours) return `${plural(hours, "hour")} ${minutes} min`;
  return `${minutes} min`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

// One line per window: "Weekly: 34% used - resets Sat 1 Aug, 09:00 (in 2 days
// 5 hours)". Plain spaced hyphens, never em dashes, per Nil's prose rule.
// `nowMs` is null for the hover tooltip, which renders on every re-render and
// so must stay a pure function of the props - only the popover, whose clock
// is stamped when it opens, gets the countdown.
function windowLine(
  w: SubscriptionUsageWire["windows"][number],
  nowMs: number | null,
): string {
  const head = `${w.label}: ${Math.round(w.usedPercent)}% used`;
  if (w.resetsAtMs === null) return head;
  const at = formatResetAt(w.resetsAtMs);
  if (nowMs === null || w.resetsAtMs <= nowMs) return `${head} - resets ${at}`;
  return `${head} - resets ${at} (in ${formatTimeUntil(w.resetsAtMs - nowMs)})`;
}

// Which window the number tracks, given the server's auto pick and the
// viewer's pin. Exported for tests.
//
// Window labels are NOT unique in general - two Codex windows of equal
// duration render identically, and a server-supplied Claude model_scoped name
// can collide with a fixed one - so a label-only lookup could silently track a
// different limit than the row that was clicked. A pin therefore carries both
// the label and the index it was clicked at, resolved in this order:
//   1. the stored index still holds that label -> use it. Exact, and the only
//      branch that can tell two same-labelled rows apart.
//   2. the label appears exactly once elsewhere -> use that. This is the
//      provider reordering its windows, where the index is stale but the
//      intent is unambiguous.
//   3. anything else - the window is gone, or the label is now ambiguous and
//      we cannot tell which row was meant -> fall back to auto. Showing the
//      most constrained window is always defensible; tracking the wrong limit
//      while claiming to be pinned is not.
export function resolveTrackedWindow(
  windows: SubscriptionUsageWire["windows"],
  primaryIndex: number,
  pin: UsagePin | null,
): { index: number; pinned: boolean } {
  if (pin) {
    if (windows[pin.index]?.label === pin.label) {
      return { index: pin.index, pinned: true };
    }
    const matches: number[] = [];
    windows.forEach((w, i) => {
      if (w.label === pin.label) matches.push(i);
    });
    if (matches.length === 1) return { index: matches[0], pinned: true };
  }
  // Validate rather than trust: an out-of-range index from an older server
  // must not blank the pill or crash the header.
  const auto =
    primaryIndex >= 0 && primaryIndex < windows.length ? primaryIndex : 0;
  return { index: auto, pinned: false };
}

// The one non-data string in the popover's chooser. "Auto" alone wouldn't say
// auto-WHAT, and the parenthetical is the whole rule in two words.
export const AUTO_CHOICE_LABEL = "Auto (most constrained)";
const CHOOSER_HINT = "Which limit the number tracks:";

export function SubscriptionPill({
  usage,
  agentId,
  provider,
  isMobile,
}: {
  // null/undefined = no reading (no plan limits apply, the backend hasn't
  // reported yet, or the server restarted). Nothing renders in that case.
  usage: SubscriptionUsageWire | null | undefined;
  // Both are the pin's storage key - see getUsagePin. `provider` is the
  // agent's engine, so a pin never crosses from one provider's windows to
  // another's.
  agentId: string;
  provider: string;
  isMobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Mirror of the stored pin, seeded once from localStorage. LogView keys this
  // component on agent + provider, so an agent or engine switch REMOUNTS it and
  // this initializer re-runs - no prop-into-state effect to keep in sync.
  const [pin, setPin] = useState<UsagePin | null>(() =>
    getUsagePin(agentId, provider),
  );
  // Stable id so the trigger's aria-controls points at the popover.
  const popoverId = useId();
  // Same fixed-positioning dance as ContextBattery: the header and cwd row
  // clip overflow, so the popover is anchored to the button's viewport rect
  // captured at open time. `atMs` is the clock stamped at that same moment,
  // which the "resets in ..." countdown is measured against.
  const [coords, setCoords] = useState<{
    top: number;
    right: number;
    atMs: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const popoverOpen = open && coords !== null;

  // Dismiss on outside pointer / Escape (the popover is not a DOM descendant
  // of the button, so both refs are checked).
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  // Hidden entirely without a reading. Hooks above run unconditionally so the
  // hook order stays stable when a reading arrives mid-session.
  if (!usage || usage.windows.length === 0) return null;
  const tracked = resolveTrackedWindow(usage.windows, usage.primaryIndex, pin);
  const headline = usage.windows[tracked.index];

  const choose = (next: UsagePin | null) => {
    setUsagePin(agentId, provider, next);
    setPin(next);
  };

  // Color and fill come from the RAW clamped percentage, the number is only
  // rounded for the label - same contract as the context battery, whose bands
  // key off the raw float. Rounding first would paint 49.6% orange, i.e. a
  // different threshold than the one the two indicators are supposed to share.
  const rawUsed = Math.max(0, Math.min(100, headline.usedPercent));
  const used = Math.round(rawUsed);
  const color = bandColor(rawUsed);
  const dash = (RING_CIRCUMFERENCE * rawUsed) / 100;

  const planLine = usage.plan ? `Plan: ${usage.plan}` : null;
  const caveat = "This is account-wide, not per agent.";
  // Both lists stay in display order. What identifies the window behind the
  // number is the popover's bullet + bold on that row and the button's
  // accessible name ("5-hour plan allowance 95% used"), NOT position.
  const hoverLines = usage.windows.map((w) => windowLine(w, null));
  const popoverLines = usage.windows.map((w) =>
    windowLine(w, coords?.atMs ?? null),
  );
  // How old the reading is. Account data goes stale while an agent sits idle
  // (nothing refreshes it between turns), so the popover says so rather than
  // presenting a week-old number as current - but a fresh reading stays
  // unannotated (Nil: the line should only appear when it is actually stale).
  const ageLine =
    coords && coords.atMs - usage.sampledAtMs > STALE_READING_MS
      ? `Reading taken ${formatTimeUntil(coords.atMs - usage.sampledAtMs)} ago.`
      : null;
  const tooltip = [...(planLine ? [planLine] : []), ...hoverLines, caveat].join(
    "\n",
  );

  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
        atMs: Date.now(),
      });
    }
    setOpen(next);
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        color,
      }}
    >
      <button
        ref={btnRef}
        onClick={toggle}
        title={isMobile ? undefined : tooltip}
        aria-label={`${headline.label} plan allowance ${used}% used${
          tracked.pinned ? ", pinned" : ""
        }. Tap for details.`}
        aria-expanded={popoverOpen}
        aria-controls={popoverOpen ? popoverId : undefined}
        data-testid="subscription-pill"
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "pointer",
          color: "inherit",
          lineHeight: 1,
        }}
      >
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{ display: "block", flexShrink: 0 }}
        >
          {/* track */}
          <circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={5}
            opacity={0.3}
          />
          {/* used arc, starting at 12 o'clock and filling clockwise */}
          {rawUsed > 0 && (
            <circle
              cx={12}
              cy={12}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={5}
              strokeDasharray={`${dash} ${RING_CIRCUMFERENCE - dash}`}
              transform="rotate(-90 12 12)"
            />
          )}
        </svg>
        <span
          className="context-battery-pct"
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 10,
            fontWeight: 600,
            color: "inherit",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {used}%
        </span>
      </button>
      {popoverOpen && (
        <div
          ref={popRef}
          id={popoverId}
          // Not role="tooltip": a tooltip is non-interactive descriptive
          // content, and this popover contains the limit chooser's buttons.
          role="dialog"
          aria-label={CHOOSER_HINT}
          style={{
            position: "fixed",
            top: coords.top,
            right: coords.right,
            zIndex: 1000,
            maxWidth: 280,
            padding: "8px 10px",
            background: "var(--bg-surface-solid)",
            border: "1px solid var(--border-medium)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
            color: "var(--text-secondary)",
            fontSize: 12,
            lineHeight: 1.4,
            fontWeight: 400,
            whiteSpace: "normal",
          }}
        >
          {planLine && <div>{planLine}</div>}
          <div style={{ marginTop: 4, color: "var(--text-dim)" }}>
            {CHOOSER_HINT}
          </div>
          {popoverLines.map((line, i) => (
            <ChoiceRow
              key={i}
              text={i === tracked.index ? `\u2022 ${line}` : line}
              active={i === tracked.index}
              selected={tracked.pinned && i === tracked.index}
              onClick={() =>
                choose({ label: usage.windows[i].label, index: i })
              }
            />
          ))}
          <ChoiceRow
            text={AUTO_CHOICE_LABEL}
            active={!tracked.pinned}
            selected={!tracked.pinned}
            onClick={() => choose(null)}
          />
          {ageLine && (
            <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
              {ageLine}
            </div>
          )}
          <div style={{ marginTop: 6, color: "var(--text-dim)" }}>{caveat}</div>
        </div>
      )}
    </span>
  );
}

// One selectable line in the popover's chooser. `active` = this is the window
// the number currently comes from (bulleted and bold); `selected` = this is the
// viewer's explicit choice, which is what aria-pressed reports. The two differ
// on the auto path: a window can be driving the number without being pinned.
function ChoiceRow({
  text,
  active,
  selected,
  onClick,
}: {
  text: string;
  active: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  // Selection reads as an accent-tinted background (--bg-subtle was too faint
  // to notice); hovering tints the row so the rows read as clickable at all.
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-pressed={selected}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected
          ? "var(--accent-bg)"
          : hovered
            ? "var(--accent-hover)"
            : "none",
        border: "none",
        borderRadius: 4,
        padding: "2px 4px",
        margin: 0,
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
        fontWeight: active ? 600 : 400,
        lineHeight: 1.4,
      }}
    >
      {text}
    </button>
  );
}
