// Secret-shaped strings: provider key prefixes and KEY=value assignments.
// The server masks them in logs (server/log-redaction.ts) and recording mode
// hides them on screen (shared/recording-redact.ts).
//
// Generic assignment names ignore case; provider prefixes remain case-sensitive.
// A single pass means one match cannot
// consume the replacement of another overlapping match.
export const SECRET_PATTERN =
  /sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-api03-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|m0-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|AKIA[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9+/=]{20,}|(?i:(api[_-]?key|secret|token|password)\s*[=:]\s*['"]?)([A-Za-z0-9_\-+/.=]{16,})/g;
