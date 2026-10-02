# Member usage cap

Task 6de8f530. Design approved by Isomux PM on 2026-10-02. Source base `cd3be963`, checked 2026-10-02.

Nil's rulings (2026-10-02): the cap follows the weekly limit of the owner's
subscription as a moving limit tied to the position in the week. The cap is
hard. The check runs at the start of a turn; a running turn may complete. A
heads-up before the cap is a follow-up, not in this lane.

Isomux PM rulings (2026-10-02): a reading at most 60 s old admits; an older
one triggers one probe shared by concurrent admissions. A failed, invalid or
missing reading denies, with no fallback to an older reading. Exempt only
billing positively identified as having no such weekly limit.

## 1. The moving limit

A member turn may start only while the office account's weekly utilization is
below the elapsed fraction of the weekly window (the pace line):

```
elapsed = 1 - (resetsAt - now) / 7 days
allowed = usedPercent < 100 * elapsed
```

With 10% of the week left, members stop at 90%. Owners are never stopped.

Only the account-wide weekly window counts: Claude `seven_day`, and the Codex
window with `windowDurationMins === 10080` (on a Pro plan this is `primary`,
not `secondary`: probe on 2026-10-02). The 5-hour and per-model weekly windows
do not count: they are not "the weekly limit", and a member on Sonnet must not
stop because the Opus window is full.

Early in the week the line is low. Claude reports whole percents, so after 1%
of use a member waits until 1% of the week (about 1.7 h) has passed.

Owner setting: one switch, **off by default**. The task asks for a cap the
owner *can* set, and an update must not stop members in existing offices
mid-week. No reserve setting: the pace line is the ruling's example.

### Limits

The design bounds member use; it does not guarantee the owner a reserved
balance. Use can pass the pace line through:

- turns already running when the line is crossed (Nil's ruling);
- the 60 s reuse window: turns admitted on a reading up to 60 s old;
- provider reporting lag: the provider's own figure can trail real use;
- Claude background-task wake turns (section 4), which start without isomux;
- delegation: a member who has an owner's agent pass work on through agent
  messages is not capped (section 3b).

## 2. Where the reading comes from

The per-agent reading behind `GET /api/agents/<id>/subscription` is not
enough: it exists only while an agent on the office account has a live
session, and it does not say which account it belongs to.

New module `server/office-usage.ts`: one reader per provider for the office
sign-in (`ProviderAccountManager` office target: its `dir` and `env`).

- Claude: a standalone SDK query with no prompt, then
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`. Probe on
  2026-10-02 (scratch scripts, not in the tree): `seven_day {utilization: 12,
  resets_at}` with no conversation; first call about 4 s, next calls on the
  same query 1.3-1.8 s.
- Codex: a standalone app-server, `initialize`, `account/read`, then
  `account/rateLimits/read`. Probe on 2026-10-02: the 10080-minute window in
  about 4 s cold.

The reader process stays warm while admissions arrive and closes after 10
minutes with no admission, so an idle office keeps no process.

**Freshness (PM ruling):** a committed reading admits for 60 s from its
observation time. An admission with no such reading starts a probe, or joins
the one in flight. A probe that fails, times out (20 s) or returns an invalid
reading **denies**. No older reading is used after a failure.

**Validity.** A reading admits only if all hold, else it denies:

- the weekly window is present;
- `usedPercent` is a finite number in [0, 100] (not clamped: an out-of-range
  value is invalid);
- `resetsAt` is present, finite, after `now`, and at most 7 days plus 1 hour
  after `now`. A reset in the past means the reading predates a rollover: the
  next admission probes again, and a fresh probe that still reports a past
  reset is invalid.

**Positive exemption (members run with no cap).** Only:

- the turn does not bill the office sign-in (section 3);
- Claude office reading with `rate_limits_available: false` (the provider's
  own statement that the account has no plan limits: API key, Bedrock,
  Vertex);
- Codex office `account/read` reports `type: "apiKey"` or `"amazonBedrock"`.

Everything else without a valid weekly window denies: SDK method gone, an
unparseable answer, a ChatGPT plan with no 10080-minute window, a missing
`resetsAt`.

**Invalidation.** The reader's key is the office account directory plus a hash
of the env the reader runs with, so a changed office variable (an API key, a
cloud switch) is a different account even in the same directory. Office
sign-in, sign-out and a write of the office variables (`PUT /api/office/env`)
also bump a generation in the reader and in the cap's recent answers. An
answer counts only if its key and generation still hold when it arrives: a
probe that an invalidation overtook is neither cached nor returned, and its
caller reads again. The cap's admission does the same with its own
generation, because the reader can hand back a cached answer before an
invalidation runs; three overtaken reads refuse. A change closes the warm reader. A reader process that
cannot start reads as failed, so the owner's settings still load.

**App daily budget.** An app message now awaits the cap before delivery, so the
handler holds one of the app's daily slots across the await; acceptance spends
it and a refusal releases it.

OpenCode: outside the cap. The office sign-in (`ProviderAccountProvider`)
covers Claude and Codex only, and OpenCode reports no allowance.

## 3. Who is capped

A turn is capped when both hold.

**(a) It bills the office sign-in.** The account is the one the live session
runs with, not the current configuration:

- Agents: at every `createSession`/`resumeSession`, agent-manager records
  `managed.billingDir = { provider, dir }` from the env it actually passes.
  Claude: the session's pinned `claudeConfigDir` (already persisted per
  session). Codex: the resolved `CODEX_HOME` of that env. A session
  replacement records it again.
- Cron runs: the same, on the run's session.
- At admission, `billingDir.dir === office target dir` for that provider means
  office-billed. Any other directory is a personal connection and is not
  capped. An override variable (`ANTHROPIC_API_KEY` and similar) in a member's
  own env with the office directory is **not** proof of other billing: the
  turn counts as office-billed. A member with their own credential uses a
  personal connection.

**(b) A member drives it** (PM ruling, 2026-10-02). Decided per input:

- Input sent directly by a human (chat, API token, edit-fork, skill, choice
  reply): capped when that human is not an owner. An owner's direct input is
  never capped, also to a member's agent.
- Input no human sent directly (agent message, scheduled message, handoff, app
  message, wake, cron-run message to an agent): capped when the receiving
  agent's manager (`info.userId`) has role `member`. An agent with no manager
  is not capped.
- A cron run: capped when the cronjob's owner (`job.userId`) has role
  `member`.

The human sender is the identity the server already records:
`QueuedMessage.sender = {kind: "user", username}` and the `username` that
`sendMessage`, `editMessage` and `executeSkill` receive (resolved by
`attributionFor` from the authenticated identity, never from message text). No
new field. Roles are read at admission, so a promotion takes effect at once. A
username that no longer resolves (a rename while the item was queued) counts
as a member: the cap fails closed.

## 4. Every path that starts a turn, and where the check sits

One gate: `admitMemberTurn(billingDir) -> admitted | exempt |
refused{reason, retryAtMs}`, called only for inputs that section 3b caps.

**Sequence at every gate:** claim, then capture the identity, then await the
gate, then recheck the captured identity against the current one, then
proceed. The capture happens before the first await, so a Stop, session swap
or replacement run during the probe fails the recheck. Checking only that
*some* session or run is active is not enough. A failed recheck abandons the
admission the way that path abandons a cancelled send today (agents:
`SessionSwappedError`, queue items kept).

**Agents.** Turns reach the backend through `runAgentTurn` from four callers.
The captured identity is `managed.sessionManager.turnCancelToken`, the session
object and its `billingDir`.

- `flushQueue` (all queued delivery: agent, scheduled, cron-run, app, handoff,
  wake, resume, boot replay, send-now, steer by abort). Claim:
  `flushInProgress` set and the batch taken. Capture, await the gate, recheck.
  If refused, it removes only the member-driven items, writes one error entry,
  and sends the rest as the batch; if none remain, no turn starts. Removed
  items are drained, not kept: kept items with an idle state re-fire the
  `finally` re-flush in a loop. No await between the recheck and the call to
  `runAgentTurn`, which captures its own token synchronously at entry.
- `sendMessage` (chat, API tokens, native slash commands, choice replies),
  `editMessage` (edit-fork), `executeSkill`: the gate runs inside
  `runAgentTurn`. Claim: `beginTurn`. Capture: the existing
  `cancelTokenAtEntry` (`server/agent-turn.ts:80`, before the first await)
  plus the session and its `billingDir`. Await the gate, then the existing
  `checkCancelled()` plus a session-identity check. A refusal writes the error
  entry and returns the agent to idle.

**Early refusal for non-user senders.** `enqueueMessage` gates the incoming
item only (the receiver's manager and `billingDir`), never the items already
queued. For a dormant receiver, `billingDir` is its last launch's (its next
session resumes on the same root). A refused item returns `{ok:false,
status:429, code:"usage_cap", retryAtMs}` and is not queued, so the sending
agent learns in its HTTP reply. `enqueueMessage` is synchronous, so it answers
from the cap's last admission for that account (`peek`, at most 60 s old). The
agent, cron-run and app send paths first await one (`prepareEnqueue`). The
scheduled-message tick cannot await: with no recent admission it starts a read
and gets a retryable 429, and the tick (every 30 s, for up to 24 h) tries
again. Handoff gates before the session reset, so a refused handoff does not
wipe the session. Turn start stays the authoritative check.

**Cron** (own sessions, no `runAgentTurn`):

- `fire()` (scheduled tick and run-now): claim: the active run, registered
  synchronously as today (`createSession` is synchronous too and starts no
  turn). The gate runs in the async step before `session.send(job.prompt)`;
  after its await, the same active-run object must still hold the slot and not
  be killed. A refusal writes the run error entry, closes the session and ends
  the run `failed` with the refusal text as `errorReason`.
- `sendRunMessage`, `editRunMessage`: input a human sends directly, so the
  human's role decides. Claim: `startingRuns`. The gate runs before the resume
  or fork; the run's leaf session is captured before the await and must be
  unchanged after it, else the turn is abandoned. Refusal as a run error entry
  (an edit keeps its text recoverable).

**Not checked:** Claude background-task wake turns (the SDK starts them inside
a running session without isomux), tool-boundary steers (they join a running
turn), topic generation (`oneShotPrompt`, not a turn).

## 5. What a capped member sees

Chat error entry and the HTTP `error` text (English source; es/ca/zh in the
same change). Pace refusal:

> Member turns are paused: this week's office usage is ahead of the week's pace. They resume {when}.

`{when}` is relative ("in 3 hours", Intl in the reader's language): the server
writes the entry and does not know the reader's time zone. The moment is when
the pace line reaches the current use: `resetsAt - 7 days + usedPercent/100 *
7 days`. Owner use can move it later. The 429 body carries it as `retryAtMs`.

Read failure (fail closed):

> Member turns are paused: Isomux could not read the office owner's weekly usage. Try again in a minute.

`retryAtMs` is now + 60 s.

The cap lifts with no action: the next admission that passes runs. Refused
work is not replayed.

## 6. Settings and prompt

Office pane (Settings → Office; route `office:admin` with `officeOwner`, user
scope, so human-only). The switch is `memberUsageCap` in `office-config.json`
beside `OfficeSettings` (absent reads as false), part of the settings version
hash, and an optional field on the settings GET and PUT (omitted on PUT
preserves it). The UI shows and sends it only when the GET carries it.

- Switch label: **Pace member usage**
- Hint: **Members' turns on the office sign-in stop while this week's usage is ahead of the week's elapsed time.**
- Status, one line per provider with an office sign-in, from a new read-only
  field on `GET /api/office/settings` (owner-only like the route), read only
  while the switch is on. Three states:
  - **{Provider}: {used}% used, {pace}% of the week elapsed.**
  - **{Provider}: no weekly limit on the office sign-in. Members are not capped.**
  - **{Provider}: weekly usage could not be read. Members are stopped.**

Agent-facing prompt: none. The 429 body names the cause and the retry time.

Doc surfaces: one bullet in `docs/features.md` (Multiple members) and the same
bullet in the chatbot feature list (`api/chat.ts`).

## PM rulings on the open points (2026-10-02)

1. Off by default.
2. No transitive origin propagation; the per-input rule in section 3b. Reason:
   the cap is a pacing aid between people who share an office, and the
   transitive version adds persisted state to every queue and scheduled item
   for a gap that needs deliberate effort to use.
3. 429 `usage_cap` with `retryAtMs`, and the owner-only status field on
   `GET /api/office/settings`: yes.
4. Refused queued items are drained with one error entry.
5. A member's own credential variable on the office directory counts as
   office-billed.
