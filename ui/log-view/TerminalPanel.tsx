import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import { useTheme } from "../store.tsx";
import type { ServerMessage } from "../../shared/types.ts";

const DARK_THEME = {
  background: "#0a0e16",
  foreground: "#c0c8d8",
  cursor: "#50B86C",
  cursorAccent: "#0a0e16",
  selectionBackground: "rgba(126,184,255,0.2)",
  black: "#1a2030",
  red: "#E85D75",
  green: "#50B86C",
  yellow: "#F5A623",
  blue: "#7eb8ff",
  magenta: "#9B6DFF",
  cyan: "#56d4dd",
  white: "#c0c8d8",
  brightBlack: "#5a6f8f",
  brightRed: "#ff7b92",
  brightGreen: "#6fd88a",
  brightYellow: "#ffc44d",
  brightBlue: "#a0d0ff",
  brightMagenta: "#b98eff",
  brightCyan: "#7eeef5",
  brightWhite: "#e0e8f5",
};

const LIGHT_THEME = {
  background: "#f0f2f6",
  foreground: "#3a4a60",
  cursor: "#16a34a",
  cursorAccent: "#f0f2f6",
  selectionBackground: "rgba(59,130,246,0.2)",
  black: "#1a2030",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#d97706",
  blue: "#3b82f6",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#3a4a60",
  brightBlack: "#7a8a9a",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#60a5fa",
  brightMagenta: "#a78bfa",
  brightCyan: "#22d3ee",
  brightWhite: "#1a2030",
};

// xterm escape sequences for navigation keys we expose on the soft-key bar.
const ESC = "\x1b";
const TAB = "\t";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_RIGHT = "\x1b[C";
const ARROW_LEFT = "\x1b[D";
const CTRL_ARROW: Record<string, string> = {
  [ARROW_UP]: "\x1b[1;5A",
  [ARROW_DOWN]: "\x1b[1;5B",
  [ARROW_RIGHT]: "\x1b[1;5C",
  [ARROW_LEFT]: "\x1b[1;5D",
};

// Apply the Ctrl modifier to a single byte of input. Letters and a few
// neighbouring punctuation map onto the C0 control range; for arrow keys we
// rewrite the CSI sequence into its Ctrl-modified form. Everything else
// passes through unchanged.
function applyCtrl(data: string): string {
  if (data.length === 1) {
    const c = data.charCodeAt(0);
    if (c >= 0x40 && c <= 0x7e) return String.fromCharCode(c & 0x1f);
    return data;
  }
  return CTRL_ARROW[data] ?? data;
}

const MOBILE_TERMINAL_STYLE_ID = "isomux-mobile-terminal-style";
function ensureMobileTerminalStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(MOBILE_TERMINAL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = MOBILE_TERMINAL_STYLE_ID;
  // The xterm helper textarea defaults to 0×0 at left:-9999em with z-index:-5.
  // iOS Safari refuses to show the soft keyboard when the focused input is
  // both off-screen and zero-sized. Scoping these overrides to the
  // `.isomux-mobile-term` wrapper gives the textarea a real footprint
  // (overlapping the cursor row) while keeping it invisible (opacity 0,
  // pointer-events: none so taps fall through to the terminal body which
  // re-focuses it via term.focus()).
  style.textContent = `
.isomux-mobile-term .xterm .xterm-helper-textarea {
  left: 0 !important;
  top: 0 !important;
  width: 100% !important;
  height: 24px !important;
  opacity: 0 !important;
  z-index: 0 !important;
  pointer-events: none !important;
  font-size: 16px !important;
  caret-color: transparent !important;
}
/* touch-action is consulted on the element where the touch starts, not on
   ancestors, so applying it to the body wrapper alone leaves xterm's inner
   canvas/text layers free to fire native pinch-zoom and double-tap-zoom.
   Force pan-y across all descendants of the body wrapper to keep our
   custom pinch-zoom handler in charge. */
.isomux-mobile-term-body,
.isomux-mobile-term-body * {
  touch-action: pan-y !important;
}
`;
  document.head.appendChild(style);
}

type SoftKey = {
  id: string;
  label: string;
  data?: string;
  arrow?: string;
  toggleCtrl?: boolean;
};

const SOFT_KEYS: SoftKey[] = [
  { id: "esc", label: "Esc", data: ESC },
  { id: "tab", label: "Tab", data: TAB },
  { id: "ctrl", label: "Ctrl", toggleCtrl: true },
  { id: "up", label: "↑", arrow: ARROW_UP },
  { id: "down", label: "↓", arrow: ARROW_DOWN },
  { id: "left", label: "←", arrow: ARROW_LEFT },
  { id: "right", label: "→", arrow: ARROW_RIGHT },
  { id: "pipe", label: "|", data: "|" },
  { id: "tilde", label: "~", data: "~" },
  { id: "slash", label: "/", data: "/" },
  { id: "minus", label: "-", data: "-" },
];

export function TerminalPanel({
  agentId,
  onClose,
  autoFocus = true,
  mobile = false,
}: {
  agentId: string;
  onClose: () => void;
  // When the panel mounts because the boss explicitly toggled it open we
  // grab keyboard focus (default). When the mount is a side-effect of an
  // agent-switch restore, the boss expects to keep typing in the chat box,
  // so the parent passes false. On mobile we never auto-focus on mount —
  // iOS gates the soft-keyboard on a user gesture, so we wait for a tap on
  // the terminal body before calling term.focus().
  autoFocus?: boolean;
  // When true, render the mobile-friendly chrome: a soft-key bar and CSS
  // overrides that make xterm's hidden helper textarea focusable enough
  // for iOS Safari to surface the keyboard.
  mobile?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { theme } = useTheme();
  const [exited, setExited] = useState<number | null>(null);
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlActiveRef = useRef(false);
  // Wrap the state setter so the ref stays in sync without a render-time
  // write. sendInput / handleSoftKey both read the ref synchronously inside
  // event handlers, so it must lead the React render.
  const setCtrl = useCallback((v: boolean) => {
    ctrlActiveRef.current = v;
    setCtrlActive(v);
  }, []);

  // Handle server messages for this terminal
  const handleRawMessage = useCallback(
    (data: string) => {
      try {
        const msg = JSON.parse(data) as ServerMessage;
        if (msg.type === "terminal_output" && msg.agentId === agentId) {
          termRef.current?.write(msg.data);
        } else if (msg.type === "terminal_exit" && msg.agentId === agentId) {
          setExited(msg.exitCode);
        }
      } catch {}
    },
    [agentId]
  );

  // Send keystrokes to the PTY, applying the sticky Ctrl modifier if armed.
  const sendInput = useCallback((data: string) => {
    let toSend = data;
    if (ctrlActiveRef.current) {
      toSend = applyCtrl(data);
      setCtrl(false);
    }
    send({ type: "terminal_input", agentId, data: toSend });
  }, [agentId, setCtrl]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;
    if (mobile) ensureMobileTerminalStyle();

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: mobile ? 14 : 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit and (optionally) focus after open. requestAnimationFrame so the
    // container has measurable size before fitAddon runs.
    requestAnimationFrame(() => {
      fitAddon.fit();
      if (autoFocus && !mobile) term.focus();
      send({
        type: "terminal_resize",
        agentId,
        cols: term.cols,
        rows: term.rows,
      });
    });

    term.onData((data) => {
      sendInput(data);
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // Listen for terminal messages via raw WebSocket listener
    // (survives reconnects, avoids unnecessary React re-renders)
    addRawListener(handleRawMessage);

    // Open the PTY on the server
    send({ type: "terminal_open", agentId });

    // Resize observer
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      send({
        type: "terminal_resize",
        agentId,
        cols: term.cols,
        rows: term.rows,
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      removeRawListener(handleRawMessage);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update theme without re-creating terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  // Pinch-to-zoom on mobile: two-finger drag scales font size between 10–22px.
  // The container size is unchanged by a font change, so the panel's
  // ResizeObserver does not fire; we manually run fit() (rAF-throttled) and
  // send terminal_resize on touchend so the PTY reflects the new cols/rows.
  useEffect(() => {
    if (!mobile) return;
    const el = bodyRef.current;
    if (!el) return;
    let initialDistance = 0;
    let initialFontSize = 14;
    let pinching = false;
    let rafScheduled = false;
    function distance(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 2 || !termRef.current) return;
      pinching = true;
      initialDistance = distance(e);
      initialFontSize = (termRef.current.options.fontSize as number) ?? 14;
    }
    function onMove(e: TouchEvent) {
      if (!pinching || e.touches.length !== 2 || !termRef.current) return;
      e.preventDefault();
      const ratio = distance(e) / initialDistance;
      const next = Math.max(10, Math.min(22, Math.round(initialFontSize * ratio)));
      if (next !== termRef.current.options.fontSize) {
        termRef.current.options.fontSize = next;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            rafScheduled = false;
            fitRef.current?.fit();
          });
        }
      }
    }
    function onEnd(e: TouchEvent) {
      if (e.touches.length >= 2 || !pinching) return;
      pinching = false;
      // Final fit + push the new geometry to the PTY. Doing this only on
      // touchend (not per touchmove) keeps WebSocket traffic sane during the
      // gesture; readline-driven prompts redraw at the new dimensions once
      // the gesture completes.
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) {
        send({ type: "terminal_resize", agentId, cols: term.cols, rows: term.rows });
      }
    }
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [mobile, agentId]);

  // Tap on the terminal body re-focuses xterm so the soft keyboard re-opens
  // after the user has dismissed it. Mobile only — desktop relies on xterm's
  // built-in click-to-focus.
  const handleBodyTap = useCallback(() => {
    if (!mobile) return;
    termRef.current?.focus();
  }, [mobile]);

  function handleRespawn() {
    setExited(null);
    termRef.current?.clear();
    // Close old PTY (if still around) and open a new one
    send({ type: "terminal_close", agentId });
    setTimeout(() => send({ type: "terminal_open", agentId }), 100);
  }

  function handleSoftKey(key: SoftKey) {
    if (key.toggleCtrl) {
      setCtrl(!ctrlActiveRef.current);
      // Re-focus so the next typed key (from the on-screen keyboard) is
      // captured by xterm's textarea.
      termRef.current?.focus();
      return;
    }
    if (key.arrow) {
      // Arrow keys honor the Ctrl modifier (for word-jump in shells).
      sendInput(key.arrow);
    } else if (key.data !== undefined) {
      sendInput(key.data);
    }
    termRef.current?.focus();
  }

  return (
    <div
      className={mobile ? "isomux-mobile-term" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // borderLeft removed — the parent container's PanelResizer renders
        // the divider so it can be drag-targeted and hover-tinted.
        background: theme === "dark" ? "#0a0e16" : "#f0f2f6",
        position: "relative",
      }}
    >
      {/* Terminal header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          height: mobile ? 44 : 36,
          borderBottom: "1px solid var(--border-strong)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: mobile ? 13 : 11,
            color: "var(--text-dim)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--green)", fontSize: 13 }}>&#9654;</span>
          Terminal
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: mobile ? 24 : 16,
            padding: mobile ? "4px 10px" : "0 4px",
            lineHeight: 1,
          }}
          title="Close terminal"
        >
          &times;
        </button>
      </div>

      {/* Terminal body. position:relative so the exit overlay anchors to the
          body bottom (above the soft-key bar) without a hard-coded offset. */}
      <div
        ref={bodyRef}
        className={mobile ? "isomux-mobile-term-body" : undefined}
        onClick={handleBodyTap}
        style={{
          flex: 1,
          minHeight: 0,
          padding: 4,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {/* Exit overlay — anchored to the body so it floats above whatever
            sits below (soft-key bar on mobile, nothing on desktop). */}
        {exited !== null && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-medium)",
              borderRadius: 8,
              padding: "8px 16px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 12,
              color: "var(--text-dim)",
              boxShadow: "0 4px 12px var(--shadow)",
            }}
          >
            <span>Shell exited ({exited})</span>
            <button
              onClick={handleRespawn}
              style={{
                padding: "3px 12px",
                borderRadius: 6,
                border: "1px solid var(--green-border)",
                background: "var(--green-bg)",
                color: "var(--green)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Restart
            </button>
          </div>
        )}
      </div>

      {/* Soft-key bar (mobile only) — sits above the safe-area inset so it
          stays clear of the home indicator on iOS while the soft keyboard
          is dismissed. */}
      {mobile && (
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "6px 8px",
            paddingBottom: "calc(6px + env(safe-area-inset-bottom, 0px))",
            background: "var(--bg-surface)",
            borderTop: "1px solid var(--border-strong)",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            flexShrink: 0,
          }}
        >
          {SOFT_KEYS.map((key) => {
            const isCtrl = key.toggleCtrl;
            const active = isCtrl && ctrlActive;
            return (
              <button
                key={key.id}
                // touchstart + mousedown both preventDefault to keep focus on
                // xterm's helper textarea — Safari's simulated mousedown can
                // arrive too late to block focus shift on touch devices, so
                // we belt-and-braces with touchstart.
                onTouchStart={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.preventDefault(); handleSoftKey(key); }}
                style={{
                  flexShrink: 0,
                  minWidth: 40,
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${active ? "var(--green-border)" : "var(--border-medium)"}`,
                  background: active ? "var(--green-bg)" : "var(--btn-surface)",
                  color: active ? "var(--green)" : "var(--text-primary)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                {key.label}
              </button>
            );
          })}
        </div>
      )}

    </div>
  );
}
