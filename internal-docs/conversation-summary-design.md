# Conversation summaries

Status: implemented (task ac41c60e). Nil chose no backfill (2026-10-20).

Code: server/session-summary.ts (the prompt, the chunks and the write loop, behind injected seams), its wiring in server/agent-manager.ts (sessionSummarizer, countSummaryEntry, maybeRollSummary, summarizeEndedSession), persistSessionSummary in server/persistence.ts, and summaryHits and the index pages in server/log-search.ts.

## Goal

Each conversation (session) gets a paragraph that names its threads, so that agents find the right conversation in the logs. Today a session has only a topic of at most 8 words, built from user messages only. A topic cannot hold the many threads of a long session. Automatic handoff (internal-docs/auto-handoff-design.md) can use the paragraphs later, for a digest of past sessions next to the brief.

## What is stored

sessions.json gets three optional fields per session:

- `summary`: the paragraph, or absent.
- `summaryThroughEntryId`: the id of the last log entry the paragraph covers.
- `summaryAt`: epoch ms of the last write.

Old sessions.json files stay valid. A session without `summary` is a session that never got one.

A summary write does not change `lastModified`. The resume picker (listAgentSessions) and the logs index sort on `lastModified`, so a session-end write or a backfill write that set it would move old sessions to the top. This is the difference from persistSessionTopic, which sets `lastModified`.

A write that finishes after the agent's log directory is gone (agent deleted, storage pruned) is dropped. saveSessionsMap creates the directory, so without this check a late write would make a sessions.json for a deleted agent.

## How a paragraph is written

One one-shot call per write, through `backend.oneShotPrompt`, with the same model choice, sign-in check and `topicGen` capability gate as the topic (`generateTopic` in server/agent-manager.ts). OpenCode follows the topic's routing rule (task 6c517c76). The failure backoff uses the same policy as the topic (10 min, doubling to 24 h, per model) but its own state: a summary call has much more input and times out more often, and a shared state would let one summary timeout stop topics for up to 24 h.

Entry source: the session's own JSONL file only (persistence.loadLog), never the in-memory log cache. After a fork the cache also holds the parent's entries (loadLogWithAncestors), so a count or a marker taken from it could point into the parent's file. Search scans the same branch-local entries, so the paragraph describes what search finds. A fork does not copy the parent's paragraph; the 4 and 40 counts below are branch-local too.

Entry kinds: `TIERS.conversation` in server/log-search.ts (user messages, assistant text, outbound API-token messages). The summary code uses that constant, not a second list. Assistant text is included: a paragraph describes what the agent did, not only what the user asked. The topic's labeller trap (a label anchored to text the agent quoted) matters less for a paragraph that names several threads.

Input: the previous paragraph (empty on the first write) and the conversation entries after `summaryThroughEntryId`. Each entry is capped at 2,000 characters (head and tail kept). When the marker is not in the file (an edit trimmed it, or the file is damaged), every entry counts as new and the previous paragraph is kept as input.

Chunks: one write takes at most 150,000 characters of entries. A longer backlog is written in chunks, oldest first; each chunk is a normal write that moves the marker. Rolling writes every 40 entries stay under the cap (40 x 2,000 = 80,000), so chunks occur only for a long session without a paragraph: an old session that is resumed, or a backfill. No entries are dropped, and the prompt has one form.

The input comes from log entries, which the log redaction scanner already processed (internal-docs/log-secret-redaction.md). The output goes through the same scanner before it is stored.

Prompt (system): a summarizing tool that is not the agent and does not do its work, the same framing as the topic. Prompt (user): one paragraph that keeps the earlier threads of the previous paragraph and adds the new ones; for each thread, what was asked, what was done or decided, what was left open; keep the exact identifiers a search uses (task ids, file paths, agent and member names, commands, error messages, commit hashes); no preamble, no markdown. The stored text is capped at 2,000 characters.

Measured 2026-10-19 with `claude -p --model sonnet` on three real sessions of this office: a 16-entry session (15 KB of conversation text), a 28-entry session (20 KB) and a 264-entry session (163 KB) each gave a good paragraph in one call. Sonnet does not keep a word limit when the session is dense (about 170, 200 and 330 words for a 120-word request), so the cap is on characters, and the prompt asks for density, not a word count. Sample output for the 28-entry session:

> This conversation tracks Isomux task d21b87e3 (the governance-suite CI floor, worker agent on /isomux-loop-worker) across two rounds plus a new dispatch. Round 1: worker measured governance-apply and governance-converge tests slowing each other via a shared-lock on the isomux Postgres role (91s/88s together vs 25s/59s alone), designed a fix (per-case owner roles via new control-plane/testing/case-owner.ts, plus a matrixSql() rewrite in control-plane/roles.ts:1128 ...), landed commit 874ed38 ... Main's CI failed twice on squash 3b60d0ec (afterAll timeout in governance-converge.test.ts) ... Reviewer 2 agreed conditioned on naming a shared constant PG_DROP_DATABASE_HOOK_TIMEOUT_MS in testing/pg.ts ... Left open: no per-file timing from the final merged CI run ... A new task then arrives: 97015f98, "[go | ready] Hosted sign-in without Google," not yet started.

## When a paragraph is written

Two triggers. Both are fire-and-forget and never delay a turn.

1. Rolling: when a turn ends and 40 or more conversation entries were written to the current session since the last rolling trigger. The count is an in-memory hint per session (`summaryPending`, counted in addLogEntry): it starts at 0 after a restart or a resume, and the entries written before a fresh session has its id are not counted. The write itself reads the session's file. This gives long-lived sessions a paragraph while they are still current, which is where agents search most.
2. Session end: when a session stops being current (new conversation, `/handoff`, automatic handoff, resume of another session, fork by edit) and it has new conversation entries after `summaryThroughEntryId`. The call reads the session from disk, because the reset clears the in-memory log cache.

A session with fewer than 4 conversation entries gets no paragraph: its topic and first message say enough.

A write for a session that is no longer current still stores its result: unlike the topic, the paragraph belongs to the session, not to the agent. Two writes for the same session never run at the same time; a trigger that arrives during a write runs once after it.

No backfill (Nil, 2026-10-20): a session that ended before this shipped keeps only its topic, which search matches. A resumed old session gets its paragraph at its next write.

Steady-state cost, measured 2026-10-19 over the 24 h before 12:18 UTC on this office (65 agents): 1,356 conversation entries in 24 sessions, 10 new sessions. That is about 34 rolling writes and 10 to 24 session-end writes, so about 45 to 60 calls per day. The mean entry is 543 characters after the 2,000 cap, so a rolling call has about 22,000 characters of entries plus the previous paragraph (about 6,000 tokens). All calls together read about 0.9 million characters per day (about 230,000 tokens), on Sonnet for Claude agents. Method: the logs API, entries with a timestamp in the window, each capped at 2,000 characters. Retrieval stops at 1,000 entries per session, so a longer session is undercounted and the numbers are a lower bound.

## How agents read it

All on the existing conversation-history routes, so the agent reference page `conversation-history` is the only doc an agent needs:

- `GET /api/agents/:id/logs` (index): each session carries `summary`. An agent with 150 sessions then gets about 200 KB, so the index gets an optional `limit` (1 to 1,000) with a `before=<lastModified>` cursor, newest first. `before` keeps sessions strictly older, so the last listed session's lastModified is the next page's cursor with no repeat; without `limit` it lists every older session. `truncated` says whether `limit` left sessions out. Without `limit` the index returns every session, as today.
- `GET /api/agents/:id/logs?q=...` (search): the query also matches each session's paragraph and topic. Today search does not match topics at all, so matching them makes old sessions without a paragraph findable at no model cost. Those hits come back in a new `summaryHits` array (`sessionId`, `topic`, `lastModified`, `snippet`), separate from the entry hits, because a paragraph is not a log entry and has no entry id or kind. Parameters for `summaryHits`: `q` and `regex` apply; `session=` narrows to one session; `limit` caps it separately with the same value; `before` and `after` filter on the session's `lastModified`; `kind` and `tier` do not apply.
- `GET /api/agents/:id/logs?session=...` (retrieve): the response carries the session's `summary`.
- `GET /api/agents/:id/sessions`: `SessionInfo` carries `summary`.

## Left out

- UI. No screen shows the paragraph in this task. The resume picker is the natural place; that is a follow-up if Nil wants one.
- Office-wide search across all agents' paragraphs. Today a search names one agent. A route that searches every reachable agent's paragraphs is cheap (the paragraphs are in sessions.json) and is the next step if agents still miss conversations.
- Meaning-based search (embeddings). Search stays substring and regex.
- The digest of past sessions in the automatic-handoff fresh session (auto-handoff design, section on the fresh-session notice).
- Merging the topic into the paragraph call. Task 1b8084fd redesigns the topic; one call could return both later.
- A boot sweep for sessions whose end trigger was lost to a restart. Their paragraph stays at the last rolling write.
