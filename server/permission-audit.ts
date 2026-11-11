import { redactTokens } from "./identity/tokens.ts";

const SUMMARY_LIMIT = 240;

function redactCredentialShapes(value: string): string {
  return redactTokens(value)
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s'"]+/giu, "$1 [REDACTED]")
    .replace(
      /\b([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/gu,
      "$1=[REDACTED]",
    )
    .replace(
      /(--(?:api[-_]?key|token|password|secret))(?:=|\s+)[^\s'"]+/giu,
      "$1 [REDACTED]",
    )
    .replace(
      /([?&](?:api[-_]?key|token|password|secret)=)[^&#\s'"]+/giu,
      "$1[REDACTED]",
    );
}

function bounded(value: string): string {
  const redacted = redactCredentialShapes(value);
  if (redacted.length <= SUMMARY_LIMIT) return redacted;
  return `${redacted.slice(0, SUMMARY_LIMIT - 1)}…`;
}

export function permissionInputSummary(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, string> {
  if (toolName.toLowerCase() === "bash" && typeof input.command === "string") {
    return { command: bounded(input.command) };
  }
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined;
  return filePath === undefined ? {} : { file_path: bounded(filePath) };
}

/**
 * The tool input a permission card shows (AgentChoiceInteraction.permission,
 * task ddf02829): the audit summary, else an OpenCode permission's patterns
 * (its only input), one per line, bounded and redacted as the summary is.
 */
export function permissionCardInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, string> {
  const summary = permissionInputSummary(toolName, input);
  if (Object.keys(summary).length > 0) return summary;
  const patterns = Array.isArray(input.patterns)
    ? input.patterns.filter(
        (value): value is string => typeof value === "string" && value !== "",
      )
    : [];
  return patterns.length > 0 ? { patterns: bounded(patterns.join("\n")) } : {};
}
