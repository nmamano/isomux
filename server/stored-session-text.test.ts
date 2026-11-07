// Stored topics and summaries that hold a provider notice (task c2841546).
// Before task b9de1554 a Claude one-shot that ended on an API error returned
// the CLI's notice as its answer, and it was stored as the session's topic or
// summary. Every read of a stored value treats a notice as absent; a label
// ABOUT a limit or a sign-in stays.
//
// The notice texts are the Claude CLI's (Claude Code 2.1.293, bundled with SDK
// 0.3.293, read 2026-11-07) and the forms stored in this office's sessions.

import { describe, expect, it } from "bun:test";
import {
  isProviderNotice,
  storedSummary,
  storedTopic,
} from "./stored-session-text.ts";

const NOTICES = [
  // Limits.
  "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Berlin)",
  "You've hit your session limit · resets 3pm (UTC)",
  "You’ve hit your session limit · resets 11am (America/Los_Angeles)",
  "You've hit your limit · resets 5:20pm (America/Los_Angeles)",
  "You've hit your team's shared budget. Switch to another model",
  "You've hit your monthly spend limit.",
  "You've reached your Fable limit.",
  "Claude AI usage limit reached|1762531200",
  "You're out of usage credits. Switch to another model",
  "You're out of extra usage",
  "Your org is out of usage · add funds to continue",
  "Fable 5 requires usage credits",
  // Sign-in.
  "Not logged in · Please run /login",
  "OAuth token revoked · Please run /login",
  "Login expired · Please run /login",
  "Invalid API key · Please run /login",
  "API Error: 401 Invalid API key · Please run /login",
  'Please run /login · API Error: 403 {"type":"error","error":{"type":"permission_error"}}',
  "Failed to authenticate: OAuth session expired and could not be refreshed",
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authe',
  "Authentication required · Sign in again to continue",
  // API.
  "Credit balance is too low",
  "Credit balance too low · Add funds: https://console.anthropic.com",
  "API Error: 500 Internal server error. This is a server-side issue, usually tempo",
  "API Error: Connection error. This is a server-side issue, usually temporary",
  "API Error: Overloaded. The API is at capacity — this is usually temporary",
];

// Real topics from this office's sessions, and labels that quote or name a
// notice without being one.
const LABELS = [
  "Usage limit reset time shows server timezone",
  "Error-surface follow-ups from lane-3 review",
  "Provider fallback to office-wide sign-in on usage limit",
  "Fix lifecycle ENE authentication under Bun",
  "Failed authentication retry loop",
  "OpenCode refusal misreported as authentication not configured",
  "Fix the 'Not logged in · Please run /login' banner on resume",
  "Why the weekly limit notice says You've hit your weekly limit",
  "API Error handling for 503 retries",
  "Please run the login flow on the new box",
];

describe("isProviderNotice", () => {
  it("matches every notice form, after trimming", () => {
    const missed = NOTICES.filter((text) => !isProviderNotice(text));
    expect(missed).toEqual([]);
    const padded = NOTICES.filter((text) => !isProviderNotice(`  ${text}\n`));
    expect(padded).toEqual([]);
  });

  it("does not match a label about a limit, a sign-in or an API error", () => {
    expect(LABELS.filter(isProviderNotice)).toEqual([]);
  });
});

describe("storedTopic and storedSummary", () => {
  it("read a notice as absent", () => {
    expect(NOTICES.map(storedTopic).filter((t) => t !== null)).toEqual([]);
    expect(NOTICES.map(storedSummary).filter((s) => s !== null)).toEqual([]);
  });

  it("keep a real topic or paragraph as stored", () => {
    expect(LABELS.map(storedTopic)).toEqual(LABELS);
    expect(LABELS.map(storedSummary)).toEqual(LABELS);
  });

  it("read a placeholder, a blank or a value of the wrong type as absent", () => {
    expect(
      [null, undefined, "", "   ", "..."].map((t) => storedTopic(t)),
    ).toEqual([null, null, null, null, null]);
    expect(
      [null, undefined, "", "  \n", 42, { text: "x" }].map((s) =>
        storedSummary(s),
      ),
    ).toEqual([null, null, null, null, null, null]);
  });
});
