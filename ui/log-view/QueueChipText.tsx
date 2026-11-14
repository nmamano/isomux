import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";

// A queued message's text, clamped to a few lines with Show more when the
// clamp cuts it (task 56dc8307). A chip can wait a long time, so the cut is
// measured again when its width changes (panel resize, phone rotation).
export function QueueChipText({
  text,
  isMobile,
}: {
  text: string;
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded, isMobile]);
  return (
    <>
      <div
        ref={ref}
        {...noTranslate()}
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.4,
          ...(expanded
            ? {}
            : {
                display: "-webkit-box",
                WebkitLineClamp: isMobile ? 3 : 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }),
        }}
      >
        {text}
      </div>
      {(clamped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            marginTop: 2,
            color: "var(--accent-text)",
            fontSize: isMobile ? 12 : 11,
            cursor: "pointer",
          }}
        >
          {expanded
            ? t("cards.toolResult.showLess")
            : t("cards.toolResult.showMore")}
        </button>
      )}
    </>
  );
}
