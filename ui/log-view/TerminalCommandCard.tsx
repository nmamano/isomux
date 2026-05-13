import { useCallback } from "react";
import type { TerminalCommandPayload } from "../../shared/types.ts";
import { CopyButton } from "../components/CopyButton.tsx";

export function TerminalCommandCard({
  payload,
  onCopy,
}: {
  payload: TerminalCommandPayload;
  onCopy: (command: string) => void;
}) {
  const getText = useCallback(() => payload.command, [payload.command]);
  return (
    <div
      style={{
        margin: "8px 0",
        borderRadius: 10,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 13,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            flex: 1,
            minWidth: 0,
          }}
          title={payload.command}
        >
          <span style={{ color: "var(--text-ghost)", userSelect: "none" }}>
            ${" "}
          </span>
          {payload.command}
        </span>
        <CopyButton getText={getText} />
        <button
          onClick={() => onCopy(payload.command)}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid var(--green-border)",
            background: "var(--green-bg)",
            color: "var(--green)",
            fontSize: 12,
            fontFamily: "'JetBrains Mono',monospace",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title="Open the terminal panel and type this command at the prompt (not auto-executed)"
        >
          Copy to terminal
        </button>
      </div>
    </div>
  );
}
