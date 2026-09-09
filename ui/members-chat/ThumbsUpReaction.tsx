import { useId, useState } from "react";
import { useI18n } from "../i18n.tsx";

export function ThumbsUpReaction({
  active,
  names,
  onChange,
  isMobile,
}: {
  active: boolean;
  names: string[];
  onChange: (active: boolean) => Promise<void>;
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [showNames, setShowNames] = useState(false);
  const namesId = useId();
  async function toggle() {
    setPending(true);
    try {
      await onChange(!active);
    } finally {
      setPending(false);
    }
  }
  const buttonStyle = {
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: active ? "var(--bg-subtle)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    padding: isMobile ? "6px 9px" : "2px 6px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 4,
        marginTop: 4,
      }}
    >
      <button
        type="button"
        aria-label={t(
          active ? "membersChat.removeThumbsUp" : "membersChat.thumbsUp",
        )}
        aria-pressed={active}
        disabled={pending}
        onClick={() => void toggle()}
        style={buttonStyle}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path
            d="M7 10v11H3V10h4Zm0 0 5-8c3 0 3 3 1 7h6a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H7"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {names.length > 0 && (
        <>
          <button
            type="button"
            style={buttonStyle}
            title={names.join(", ")}
            aria-label={t("membersChat.reactors", { count: names.length })}
            aria-expanded={showNames}
            aria-controls={namesId}
            // Touch emits a compatibility mouseleave after click; only a mouse controls hover.
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setShowNames(true);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") setShowNames(false);
            }}
            onFocus={() => setShowNames(true)}
            onBlur={() => setShowNames(false)}
            onClick={() => setShowNames(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setShowNames(false);
            }}
          >
            {names.length}
          </button>
          {showNames && (
            <span
              id={namesId}
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              {names.join(", ")}
            </span>
          )}
        </>
      )}
    </div>
  );
}
