import { useEffect, useRef, useCallback, useState, forwardRef } from "react";
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
  // We render our own input proxy textarea on mobile (see MobileInputProxy
  // below) so we own the input pipeline end-to-end - including swipe-typing
  // and IME composition events that xterm's helper textarea historically
  // mishandles. xterm's own helper textarea is hidden so it doesn't compete
  // for focus or buffer composition state out from under us.
  style.textContent = `
.isomux-mobile-term .xterm .xterm-helper-textarea {
  display: none !important;
}
/* touch-action is consulted on the element where the touch starts, not on
   ancestors, so applying it to the body wrapper alone leaves xterm's inner
   canvas/text layers free to fire native pinch-zoom and double-tap-zoom.
   Force pan-y across all descendants of the body wrapper to keep our
   custom pinch-zoom handler in charge. overscroll-behavior: contain stops
   rubber-band scroll from chaining up to the document body on iOS. */
.isomux-mobile-term-body,
.isomux-mobile-term-body * {
  touch-action: pan-y !important;
  overscroll-behavior: contain !important;
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
  action?: "paste";
};

// Mobile input proxy: a real (invisible) textarea that owns input on mobile.
// We listen to compositionend (swipe-typing on Android, IME on iOS), input,
// and beforeinput so deletes and line breaks reach the PTY no matter which
// keyboard the user is on. Each delivery clears the textarea so it stays
// empty for the next char. Backspace on an empty textarea doesn't fire
// `input`, so we also fall back to keydown.
//
// TODO (CJK IME): hiding xterm's helper textarea (display:none) means the
// in-place IME composition decoration users see while composing CJK / voice
// dictation isn't rendered. Acceptable for English/swipe; revisit if mobile
// CJK support is requested.
const MobileInputProxy = forwardRef<
  HTMLTextAreaElement,
  { onInput: (data: string) => void }
>(function MobileInputProxy({ onInput }, ref) {
  const composingRef = useRef(false);
  // Tracks the most recent beforeinput firing so the keydown fallback can
  // tell whether the same gesture already produced a beforeinput. Without
  // this, a Bluetooth keyboard's Backspace fires keydown AND beforeinput
  // and we'd send DEL twice. (iOS soft keyboards rarely fire keydown, so
  // the issue only shows up on iPad with a hardware keyboard.)
  const lastBeforeInputAtRef = useRef(0);
  function deliver(value: string, target: HTMLTextAreaElement) {
    if (!value) return;
    onInput(value);
    target.value = "";
  }
  return (
    <textarea
      ref={ref}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        deliver(e.currentTarget.value, e.currentTarget);
      }}
      onInput={(e) => {
        if (composingRef.current) return;
        deliver(e.currentTarget.value, e.currentTarget);
      }}
      onBeforeInput={(e) => {
        const native = e.nativeEvent;
        // deleteContentBackward fires on Backspace even when value is empty
        // and even when no input event would follow. We translate to DEL
        // (\x7f) which is what readline expects for backspace.
        if (native.inputType === "deleteContentBackward") {
          e.preventDefault();
          lastBeforeInputAtRef.current = Date.now();
          onInput("\x7f");
        } else if (native.inputType === "deleteWordBackward") {
          e.preventDefault();
          lastBeforeInputAtRef.current = Date.now();
          onInput("\x17"); // Ctrl-W
        } else if (
          native.inputType === "insertLineBreak" ||
          native.inputType === "insertParagraph"
        ) {
          e.preventDefault();
          lastBeforeInputAtRef.current = Date.now();
          onInput("\r");
        }
      }}
      onKeyDown={(e) => {
        // Backup for keyboards that don't fire beforeinput cleanly.
        if (composingRef.current) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onInput("\r");
        } else if (e.key === "Tab") {
          e.preventDefault();
          onInput("\t");
        } else if (e.key === "Backspace" && !e.currentTarget.value) {
          // Only intercept the empty case - if there's pending text,
          // beforeinput already handled it. Also skip if beforeinput just
          // fired for this gesture (Bluetooth keyboard fires both).
          if (Date.now() - lastBeforeInputAtRef.current < 100) return;
          e.preventDefault();
          onInput("\x7f");
        }
      }}
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        width: "100%",
        height: 24,
        padding: 0,
        border: "none",
        background: "transparent",
        color: "transparent",
        // 16px keeps iOS Safari from auto-zooming when focused.
        fontSize: 16,
        opacity: 0,
        // Pointer events skipped so taps fall through to the body div,
        // which programmatically focuses us - we never want this textarea
        // to actually receive a tap (the cursor would land in it).
        pointerEvents: "none",
        caretColor: "transparent",
        resize: "none",
        outline: "none",
        zIndex: 1,
      }}
    />
  );
});

// Filled triangles render at consistent widths in iOS's fallback font; the
// thin Unicode arrows (↑↓←→) come out narrower on left/right than up/down.
const SOFT_KEYS: SoftKey[] = [
  { id: "esc", label: "Esc", data: ESC },
  { id: "tab", label: "Tab", data: TAB },
  { id: "paste", label: "Paste", action: "paste" },
  { id: "ctrl", label: "Ctrl", toggleCtrl: true },
  { id: "up", label: "▲", arrow: ARROW_UP },
  { id: "down", label: "▼", arrow: ARROW_DOWN },
  { id: "left", label: "◀", arrow: ARROW_LEFT },
  { id: "right", label: "▶", arrow: ARROW_RIGHT },
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
  onSendToChat,
}: {
  agentId: string;
  onClose: () => void;
  // When the panel mounts because the boss explicitly toggled it open we
  // grab keyboard focus (default). When the mount is a side-effect of an
  // agent-switch restore, the boss expects to keep typing in the chat box,
  // so the parent passes false. On mobile we never auto-focus on mount -
  // iOS gates the soft-keyboard on a user gesture, so we wait for a tap on
  // the terminal body before calling term.focus().
  autoFocus?: boolean;
  // When true, render the mobile-friendly chrome: a soft-key bar and CSS
  // overrides that make xterm's hidden helper textarea focusable enough
  // for iOS Safari to surface the keyboard.
  mobile?: boolean;
  // When set, a "Send to chat" pill appears while the terminal has a text
  // selection; activating it hands the selected text to the parent (which
  // inserts it into the chat draft as a fenced code block).
  onSendToChat?: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputProxyRef = useRef<HTMLTextAreaElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Lets handleBodyTap query whether the just-completed touch was a scroll
  // gesture (in which case we should NOT focus the input proxy and pop the
  // keyboard). The function is set by the touch-handling effect.
  const scrollMovedRef = useRef<(() => boolean) | null>(null);
  const { mode } = useTheme();
  const [exited, setExited] = useState<number | null>(null);
  // Whether xterm currently has a text selection - drives the "Send to
  // chat" pill's visibility.
  const [hasSelection, setHasSelection] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const ctrlActiveRef = useRef(false);
  // Tracks whether the soft keyboard is currently up (visualViewport noticeably
  // shorter than layout viewport). When up, the env(safe-area-inset-bottom)
  // padding under the soft-key bar is wasted space - the home indicator zone
  // is hidden behind the keyboard - so we drop it.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
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
    [agentId],
  );

  // Send keystrokes to the PTY, applying the sticky Ctrl modifier if armed.
  const sendInput = useCallback(
    (data: string) => {
      let toSend = data;
      if (ctrlActiveRef.current) {
        toSend = applyCtrl(data);
        setCtrl(false);
      }
      send({ type: "terminal_input", agentId, data: toSend });
    },
    [agentId, setCtrl],
  );

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;
    if (mobile) ensureMobileTerminalStyle();

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: mobile ? 14 : 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: mode === "dark" ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Ctrl+C / Ctrl+V copy-paste on non-Mac (Windows/Linux) keyboards.
    // Stock xterm maps Ctrl+letter to a control byte and cancels the
    // keydown, so the browser's native copy/paste never fires (Mac is
    // fine: Cmd combos aren't mapped and already fall through). Returning
    // false makes xterm skip the key WITHOUT cancelling it, so the native
    // copy/paste runs on xterm's focused textarea and xterm's own
    // `copy`/`paste` DOM listeners bridge it to the terminal selection /
    // the PTY (with bracketed paste). This native-event path works over
    // plain HTTP (no navigator.clipboard, no permission prompt), which
    // matters for tailnet access. Exact-modifier matches are deliberate:
    // Ctrl+Shift+V keeps the browser's paste-as-plain-text, Alt/Meta
    // combos stay untouched, and Ctrl+C without a selection still sends
    // ^C (interrupt). Do NOT clearSelection() inside the handler - xterm's
    // copyHandler reads the selection when the native copy event fires
    // after this keydown, so clearing synchronously would copy "".
    if (!(navigator.platform || "").includes("Mac")) {
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (!ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true;
        const key = ev.key.toLowerCase();
        if (key === "c" && term.hasSelection()) return false;
        if (key === "v") return false;
        return true;
      });
    }

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
      if (mobile) {
        // Trick xterm into rendering its focused cursor (block + blink) even
        // though we route input via our own proxy and the helper textarea is
        // hidden. xterm registers a real DOM "focus" listener on the
        // textarea that just sets _isFocused=true; dispatching the event
        // synthetically fires that listener regardless of display state.
        // CAUTION: depends on xterm's internal focus tracking being a pure
        // DOM-event listener - verified in @xterm/xterm 6.0.0. If a future
        // release polls document.activeElement instead, the cursor will
        // stop blinking on mobile and this needs revisiting. Tightening
        // the version pin in package.json would harden against that.
        const helper = containerRef.current?.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        helper?.dispatchEvent(new Event("focus"));
      }
    });

    term.onData((data) => {
      sendInput(data);
    });

    // Selection tracking for the "Send to chat" pill. Fires on both select
    // and deselect; disposed with the terminal (term.dispose()).
    term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
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
      setHasSelection(false);
    };
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update theme without re-creating terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme =
        mode === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [mode]);

  // Track keyboard-open state by comparing visualViewport.height to
  // window.innerHeight. 100px threshold ignores toolbar appear/disappear and
  // only flips when a full soft keyboard opens. Calibrated for iPhone soft
  // keyboards (≥250px tall); the iPad split / floating mini keyboard is
  // shorter and won't cross the threshold - revisit if iPad becomes a
  // first-class target.
  useEffect(() => {
    if (!mobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setKeyboardOpen(window.innerHeight - vv.height > 100);
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, [mobile]);

  // Mobile touch handling: single-finger pan scrolls the scrollback buffer,
  // two-finger pinch scales font size between 10–22px. xterm's canvas
  // renderer hijacks single-finger drag for selection, so the .xterm-viewport
  // never receives the touch - we have to translate the pan to scrollLines()
  // ourselves. Pinch needs a manual fit() (font change doesn't change
  // container size, so ResizeObserver doesn't fire) and a terminal_resize
  // dispatch on touchend so the PTY tracks the new cols/rows.
  useEffect(() => {
    if (!mobile) return;
    const el = bodyRef.current;
    if (!el) return;
    let initialDistance = 0;
    let initialFontSize = 14;
    let pinching = false;
    let rafScheduled = false;
    let scrollLastY: number | null = null;
    let scrollAcc = 0;
    let scrollMoved = false;
    function distance(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function lineHeightPx() {
      const term = termRef.current;
      if (!term) return 18;
      const fs = (term.options.fontSize as number) ?? 14;
      const lh = (term.options.lineHeight as number) ?? 1;
      return fs * lh;
    }
    function onStart(e: TouchEvent) {
      if (!termRef.current) return;
      if (e.touches.length === 2) {
        pinching = true;
        initialDistance = distance(e);
        initialFontSize = (termRef.current.options.fontSize as number) ?? 14;
        scrollLastY = null;
      } else if (e.touches.length === 1) {
        scrollLastY = e.touches[0].clientY;
        scrollAcc = 0;
        scrollMoved = false;
      }
    }
    function onMove(e: TouchEvent) {
      const term = termRef.current;
      if (!term) return;
      if (pinching && e.touches.length === 2) {
        e.preventDefault();
        const ratio = distance(e) / initialDistance;
        const next = Math.max(
          10,
          Math.min(22, Math.round(initialFontSize * ratio)),
        );
        if (next !== term.options.fontSize) {
          term.options.fontSize = next;
          if (!rafScheduled) {
            rafScheduled = true;
            requestAnimationFrame(() => {
              rafScheduled = false;
              fitRef.current?.fit();
            });
          }
        }
      } else if (!pinching && e.touches.length === 1 && scrollLastY !== null) {
        // Always preventDefault on single-finger pan inside the terminal -
        // we own this gesture (xterm scrollback). Without this, sub-pixel
        // early frames let iOS engage document-body rubber-band overscroll
        // on top of our scroll, producing the "two nested scrolls" effect.
        e.preventDefault();
        const currentY = e.touches[0].clientY;
        const dy = currentY - scrollLastY;
        scrollLastY = currentY;
        // Drag down (dy > 0) → reveal earlier content → scrollLines(negative).
        scrollAcc -= dy / lineHeightPx();
        const lines = Math.trunc(scrollAcc);
        if (lines !== 0) {
          term.scrollLines(lines);
          scrollAcc -= lines;
          scrollMoved = true;
        }
      }
    }
    function onEnd(e: TouchEvent) {
      if (e.touches.length >= 2) return;
      if (pinching) {
        pinching = false;
        // Final fit + push the new geometry to the PTY. Doing this only on
        // touchend (not per touchmove) keeps WebSocket traffic sane during
        // the gesture; readline prompts redraw at the new cols/rows after.
        fitRef.current?.fit();
        if (termRef.current) {
          send({
            type: "terminal_resize",
            agentId,
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          });
        }
      }
      scrollLastY = null;
      // scrollMoved is read by handleBodyTap to suppress the focus-on-tap
      // that would otherwise pop the keyboard right after a scroll gesture.
      // It's reset on the next touchstart.
    }
    function getScrollMoved() {
      return scrollMoved;
    }
    scrollMovedRef.current = getScrollMoved;
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      scrollMovedRef.current = null;
    };
  }, [mobile, agentId]);

  // Tap on the terminal body focuses our input proxy so the soft keyboard
  // opens. Mobile only - desktop relies on xterm's built-in click-to-focus.
  // Suppress focus when the click came from a scroll gesture: the synthetic
  // click fires after touchend even if the touch panned the buffer, and
  // popping the keyboard mid-scroll is jarring.
  const handleBodyTap = useCallback(() => {
    if (!mobile) return;
    if (scrollMovedRef.current?.()) return;
    inputProxyRef.current?.focus();
  }, [mobile]);

  // Shared action for the "Send to chat" pill - invoked from pointerdown
  // (mouse/touch) and from keyboard-generated clicks (Enter/Space on the
  // focused button, which emit click without a preceding pointerdown).
  function sendSelectionToChat() {
    const term = termRef.current;
    const text = term?.getSelection() ?? "";
    if (text.trim()) onSendToChat?.(text);
    term?.clearSelection();
  }

  function handleRespawn() {
    setExited(null);
    termRef.current?.clear();
    // Close old PTY (if still around) and open a new one
    send({ type: "terminal_close", agentId });
    setTimeout(() => send({ type: "terminal_open", agentId }), 100);
  }

  async function doPaste() {
    // Try the async Clipboard API first. Requires a secure context, so on
    // plain-HTTP tailnet access (the common case here) it'll usually reject
    // and we fall back to window.prompt, where the user long-presses to
    // paste from the iOS/Android system paste menu. term.paste handles
    // bracketed-paste wrapping based on whether the shell enabled it.
    let text = "";
    try {
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch {}
    if (!text) {
      const fromPrompt = window.prompt("Paste:");
      if (fromPrompt) text = fromPrompt;
    }
    if (text) termRef.current?.paste(text);
    inputProxyRef.current?.focus();
  }

  function handleSoftKey(key: SoftKey) {
    if (key.toggleCtrl) {
      setCtrl(!ctrlActiveRef.current);
      // Re-focus the proxy so the next typed key from the on-screen keyboard
      // is still captured.
      inputProxyRef.current?.focus();
      return;
    }
    if (key.action === "paste") {
      void doPaste();
      return;
    }
    if (key.arrow) {
      // Arrow keys honor the Ctrl modifier (for word-jump in shells).
      sendInput(key.arrow);
    } else if (key.data !== undefined) {
      sendInput(key.data);
    }
    inputProxyRef.current?.focus();
  }

  return (
    <div
      className={mobile ? "isomux-mobile-term" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // borderLeft removed - the parent container's PanelResizer renders
        // the divider so it can be drag-targeted and hover-tinted.
        background: "var(--bg-base)",
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
          {/* Skip the ▶ on mobile: iOS Safari forces it through the system
              emoji renderer which overrides our green CSS color and looks
              like an out-of-place colored emoji. Desktop renders it as a
              proper CSS-colored glyph, which is the intended brand mark. */}
          {!mobile && (
            <span style={{ color: "var(--green)", fontSize: 13 }}>&#9654;</span>
          )}
          Terminal
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: mobile ? 24 : 20,
            padding: mobile ? "4px 10px" : "4px 12px",
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
        {mobile && <MobileInputProxy ref={inputProxyRef} onInput={sendInput} />}
        {/* "Send to chat" pill - shown only while a selection exists. Top-
            right of the body: clear of the exit overlay (bottom-center), the
            soft-key bar (bottom) and the scrollbar edge. It can cover the
            top-right corner of terminal content, but only transiently while
            a selection is active; every overlay position covers *something*,
            and the top-right corner is the least likely to hold the output
            the user is reading (which trails at the bottom). */}
        {onSendToChat && hasSelection && (
          <button
            // Activate on pointerdown, which fires uniformly for mouse and
            // touch. A click-based version with a canceled touchstart is a
            // trap: canceling touchstart suppresses the compatibility click
            // on touch browsers, leaving a visible but dead button.
            // preventDefault here keeps focus (and the xterm selection's
            // owner) where it is without a blur flash; the click swallower
            // below stops any follow-up click from bubbling to handleBodyTap
            // and popping the mobile keyboard.
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              sendSelectionToChat();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // detail === 0 marks a keyboard-generated click (Enter/Space
              // on the focused button) - no pointerdown preceded it, so the
              // action runs here. Pointer-generated clicks (detail >= 1)
              // already ran it in pointerdown and are only swallowed.
              if (e.detail === 0) sendSelectionToChat();
            }}
            style={{
              position: "absolute",
              top: 8,
              right: 16,
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid var(--border-medium)",
              background: "var(--bg-overlay)",
              color: "var(--text-secondary)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
              zIndex: 2,
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTapHighlightColor: "transparent",
            }}
            title="Insert the selected text into the chat input as a code block"
          >
            Send to chat
          </button>
        )}
        {/* Exit overlay - anchored to the body so it floats above whatever
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
              onClick={(e) => {
                e.stopPropagation();
                handleRespawn();
              }}
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

      {/* Soft-key bar (mobile only). Adds the home-indicator safe-area
          inset only when the soft keyboard is dismissed - when it's up, the
          keyboard already covers the home indicator zone, so the inset
          becomes wasted vertical space. */}
      {mobile && (
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "6px 8px",
            paddingBottom: keyboardOpen
              ? 6
              : "calc(6px + env(safe-area-inset-bottom, 0px))",
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
                // xterm's helper textarea - Safari's simulated mousedown can
                // arrive too late to block focus shift on touch devices, so
                // we belt-and-braces with touchstart.
                onTouchStart={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault();
                  handleSoftKey(key);
                }}
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
