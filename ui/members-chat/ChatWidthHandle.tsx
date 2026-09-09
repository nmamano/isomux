import { useRef } from "react";
import { useI18n } from "../i18n.tsx";
import { MIN_MEMBERS_CHAT_WIDTH, maxMembersChatWidth } from "../device-settings.ts";

export function ChatWidthHandle({ width, viewportWidth, onChange, onCommit }: {
  width: number;
  viewportWidth: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const { t } = useI18n();
  const drag = useRef<{ x: number; width: number } | null>(null);
  return <div
    role="separator"
    aria-orientation="vertical"
    aria-label={t("membersChat.resize")}
    aria-valuemin={MIN_MEMBERS_CHAT_WIDTH}
    aria-valuemax={maxMembersChatWidth(viewportWidth)}
    aria-valuenow={width}
    tabIndex={0}
    title={t("membersChat.resize")}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (drag.current) onChange(drag.current.width + drag.current.x - event.clientX);
    }}
    onPointerUp={(event) => {
      if (drag.current) onCommit(drag.current.width + drag.current.x - event.clientX);
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      onCommit(width + (event.key === "ArrowLeft" ? 20 : -20));
    }}
    style={{ position: "absolute", left: -5, top: 0, bottom: 0, width: 10, zIndex: 2, cursor: "col-resize", touchAction: "none" }}
  ><span style={{ position: "absolute", top: "45%", left: 4, width: 2, height: 40, borderRadius: 2, background: "var(--text-muted)" }} /></div>;
}
