// The details of a command job's run (task ab6851f2): the command, how it
// ended and its output. A run with no output messaged nobody.

import type { CronjobCommandResult } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";

const labelStyle = {
  fontSize: 10,
  color: "var(--text-muted)",
  margin: "10px 0 4px",
} as const;

const codeStyle = {
  margin: 0,
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--bg-base)",
  border: "1px solid var(--border-subtle)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 320,
  overflowY: "auto",
} as const;

export function CommandRunDetails({
  command,
  result,
}: {
  command: string;
  // Absent while the command runs, and when it could not start.
  result: CronjobCommandResult | undefined;
}) {
  const { t } = useI18n();
  const hasOutput = !!result && result.output.trim() !== "";
  return (
    <>
      <div style={labelStyle}>{t("schedules.commandLabel")}</div>
      <pre {...noTranslate()} style={codeStyle}>
        {command}
      </pre>
      {result && (
        <div style={{ marginTop: 8, fontSize: 11 }} data-command-exit>
          {result.timedOut
            ? t("schedules.commandTimedOut")
            : result.signal !== null
              ? t("schedules.commandSignal", { signal: result.signal })
              : t("schedules.commandExit", {
                  code: String(result.exitCode ?? ""),
                })}
          {result.exitCode === 0 && !hasOutput && (
            <span style={{ color: "var(--text-ghost)" }}>
              {" · "}
              {t("schedules.commandQuiet")}
            </span>
          )}
        </div>
      )}
      {hasOutput && (
        <>
          <div style={labelStyle}>{t("schedules.outputLabel")}</div>
          <pre {...noTranslate()} style={codeStyle} data-command-output>
            {result.output}
          </pre>
        </>
      )}
    </>
  );
}
