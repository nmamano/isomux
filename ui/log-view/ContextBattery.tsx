import { useEffect, useRef, useState } from "react";
import type { ContextUsageWire } from "../../shared/types.ts";

// Battery-style context indicator (task 27096236; design:
// internal-docs/context-fullness-visibility.md). Rendered as inline SVG, NOT a
// Unicode glyph — iOS Safari emoji-renders the battery/🔋 family and overrides
// CSS color, which would defeat the color behavior.
//
// Phone-battery metaphor: the fill and the number are the REMAINING context
// (100% on a fresh session, draining to 0 as it fills). The COLOR, however,
// comes from the RAW fullness percentage so it agrees with the server-injected
// [context check] notices (thresholds 50/75, per Nil 2026-07-18): a nearly
// drained battery goes red. bandColor: < 50 -> dim (--text-muted), 50-74 ->
// --orange, >= 75 -> --red. Never feed the remaining value into bandColor.
// When there is NO reading, the shell would be empty and unlabeled, so it shows
// "CTX" inside instead (the only state that gets the label).
export function bandColor(pct: number): string {
  if (pct >= 75) return "var(--red)";
  if (pct >= 50) return "var(--orange)";
  return "var(--text-muted)";
}

export function ContextBattery({
  usage,
  isMobile,
}: {
  // null = explicitly cleared over the wire (post-/clear); undefined = never
  // measured (fresh conversation, pre-first-turn, post server restart). The
  // pill ALWAYS renders (per Nil 2026-07-18): with no reading it shows the
  // empty shell + "?" in a ghost color instead of disappearing, so the
  // indicator's presence is stable and "unknown" is a visible state.
  usage: ContextUsageWire | null | undefined;
  isMobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Popover is fixed-positioned (header/cwd-row ancestors clip overflow), so we
  // anchor it to the button's viewport rect at open time.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // The pill (and its anchor button) is always mounted now, so the popover no
  // longer needs a usage gate: if the snapshot clears while it's open, the
  // content live-switches to the "not measured yet" copy at the same anchor.
  const popoverOpen = open && coords !== null;

  // Dismiss on outside pointer / Escape. The popover is fixed-positioned (not a
  // DOM descendant of the button), so we ignore clicks inside either the button
  // or the popover and close on anything else.
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

  // Unknown state: no reading. Ghost color, "CTX" inside the shell, "?" label —
  // see the prop comment. All the derived display values fork on this.
  const known = !!usage;
  const pct = usage ? usage.percentage : 0;
  // Phone-battery metaphor: the battery shows REMAINING context, so it starts
  // full (100%) on a fresh session and drains DOWN as context fills. The
  // displayed number and the fill proportion are both the remaining fraction,
  // but the COLOR stays driven by FULLNESS (bandColor of the raw usage pct) so
  // a nearly-empty battery (near-full context) reads red. Do NOT feed the
  // remaining value into bandColor.
  // Clamp to [0,100] so a malformed/out-of-range snapshot can't show a negative
  // or >100 number; keeps the label in step with the clamped fill below.
  const remaining = Math.max(0, Math.min(100, Math.round(100 - pct)));
  const color = known ? bandColor(pct) : "var(--text-ghost)";
  const fillFrac = known ? Math.max(0, Math.min(1, (100 - pct) / 100)) : 0;
  // Inner fill spans x:2..19 (17px wide) inside the 0.5..20.5 shell.
  const fillW = 17 * fillFrac;
  // "?" is plain ASCII on purpose — no iOS auto-emoji risk (unlike ？/⍰).
  const label = known ? `${remaining}%` : "?";

  // Plain spaced hyphen (not an em dash) per Nil's prose rule.
  let full: string;
  if (usage) {
    const tokens = usage.totalTokens.toLocaleString("en-US");
    const maxTokens = usage.maxTokens.toLocaleString("en-US");
    const detail = `Context: ${tokens} / ${maxTokens} tokens used (${remaining}% left).`;
    const nudge =
      pct >= 50
        ? " Consider asking the agent to wrap up, or /clear for a fresh session."
        : "";
    full = detail + nudge;
  } else {
    full =
      "Context usage not measured yet. It updates when the agent finishes a turn.";
  }

  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
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
        title={isMobile ? undefined : full}
        aria-label={
          known
            ? `Context battery ${remaining}% remaining. Tap for details.`
            : "Context usage not measured yet. Tap for details."
        }
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
          width={22}
          height={11}
          viewBox="0 0 24 12"
          aria-hidden="true"
          style={{ display: "block", flexShrink: 0 }}
        >
          {/* shell outline (slightly lighter so the fill reads against it) */}
          <rect
            x={0.5}
            y={1}
            width={20}
            height={10}
            rx={2.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.55}
          />
          {/* terminal nub */}
          <rect x={21} y={4} width={2} height={4} rx={1} fill="currentColor" />
          {/* proportional fill */}
          {fillW > 0 && (
            <rect
              x={2}
              y={2.5}
              width={fillW}
              height={7}
              rx={1.2}
              fill="currentColor"
            />
          )}
          {/* No reading: the shell is empty, so label it "CTX" (ghost color)
              instead of leaving a meaningless box. */}
          {!known && (
            <text
              x={10.5}
              y={8.5}
              textAnchor="middle"
              fontSize={7.4}
              fontWeight={700}
              fontFamily="'JetBrains Mono',monospace"
              fill="currentColor"
            >
              CTX
            </text>
          )}
        </svg>
        <span
          className="context-battery-pct"
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 9,
            fontWeight: 600,
            color: "inherit",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {label}
        </span>
      </button>
      {popoverOpen && (
        <div
          ref={popRef}
          role="tooltip"
          style={{
            position: "fixed",
            top: coords.top,
            right: coords.right,
            zIndex: 1000,
            maxWidth: 260,
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
          {full}
        </div>
      )}
    </span>
  );
}
