// A textarea with an expand affordance. Memory files and
// system prompts are multi-paragraph documents being edited through a field a
// few lines tall inside a modal; clicking the corner button reopens the SAME
// field as a near-fullscreen editor.
//
// It is deliberately a viewport, not a second editor: the overlay is bound to
// the caller's `value` / `onChange`, so there is no second save path, no
// second copy of the text, and nothing to reconcile. Whatever version guard or
// conflict detection the host dialog has (the memory editor's optimistic
// version, the room/office settings PUT's) applies unchanged, because the
// overlay never talks to the server at all - closing it just returns you to
// the dialog, where Save still does exactly what it did.
//
// ESCAPE: every host dialog registers a CAPTURE-phase window keydown that
// closes the dialog on Escape, and those listeners were registered before this
// overlay mounted, so they run first and would close the whole dialog out from
// under an expanded editor. Hosts therefore consult isExpandedEditorOpen() and
// stand down while one is open; the overlay's own handler closes just itself.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Portal } from "./Portal.tsx";
import { useI18n } from "../i18n.tsx";

// How many expanded editors are currently mounted (0 or 1 in practice; a
// counter rather than a boolean so an unmount can never zero out a newer one).
let openCount = 0;

/** True while a full-screen editor is open. Host dialogs must not act on
 *  Escape while this holds - the overlay consumes that key. */
export function isExpandedEditorOpen(): boolean {
  return openCount > 0;
}

const EXPAND_ICON = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.5 2.5h4v4" />
    <path d="M13.5 2.5 9 7" />
    <path d="M6.5 13.5h-4v-4" />
    <path d="M2.5 13.5 7 9" />
  </svg>
);

export function ExpandableTextarea({
  value,
  onChange,
  title,
  hint,
  readOnly,
  rows,
  placeholder,
  style,
  textareaRef,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Shown in the overlay header, e.g. "Room Prompt". */
  title: string;
  /** Optional line under the overlay header - usually the same guidance the
   *  inline field has below it, which is out of sight while expanded. */
  hint?: ReactNode;
  readOnly?: boolean;
  rows?: number;
  placeholder?: string;
  style?: CSSProperties;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labelId = useId();
  const expandBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        readOnly={readOnly}
        style={{ ...style, display: "block", width: "100%" }}
      />
      <button
        ref={expandBtnRef}
        type="button"
        onClick={() => setExpanded(true)}
        title={t("dialogs.textarea.expand", { title })}
        aria-label={t("dialogs.textarea.expand", { title })}
        style={expandBtnStyle}
      >
        {EXPAND_ICON}
      </button>
      {expanded && (
        <ExpandedEditor
          value={value}
          onChange={onChange}
          title={title}
          titleId={labelId}
          hint={hint}
          readOnly={readOnly}
          placeholder={placeholder}
          onClose={() => {
            setExpanded(false);
            // Put the caret back where the user left it. Without this, closing
            // drops focus to <body> and the next Tab restarts from the top of
            // the dialog.
            expandBtnRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function ExpandedEditor({
  value,
  onChange,
  title,
  titleId,
  hint,
  readOnly,
  placeholder,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  title: string;
  titleId: string;
  hint?: ReactNode;
  readOnly?: boolean;
  placeholder?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Claim the Escape key for as long as this is mounted (see the file header).
  // useLayoutEffect, not useEffect: the counter must already be raised in the
  // same commit that paints the overlay, or an Escape landing in that gap would
  // be handled by the host dialog while an editor is visibly open.
  useLayoutEffect(() => {
    openCount++;
    return () => {
      openCount--;
    };
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // The host dialog's capture handler already stood down for us; stop the
      // event here so App's global "back to the office" handler never sees it
      // either. Collapsing is the whole action.
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    // Caret at the end, matching how the inline prompt fields open.
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  return (
    <Portal>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // aria-modal claims nothing outside this subtree is reachable, so make
        // that true for the keyboard as well: Tab and Shift+Tab wrap within the
        // overlay instead of walking into the host dialog behind it.
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const focusable = rootRef.current?.querySelectorAll<HTMLElement>(
            "button, textarea, [href], input, select, [tabindex]:not([tabindex='-1'])",
          );
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }}
        style={{
          position: "fixed",
          // Starts below the connection banner when one is showing, the way
          // the full-page views do - covering it would hide "reconnecting…"
          // from someone typing into a field whose save is about to fail.
          top: "var(--banner-h, 0px)",
          left: 0,
          right: 0,
          bottom: 0,
          // Above the settings dialogs (z 900) it was opened from.
          zIndex: 1500,
          background: "var(--bg-base)",
          display: "flex",
          flexDirection: "column",
          padding: "env(safe-area-inset-top, 0px) 0 0",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
            minHeight: 44,
            borderBottom: "1px solid var(--border-subtle)",
            flexShrink: 0,
          }}
        >
          <span
            id={titleId}
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            {title}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>
            {t("dialogs.textarea.escCollapse")}
          </span>
          <button type="button" onClick={onClose} style={doneBtnStyle}>
            {t("dialogs.textarea.done")}
          </button>
        </div>
        {hint && (
          <p
            style={{
              margin: 0,
              padding: "8px 16px 0",
              fontSize: 11,
              color: "var(--text-ghost)",
              lineHeight: 1.4,
              flexShrink: 0,
            }}
          >
            {hint}
          </p>
        )}
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          spellCheck={false}
          style={{
            flex: 1,
            margin: 16,
            padding: 14,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-input)",
            color: "var(--text-primary)",
            fontSize: 13,
            fontFamily: "'JetBrains Mono',monospace",
            lineHeight: 1.6,
            resize: "none",
            outline: "none",
            minHeight: 0,
          }}
        />
      </div>
    </Portal>
  );
}

const expandBtnStyle: CSSProperties = {
  position: "absolute",
  top: 6,
  right: 6,
  width: 22,
  height: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid var(--border-medium)",
  borderRadius: 5,
  background: "var(--btn-surface)",
  color: "var(--text-dim)",
  cursor: "pointer",
  // The scrollbar of a full textarea would otherwise sit under the button.
  opacity: 0.85,
};

const doneBtnStyle: CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--btn-surface)",
  color: "var(--text-primary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
