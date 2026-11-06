// A paged ask's alarm on its card (task 74e8fc07): a bell and the state, and
// Ack while it rings. The ack stops the alerts on every member's Discord and
// devices; the ask stays open for a reply.

import type { CSSProperties } from "react";
import type { AskPageWire } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";

// An SVG, not a glyph: Safari draws a bell glyph through the emoji font.
function Bell({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M8 1.5a4 4 0 0 0-4 4v2.7L2.6 11h10.8L12 8.2V5.5a4 4 0 0 0-4-4Z M6.3 12.5a1.8 1.8 0 0 0 3.4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AskPageLine({
  page,
  acking,
  onAck,
  isMobile,
  fontSize,
  buttonStyle,
}: {
  page: AskPageWire;
  acking: boolean;
  onAck: () => void;
  isMobile: boolean;
  fontSize: number;
  buttonStyle: CSSProperties;
}) {
  const { t } = useI18n();
  const ringing = page.state === "ringing";
  const label = ringing
    ? t("asks.page.ringing")
    : page.ackedBy
      ? t("asks.page.ackedBy", { name: page.ackedBy })
      : t("asks.page.acked");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        marginTop: 7,
      }}
    >
      <span
        data-ask-page={page.state}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          color: ringing ? "var(--red-text)" : "var(--text-ghost)",
          fontSize,
          fontWeight: ringing ? 600 : 400,
        }}
      >
        <Bell size={isMobile ? 15 : 14} />
        {label}
      </span>
      {ringing && (
        <button
          type="button"
          data-ask-ack=""
          title={t("asks.page.ackTitle")}
          disabled={acking}
          onClick={onAck}
          style={{
            ...buttonStyle,
            cursor: acking ? "default" : "pointer",
          }}
        >
          {t("asks.page.ack")}
        </button>
      )}
    </div>
  );
}
