# Log secret redaction

Isomux scans new log entries before storage. The scanner is always active.
It does not rewrite history or change the safety hook or system prompt.

## Entry paths

The pure scanner is in server/log-redaction.ts. The failure wrapper is
prepareLogEntry in server/persistence.ts. It returns the original entry on
failure and logs one fixed sentence with the entry id and kind, without the
exception or payload.

The wrapper memoizes successful returned objects in a WeakSet. An entry returned
by prepareLogEntry is owned by persistence and is immutable from then on,
including nested payloads. The wrapper returns its own copy even when there is
no match. Cache, event and backfill paths reuse that prepared object without a
second scan. A direct writer's input is scanned; it can change its own object
later without bypassing redaction. Failures are not memoized.

AgentManager.addLogEntry calls the wrapper before the cache and log_entry event.
CronjobManager.writeLog calls it before pendingEntries, persistence and the event;
emitRunErrorEntry covers errors without an active run. The disk writers
appendLog and appendRunLog also call the wrapper, so direct callers are covered.
appendLog uses the redacted content for the session's first-message preview.
Pre-init entries reach the same writers on backfill or failed-run finalization.

The scanner copies string values in all entry kinds, including nested arrays,
tool payloads and metadata. It preserves structural property names, undefined
and other non-string scalars. An explicit work stack and a WeakMap handle deep
and cyclic objects without recursive call-stack growth. A cyclic entry still
cannot be serialized as JSON; existing writer error handling remains in place.

## Pattern behavior and gaps

The starting provider-prefix patterns remain case-sensitive. The generic
api-key, secret, token and password assignment branch ignores case, per the
2026-09-06 ruling. One regex pass selects the leftmost match. A bare key keeps
its first eight characters plus `...REDACTED`; an assignment keeps its label
and the first eight characters of the value (Nil, 2026-09-07).

For `OPENAI_API_KEY=sk-proj-<key>`, the generic branch starts first and the result
is `OPENAI_API_KEY=sk-proj-...REDACTED`: the assignment label plus the first
eight characters of the value. A `PASSWORD=<value>` match keeps `PASSWORD=`
and eight characters of the value. These results are intentional. Placeholders such as
`api_key=YOUR_API_KEY_HERE_PLACEHOLDER` are accepted false positives. Long
`token=` URL query values also match. A bearer placeholder in a curl header,
an env name without a value, and prose about storing an api_key do not match.

The scanner checks values, not property names: a bare value under a JSON
`password` key can be missed when that value has no recognized prefix.
Unmatched secrets and original entries after scanner failures can reach disk.
Backend-owned transcripts are outside the write boundary. This is a backstop,
not a guarantee that logs are free of secrets.

## Write-path audit (2026-09-06)

The audit searched server sources for appendFile, writeFile, Bun.write,
JSON.stringify(entry), appendLog and appendRunLog, then followed the manager
callers and cache/event writes. It found two conversation JSONL writers:
server/persistence.ts:appendLog and
server/cronjob-persistence.ts:appendRunLog.

Other surfaces checked:

- Terminal scrollback: server/terminal.ts keeps ptyBuffer in memory.
  server/isomux-office.ts replays it as terminal_output. It is not a LogEntry
  transcript and this change does not scan it.
- Memory files: server/memory-store.ts writes memory text and a separate
  OpLogEntry audit. These are user-maintained memory state, not chat transcripts.
- Session usage snapshots: appendSessionUsageSnapshot and
  appendRunSessionUsageSnapshot store usage with an entry id, not entry content.
- Permission audit: AgentManager sends permission summaries through addLogEntry
  as system entries. Claude's bypass notice becomes a system_text event.
  These are covered by the normal log path.
- Attachments: persistence.ts:saveFile writes the original file bytes.
  The scanner checks attachment metadata on entries, not file contents.
- Backups: server/backup.ts runs tar on existing state. It copies logs and
  backend transcripts without transforming them; old secrets can remain.
- UI-only entries: emitEphemeralLog bypasses addLogEntry. These entries reach
  the UI but never disk and remain outside this change.
- Other durable state, including queued messages and task records, is not
  a LogEntry transcript and is outside this change.
- Backend probes write their own test artifacts, not production chat history.

The scanner is imported by persistence.ts and its Bun tests. UI/shared/API
sources do not import server/persistence.ts. The Node PTY sidecar does not import
it. The inline regex modifier runs in Bun; ESLint accepts its literal form.

## Scan measurement (2026-09-06)

Bun 1.3.11, one 1,048,576-character tool_result, ordinary output with a systemd
key assignment about every 11 KiB, 20 warmups and 100 measured scans:
median 16.47 ms, p95 22.03 ms. A repeated full-scanner run measured median
15.80 ms and p95 20.84 ms. This is a synthetic large entry on a shared server,
not a bound. Reviewer 2 accepted the cost. A regex-only comparison did not
establish the cause of the full-scanner cost; no timing experiment remains in
the implementation.
