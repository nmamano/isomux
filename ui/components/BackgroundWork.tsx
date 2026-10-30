// Background work an agent's session still runs (AgentInfo.backgroundTasks):
// the chat-header pill that lists what runs. The ring that replaces the zZ of
// an idle agent is in BackgroundMark.tsx. SVG only: iOS draws dingbat glyphs
// as emoji.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { useI18n } from "../i18n.tsx";
import type { BackgroundTask } from "../../shared/types.ts";
import { spin } from "./BackgroundMark.tsx";

export { SceneBackgroundMark } from "./BackgroundMark.tsx";

/** A slow-turning open ring: work runs, but not as a turn. */
function BackgroundIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <circle
        cx="6"
        cy="6"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="1.6"
      />
      <path
        d="M6 1.5 A4.5 4.5 0 0 1 10.5 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        {spin(6, 6)}
      </path>
    </svg>
  );
}

const ROW_KEYS = {
  agent: "logView.background.agent",
  command: "logView.background.command",
  workflow: "logView.background.workflow",
} as const;

/** Chat header, every state: the ring and the count (the words are its
 *  tooltip, to keep the header narrow), and a click lists what runs. */
export function HeaderBackgroundPill({
  tasks,
  phone = false,
}: {
  tasks: BackgroundTask[];
  /** Phone header: the open list anchors to the screen's right edge. */
  phone?: boolean;
}) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const empty = tasks.length === 0;

  useLayoutEffect(() => {
    if (open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
  }, [open]);

  // Escape and a press outside the pill and its list close the list.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPress = (e: Event) => {
      const target = e.target as Node | null;
      if (
        target &&
        (btnRef.current?.contains(target) || listRef.current?.contains(target))
      )
        return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  // The last task ended while the list was open: it does not come back open
  // with the next task.
  if (empty && open) setOpen(false);
  if (empty) return null;
  const countText = tn("logView.background.count", tasks.length);
  return (
    <span style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        data-background-pill=""
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={countText}
        title={countText}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 8px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--bg-subtle)",
          color: "var(--accent-text)",
          fontSize: 12,
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        <BackgroundIcon size={11} />
        {tasks.length}
      </button>
      {open && rect && (
        <Portal>
          <div
            ref={listRef}
            role="list"
            data-background-list=""
            style={{
              position: "fixed",
              top: rect.bottom + 6,
              ...(phone ? { right: 8 } : { left: rect.left }),
              zIndex: 1000,
              minWidth: 260,
              maxWidth: "min(360px, 80vw)",
              padding: "6px 0",
              borderRadius: 8,
              background: "var(--bg-surface-solid)",
              border: "1px solid var(--border-medium)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
          >
            {tasks.map((task) => (
              <div
                key={task.id}
                role="listitem"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 12px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ color: "var(--accent-text)", flexShrink: 0 }}>
                  <BackgroundIcon size={10} />
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t(ROW_KEYS[task.kind], { label: task.label })}
                </span>
              </div>
            ))}
          </div>
        </Portal>
      )}
    </span>
  );
}
