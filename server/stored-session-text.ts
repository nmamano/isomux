// A session's topic and summary as read from disk (sessions.json, agents.json,
// agent-history.json). Every read of a stored topic or summary goes through
// here, so a value that is not a label reads as absent and the normal triggers
// write a new one.
//
// LEAF MODULE: log-search.ts reads these too and imports no persistence code.

// Before task b9de1554, a Claude one-shot that ended on an API error returned
// the CLI's notice as its answer, and it was stored as the topic or the
// summary. The shapes, from the Claude Code 2.1.293 binary bundled with SDK
// 0.3.293 (read 2026-11-07):
// - limits: the CLI's own prefix list ("You've hit your", "You've reached
//   your", "You're out of usage credits", "Your org is out of usage · ...",
//   "<model> requires usage credits.", ...), "Claude AI usage limit reached"
//   from older CLIs;
// - sign-in: "<problem> · Please run /login", "Please run /login · API Error:
//   ...", "Failed to authenticate. ..." or "Failed to authenticate: ...",
//   "Authentication required · Sign in again to continue", "Invalid API key ·
//   ...", "Invalid auth token · ...";
// - API: "Credit balance is too low", "API Error: <status> ...".
// Each rule is anchored at the start or the end, so a label about a limit
// ("Usage limit reset time shows server timezone") or one that quotes a notice
// stays.
// The usage-limit notices: a limit that resets or usage that runs out. A
// plan or seat with no usage at all is not one.
const USAGE_LIMIT_NOTICES: readonly RegExp[] = [
  /^You['’]ve (?:hit|reached) your /,
  /^You['’]re out of (?:usage credits|extra usage)\b/,
  /^Your org is out of usage ·/,
  /^Claude AI usage limit reached\b/,
];

const PROVIDER_NOTICES: readonly RegExp[] = [
  ...USAGE_LIMIT_NOTICES,
  /^Your seat type doesn['’]t include (?:usage|extra usage)\b/,
  /^Your usage allocation has been disabled by your admin\b/,
  /^Your group['’]s usage limit is set to \$0\b/,
  /^(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\n]{1,40})? requires usage credits\b/,
  /· Please run \/login$/,
  /^Please run \/login ·/,
  /^Failed to authenticate[.:]/,
  /^Authentication required · Sign in again\b/,
  /^Invalid (?:API key|auth token) ·/,
  /^Your ANTHROPIC_API_KEY belongs to a disabled organization ·/,
  /^Your organization has disabled API key authentication ·/,
  /^Credit balance (?:is )?too low\b/,
  /^API Error: \d{3}\b/,
  /^API Error: .*\b(?:server-side issue|at capacity)\b/,
];

// A one-shot's answer that is a usage-limit notice
// (server/backends/claude.ts oneShotResultText).
export function isUsageLimitNotice(text: string): boolean {
  const trimmed = text.trim();
  return USAGE_LIMIT_NOTICES.some((rule) => rule.test(trimmed));
}

export function isProviderNotice(text: string): boolean {
  const trimmed = text.trim();
  return PROVIDER_NOTICES.some((rule) => rule.test(trimmed));
}

// A topic read from disk. Servers before task 1b8084fd saved "..." while a
// generation ran and accepted a blank topic; both mean no topic.
// A provider notice means no topic too.
export function storedTopic(topic: string | null | undefined): string | null {
  if (!topic || topic.trim() === "" || topic === "...") return null;
  if (isProviderNotice(topic)) return null;
  return topic;
}

// A summary read from disk: null when it is not a string, blank, or a
// provider notice.
export function storedSummary(summary: unknown): string | null {
  if (typeof summary !== "string" || summary.trim() === "") return null;
  if (isProviderNotice(summary)) return null;
  return summary;
}
