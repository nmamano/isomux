import { useEffect, useState } from "react";
import type { AgentState } from "../../shared/types.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { useI18n } from "../i18n.tsx";

// Catalog keys, read at render: the header shows them in the reader's language
// (internal-docs/i18n-loop.md, ruling 7).
export const STATE_LABEL_KEYS: Partial<Record<AgentState, PlainMessageKey>> = {
  thinking: "logView.state.thinking",
  tool_executing: "logView.state.toolExecuting",
};

const ESCALATION_AMBER_MS = 2 * 60 * 1000; // 2 minutes
const ESCALATION_RED_MS = 5 * 60 * 1000; // 5 minutes

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function escalationColor(elapsedMs: number, baseColor: string): string {
  if (elapsedMs >= ESCALATION_RED_MS) return "var(--red-text)";
  if (elapsedMs >= ESCALATION_AMBER_MS) return "var(--orange-text)";
  return baseColor;
}

export function ActivityIndicator({
  state,
  stateChangedAt,
  onAbort,
}: {
  state: AgentState;
  stateChangedAt?: number;
  onAbort?: () => void;
}) {
  const { t } = useI18n();
  const labelKey = STATE_LABEL_KEYS[state];
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!labelKey) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [labelKey]);

  if (!labelKey) return null;

  const elapsedMs = stateChangedAt ? now - stateChangedAt : 0;
  const baseColor =
    state === "waiting_for_response"
      ? "var(--purple-text)"
      : "var(--green-text)";
  const color = escalationColor(elapsedMs, baseColor);
  const showAbort = elapsedMs >= ESCALATION_AMBER_MS;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 14px",
        margin: "8px 0",
        color,
        fontSize: 12,
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <span style={{ display: "inline-flex", gap: 3 }}>
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.2s",
          }}
        />
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: color,
            animation: "dotBounce 1.4s ease-in-out infinite",
            animationDelay: "0.4s",
          }}
        />
      </span>
      <span>{labelKey && t(labelKey)}...</span>
      <span
        style={{
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 11,
        }}
      >
        {formatElapsed(elapsedMs)}
      </span>
      {showAbort && onAbort && (
        <button
          onClick={onAbort}
          title={t("logView.abortTitle")}
          style={{
            marginLeft: 8,
            padding: "2px 10px",
            borderRadius: 4,
            border: `1px solid ${color}`,
            background: "transparent",
            color,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {t("logView.abort")}
        </button>
      )}
    </div>
  );
}
