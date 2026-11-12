// The desktop sidebar's slot (task 5dac6b9b): the column the sidebar takes
// beside the office, a chat or a page. Its width is the member's on this
// device; a drag of its right edge changes it (200-440 px) and a
// double-click resets it. Shown or hidden, the slot opens or closes over
// 200 ms with the sidebar anchored to its right edge, so the sidebar slides
// and the column beside it (the room, the top bar, the room tab bar) moves
// with it. The office scene re-centres as its box changes (useViewport's
// ResizeObserver) while the member has not panned or zoomed it; a view they
// moved keeps its place and is only clamped.
//
// The drag and the slide never re-render React per frame: the drag writes
// the width to the slot's own style, and the slide is a CSS transition.

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
} from "../chat-sidebar.ts";
import {
  getChatSidebarWidth,
  setChatSidebarWidth,
} from "../device-settings.ts";
import { useI18n } from "../i18n.tsx";

/** How long the slide takes, in ms (also in styles.ts). */
export const SIDEBAR_SLIDE_MS = 200;

type Phase = "open" | "opening" | "closing" | "closed";

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function SidebarSlot({
  open,
  children,
}: {
  open: boolean;
  // The sidebar, told whether it is sliding out.
  children: (closing: boolean) => ReactNode;
}): React.ReactElement | null {
  const { t } = useI18n();
  const [width, setWidth] = useState(
    () => getChatSidebarWidth() ?? CHAT_SIDEBAR_WIDTH_DEFAULT,
  );
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  // The phase follows `open`: a show opens from 0, a hide slides out first.
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) setPhase(phase === "closing" ? "open" : "opening");
    else setPhase(reducedMotion() ? "closed" : "closing");
  }
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (phase === "opening") {
      // The slot is at 0 in the DOM: read its layout so the browser takes
      // that as the start of the transition, then open it.
      void slotRef.current?.offsetWidth;
      // Deliberate: the open width must follow the 0 the browser just laid
      // out, in the same frame, or there is nothing to transition from.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPhase("open");
    }
    if (phase === "closing") {
      const id = setTimeout(() => setPhase("closed"), SIDEBAR_SLIDE_MS);
      return () => clearTimeout(id);
    }
  }, [phase]);

  // The drag: the start point and width, and the live width, kept out of
  // React state until the pointer lets go.
  const drag = useRef<{ x: number; width: number; now: number } | null>(null);
  const applyWidth = (w: number) => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.style.width = `${w}px`;
    slot.style.setProperty("--chat-sidebar-w", `${w}px`);
  };
  const commit = (w: number) => {
    setWidth(w);
    setChatSidebarWidth(w);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    slotRef.current?.removeAttribute("data-dragging");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    commit(d.now);
  };

  if (phase === "closed") return null;
  const shownWidth = phase === "open" ? width : 0;
  const style = {
    position: "relative",
    flexShrink: 0,
    height: "100%",
    overflow: "hidden",
    width: `${shownWidth}px`,
    "--chat-sidebar-w": `${width}px`,
  } as CSSProperties;
  return (
    <div
      ref={slotRef}
      className="chat-sidebar-slot"
      data-sidebar-slot=""
      style={style}
    >
      {children(phase === "closing")}
      {phase === "open" && (
        <div
          className="panel-resizer chat-sidebar-resizer"
          data-sidebar-resizer=""
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resize")}
          title={t("sidebar.resize")}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {}
            drag.current = { x: e.clientX, width, now: width };
            slotRef.current?.setAttribute("data-dragging", "");
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            d.now = clampSidebarWidth(d.width + e.clientX - d.x);
            applyWidth(d.now);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => {
            applyWidth(CHAT_SIDEBAR_WIDTH_DEFAULT);
            commit(CHAT_SIDEBAR_WIDTH_DEFAULT);
          }}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 2,
            touchAction: "none",
          }}
        />
      )}
    </div>
  );
}
