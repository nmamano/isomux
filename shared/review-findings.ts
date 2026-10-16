// Claude Code's /code-review prints its findings as local command output: one
// ```json fence around the ReportFindings array. Isomux stores that output as a
// system entry unchanged, so the chat parses it at render time, which covers a
// live entry, a reload and logs written before this parser.

export interface ReviewFinding {
  file?: string;
  line?: number | string;
  summary?: string;
  shortSummary?: string;
  failureScenario?: string;
  verdict?: string;
  category?: string;
  outcome?: string;
  /** Every field this parser does not know, or a known one with an
   *  unexpected type, as [key, text]. Shown as text, never dropped. */
  extras: [string, string][];
}

const FENCE = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/;

const STRING_FIELDS = {
  file: "file",
  summary: "summary",
  short_summary: "shortSummary",
  failure_scenario: "failureScenario",
  verdict: "verdict",
  category: "category",
  outcome: "outcome",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The findings in a /code-review output, or null when the content is not
 *  exactly one fenced JSON array of findings. An empty array is zero findings. */
export function parseReviewFindings(content: string): ReviewFinding[] | null {
  const trimmed = content.trim();
  // Cheap pre-check: this runs on every system entry the chat draws.
  if (!trimmed.startsWith("```")) return null;
  const fence = FENCE.exec(trimmed);
  if (!fence) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isPlainObject)) return null;
  if (
    !parsed.every(
      (item) =>
        typeof item.summary === "string" ||
        typeof item.short_summary === "string",
    )
  )
    return null;
  return parsed.map((item) => {
    const finding: ReviewFinding = { extras: [] };
    for (const [key, value] of Object.entries(item)) {
      const field = STRING_FIELDS[key as keyof typeof STRING_FIELDS];
      if (field && typeof value === "string") {
        finding[field] = value;
      } else if (
        key === "line" &&
        (typeof value === "number" || typeof value === "string")
      ) {
        finding.line = value;
      } else {
        finding.extras.push([key, asText(value)]);
      }
    }
    // A line shows as file:line; without a file it is only a field.
    if (finding.file === undefined && finding.line !== undefined) {
      finding.extras.push(["line", String(finding.line)]);
      delete finding.line;
    }
    return finding;
  });
}
