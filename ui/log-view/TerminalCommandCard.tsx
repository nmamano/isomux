import { useCallback } from "react";
import type {
  AskCommandRun,
  TerminalCommandPayload,
} from "../../shared/types.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { useI18n } from "../i18n.tsx";
import { AskRunResult } from "./AskRunResult.tsx";

const runLabel = (shown: boolean) =>
  ({
    gridArea: "1 / 1",
    visibility: shown ? "visible" : "hidden",
  }) as const;

export function TerminalCommandCard({
  payload,
  onCopy,
  onRun,
  run,
  runError,
  pending = false,
  isMobile = false,
}: {
  payload: TerminalCommandPayload;
  onCopy: (command: string) => void;
  // On an ask's command only (task c3b91695): the Run button, the command's
  // latest run, the refusal of the last tap, and a tap whose answer is due.
  onRun?: (command: string) => void;
  run?: AskCommandRun;
  runError?: string | null;
  pending?: boolean;
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const getText = useCallback(() => payload.command, [payload.command]);
  const running = pending || run?.state === "running";
  const button = {
    padding: isMobile ? "6px 14px" : "4px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontFamily: "var(--font-ui)",
    cursor: "pointer",
    flexShrink: 0,
  } as const;
  const green = {
    border: "1px solid var(--green-border)",
    background: "var(--green-bg)",
    color: "var(--green-text)",
  } as const;
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
            // Beside Run the command takes its own row and the buttons the
            // row under it, so a narrow screen does not squeeze it.
            flex: onRun ? "1 1 100%" : 1,
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
        {onRun && (
          <button
            type="button"
            data-ask-run=""
            disabled={running}
            onClick={() => onRun(payload.command)}
            style={{
              ...button,
              ...green,
              fontWeight: 600,
              opacity: running ? 0.6 : 1,
              cursor: running ? "default" : "pointer",
            }}
            title={t("cards.terminalCommand.runHint")}
          >
            {/* Both labels in one cell, the other one hidden, so the button
                keeps its width when Run turns into Running…. */}
            <span style={{ display: "inline-grid" }}>
              <span style={runLabel(!running)} aria-hidden={running}>
                {t("cards.terminalCommand.run")}
              </span>
              <span style={runLabel(running)} aria-hidden={!running}>
                {t("cards.terminalCommand.running")}
              </span>
            </span>
          </button>
        )}
        <button
          data-panel-action=""
          onClick={() => onCopy(payload.command)}
          style={{
            ...button,
            // Beside Run, Copy to terminal is the second choice.
            ...(onRun
              ? {
                  border: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-primary)",
                }
              : green),
          }}
          title={t("cards.terminalCommand.copyHint")}
        >
          {t("cards.terminalCommand.copy")}
        </button>
      </div>
      {run && run.state !== "running" && (
        <AskRunResult run={run} isMobile={isMobile} />
      )}
      {runError && (
        <div
          data-ask-run-error=""
          role="alert"
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 12px",
            fontSize: isMobile ? 13 : 12,
            color: "var(--red-text)",
          }}
        >
          {runError}
        </div>
      )}
    </div>
  );
}
