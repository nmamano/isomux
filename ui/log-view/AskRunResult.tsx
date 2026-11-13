// How a Run of an ask's command went (task c3b91695): a status line and the
// output's tail, under the command on the ask card and in the result that
// stays after the ask closed.
import type { AskCommandRun } from "../../shared/types.ts";
import { runSucceeded } from "../../shared/runnable-command.ts";
import { useI18n } from "../i18n.tsx";

function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const min = Math.floor(seconds / 60);
  return `${min}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

export function AskRunResult({
  run,
  isMobile,
}: {
  run: AskCommandRun;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const ok = runSucceeded(run);
  const status =
    run.state === "running"
      ? t("cards.terminalCommand.running")
      : run.state === "lost"
        ? t("cards.terminalCommand.lost")
        : run.timedOut
          ? t("cards.terminalCommand.timedOut")
          : run.exitCode !== null && run.exitCode !== undefined
            ? t("cards.terminalCommand.exited", {
                code: String(run.exitCode),
                duration: duration(run.durationMs ?? 0),
              })
            : t("cards.terminalCommand.killed", {
                signal: run.signal ?? "?",
              });
  return (
    <div
      data-ask-run-result=""
      data-state={run.state}
      style={{ borderTop: "1px solid var(--border)", padding: "8px 12px" }}
    >
      <div
        style={{
          fontSize: isMobile ? 13 : 12,
          fontFamily: "var(--font-ui)",
          color:
            run.state === "running"
              ? "var(--text-muted)"
              : ok
                ? "var(--green-text)"
                : "var(--red-text)",
        }}
      >
        {status}
      </div>
      {run.state === "done" && (
        <pre
          style={{
            margin: "6px 0 0",
            maxHeight: 240,
            overflow: "auto",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {run.output || t("cards.tool.noOutput")}
        </pre>
      )}
    </div>
  );
}
