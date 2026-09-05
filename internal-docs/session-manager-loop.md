# SessionManager extraction loop (standing orders)

Slice loop authorized by Nil 2026-09-05 (task 798922c1). Lane: Isomux Worker 1
/ Isomux Reviewer 1, worktree `session-manager` (persistent for the loop,
rebased on main at every slice start). The worker re-reads this whole file at
every slice. Delete this file at loop close.

North star: the per-agent session lifecycle in `server/agent-manager.ts`
(create, install, replace, close-and-drain, abort, the per-turn deferred, the
consumer loop) lives in one per-agent object, `SessionManager`
(`server/session-manager.ts`), whose type makes the swap/abort/resume contract
explicit, with `agent-manager.ts` calling it. Behaviour-preserving throughout:
no event, state transition, log line, timing or error type changes for any
caller, browser or backend.

The surface (as of 101414e): `createSession` (~4842), `installSession`
(~4151), `closeAndDrainSession` (~4275), `replaceSession` (~4312),
`drainConsumerBounded`, `createTurnDeferred` (~3915), `runConsumer` (~3961),
`clearLiveTurn` / `turnIsLive`, and the `ManagedAgent` fields `session`,
`sessionId`, `consumerPromise`, `pendingTurn`, `turnCancelToken`,
`abortCancelToken`, `aborting`, `abortPromise`, `lastBackendFailure`
(`server/internal-types.ts:31`), plus `SessionSwappedError` and
`TurnSupersededError`. The drain-before-install comment near
`replaceSession` is the contract to make structural.

## Rulings (final)

1. Behaviour-preserving only. A slice that needs a behaviour change to make
   the extraction clean stops and parks the change (PARKED FOR NIL) with the
   smallest workaround that keeps behaviour identical.
2. Characterization before extraction. No production line moves until the
   contract it implements is pinned by a test that fails on a named mutant.
3. Each slice leaves main shippable: full ci green, the isolated boot smoke
   green. The office server is never restarted by this loop.
4. The public shape of `createAgentManager` and the events it emits do not
   change. Test doubles keep working; `agent-manager.di.test.ts`,
   `queue-reliability.test.ts`, `agent-death-recovery.test.ts`,
   `agent-idle-eviction.di.test.ts` and `context-usage.test.ts` run at every
   slice.
5. Names: `server/session-manager.ts`, class or factory `SessionManager`
   (worker+reviewer settle class vs closure factory in slice 2; pick what
   matches `createAgentManager`'s style unless the type story is clearer the
   other way).
6. No `any`, no bare casts, no non-null assertions to close a type gap; say
   which side is wrong and fix that side.
7. R-2026-09-05-1 (kill during a swap drain; ruled on Reviewer 1's S1
   escalation). Current code: `replaceSession` installs the replacement
   whenever `managed.session === null` after the drain and only THEN
   returns on `agents.get(agentId) !== managed`; `kill()` closes the
   session, nulls it and deletes the record, so a kill that lands during
   the drain leaves the replacement session and its consumer running on
   the orphaned object. This is a defect, and fixing it is a behaviour
   change: PARKED FOR NIL, tracked on the board (orphan backend session
   after kill during a swap drain). S1 pins nothing for it (no test, no
   todo); S2-S4 preserve the current order exactly, with a comment naming
   the task where the guard sits.
8. R-2026-09-05-2: behaviours that the public surface cannot reach before
   the object exists (S1 pickup items 3 idle-residue half and 5 stale
   deferred) are S2 direct-unit obligations: S2 adds unit tests on
   `SessionManager` for them, and its acceptance lists them by name.

## Gates (every hand-off)

Every gate log starts with `git rev-parse HEAD` and is produced after the
commit under review.

    bash -c 'systemd-run --user --scope -p MemoryMax=2G bun test <touched suites> > /tmp/sm-lane.log 2>&1; echo exit=$? >> /tmp/sm-lane.log'
    bunx eslint <touched files>
    bun run build:ui        # unchanged UI, but ci runs it; keep it green
    bunx tsc --noEmit       # once, before the final hand-off of each slice

Never a bare `bun test` (it runs the whole 15-minute suite). Never prettier.
The PM runs `bun run format` and full `bun run ci` on the approved hash.

## Prohibitions

- No new behaviour, no bug fixes on the side (file them in the report).
- No `git stash`, no rebase while the reviewer holds the token.
- No edits to `server/backends/*`; the `BackendSession` interface is the
  boundary the new object talks to.
- Nothing merges from the worktree by the lane; the PM merges each slice.

## Decision protocol

Worker+reviewer settle: naming, file layout, test structure, the deps object
shape. Manager settles: anything touching rulings, slice order, gate scope.
PARKED FOR NIL: any behaviour change, any public-shape change, anything a
customer could observe.

## Slice checklist (per slice)

1. `git rebase main` in the worktree; gates green on the rebased base.
2. Plan-gate with the reviewer: list the tests to add / lines to move.
3. Implement; gates; commit; hand the token with the hash.
4. Iterate to approval; final `bunx tsc --noEmit`.
5. Report to the PM: what changed, verification, approved hash, parked items,
   what the next slice should know.

## Slice cut (sketch; each PICKUP is authored when its predecessor lands)

- S1: characterization. Inventory what the five suites in ruling 4 already
  pin about the swap/abort/resume contract; add the missing tests against
  the fake backend. No production change.
- S2: introduce `SessionManager` holding the fields and the pure operations
  (`installSession`, `closeAndDrainSession`, `replaceSession`,
  `drainConsumerBounded`, `createTurnDeferred`, `clearLiveTurn`,
  `turnIsLive`), with `runConsumer` and `createSession` still in
  agent-manager and passed in through a deps object. Every existing caller
  delegates. `ManagedAgent` keeps the fields as a view onto the object or
  loses them; decide with the reviewer, tsc is the guard.
- S3: move `runConsumer` (the consumer loop) behind the object, with the
  per-event work (`processNormalizedEvent`, state updates) injected.
- S4: move `createSession` (env, resume preflight, backend dispatch) and
  finish caller migration; remove the transitional fields; update
  `internal-docs/queue-reliability-design.md` and any doc surface in
  `internal-docs/documentation.md` that names the old layout.

## PICKUP S1 - characterization tests (Worker 1 / Reviewer 1)

Goal: a test file `server/test-support/session-lifecycle.test.ts` that pins
the current contract, so S2 can move code with a red/green signal.

Mechanics:
- Start from the DI harness the five suites use (`fake-backend`, the
  `createAgentManager` deps object). Read `queue-reliability.test.ts` and
  `agent-death-recovery.test.ts` first: much of the contract is already
  pinned there. Do not duplicate; reference the existing test by name in
  the inventory and add only what is missing.
- Behaviours to pin (each one a named test; each one shown failing against
  a named mutant in the hand-off message):
  1. `replaceSession` closes the old session, awaits the old consumer, and
     only then installs the new one; the old turn's deferred rejects with
     `SessionSwappedError` carrying the swap reason.
  2. A wake that installs a session while a swap is draining wins; the
     replacement session is closed and discarded (the warn path).
  3. `installSession` on a lazy first-message wake keeps the live turn
     (`turnIsLive`); an idle install clears residue.
  4. A clean stream end while still bound (no throw, no swap, not aborting)
     settles the turn and nulls `consumerPromise`.
  5. `createTurnDeferred` rejects a stale pending turn with
     `TurnSupersededError`.
  6. Abort during a turn: `aborting` flag, `abortPromise` awaited by the next
     send, the interrupted/failed status mapping for Codex.
  7. Kill during a drain: `replaceSession` returns without installing on
     a managed object no longer in the map.
  8. `drainConsumerBounded`'s bound: a consumer that never ends does not
     wedge the swap (use fake timers or a short bound via deps if one
     exists; if the bound is a constant, pin the behaviour with the real
     constant only if the test stays under 5 s, else record it as
     not-pinnable and why).
- Traps: the fake backend's stream shape (look at `fake-backend.test.ts`);
  `officeState.updateAgent` events (`dormant`, `sessionSwapping`) are part
  of the contract, assert them; do not assert on log text.

Acceptance: the new file runs under 10 s; every test has a mutant named in
the hand-off; the five ruling-4 suites still green; no production change
(`git diff --stat main -- server/*.ts` shows only test-support files).

Decide with reviewer: which of 1-8 are already covered; test file name.
Locked: no production code moves in S1. Rulings 7 and 8 amend this pickup: item 7 is dropped from S1, items 3 (idle half) and 5 move to S2.

- [x] S1 landed as 0f7dd80 (eight characterization tests in server/test-support/session-lifecycle.test.ts, 13 mutants red; behaviours 2 and 8 were already pinned by queue-reliability; kill-during-drain parked as task 3e8482e2).
## PICKUP S2 - the object, holding the fields and the pure operations (Worker 1 / Reviewer 1)

Goal: `server/session-manager.ts` exists, one instance per managed agent,
owning `session`, `sessionId`, `consumerPromise`, `pendingTurn`,
`turnCancelToken`, `abortCancelToken`, `aborting`, `abortPromise`,
`lastBackendFailure`, and the operations `installSession`,
`closeAndDrainSession`, `replaceSession`, `drainConsumerBounded`,
`createTurnDeferred`, `clearLiveTurn`, `turnIsLive`. `runConsumer` and
`createSession` stay in agent-manager.ts for this slice and reach the
object through a deps object. Every caller in agent-manager.ts delegates;
behaviour identical.

Mechanics and traps:
- Plan-gate first: list every read and write of the nine fields in
  agent-manager.ts (`grep -n` counts per field in the plan message) and
  the seven functions' call sites. The plan names, per site, whether it
  becomes a method call or a property read on the object.
- `ManagedAgent` (server/internal-types.ts:31): the nine fields move to
  the object. Decide with the reviewer whether `ManagedAgent` keeps
  typed getters that forward to the object during S2 (fewer edits per
  site, the compiler still guards) or every site is rewritten now.
  Either way, at the end of S2 no production code writes those fields
  on `ManagedAgent` directly; tsc is the proof (a stray write is a type
  error when the field is a getter-only view).
- The deps object carries what the operations need from the manager:
  `officeState.updateAgent` + `emit` (dormant and sessionSwapping
  events), the `agents` map lookup for the killed guard (or a
  `isStillManaged()` callback), `runConsumer`, the drain timeout seam
  `_testSetConsumerDrainTimeout` (keep it working; session-lifecycle
  restores it per lane), and the logger used by the warn path. No
  behaviour hides in the deps: the same lines, moved.
- Preserve `replaceSession`'s install-then-killed-guard order exactly,
  with a comment naming task 3e8482e2 at the guard (ruling 7).
- Class vs closure factory (ruling 5): pick the one that lets tests
  construct the object with a fake deps object in under ten lines.
- Direct unit tests, new file `server/session-manager.test.ts`, on the
  object with a fake deps object and a fake BackendSession (ruling 8,
  listed by name in the acceptance): (a) an idle install clears live-turn
  residue, mutant: drop the `clearLiveTurn` in the idle branch; (b)
  `createTurnDeferred` rejects a stale pending turn with
  `TurnSupersededError`, mutants: reject with a plain Error, and skip the
  rejection. Both files run under 5 s.
- Harness facts from S1 (Worker 1's report): `getAgent()` returns a copy
  whose queue is never mutated, use `getAllAgents()` for the live queue;
  the pre-send window exists only for Claude-typed agents; the safety
  hook rejects `git checkout --` and relative write targets in Bash, so
  restore from a byte copy with absolute paths and prove it by md5. The
  `makeLane`/`parkHumanTurn`/`wakeToIdle` helpers in
  session-lifecycle.test.ts are reusable.
- Doc: `internal-docs/queue-reliability-design.md` and any other file
  under internal-docs that names `replaceSession` or `closeAndDrainSession`
  as living in agent-manager.ts gets a one-line pointer to the new
  module (grep for the names; list the hits in the hand-off).

Acceptance: the nine fields and seven operations live in
`server/session-manager.ts`; `agent-manager.ts` shrinks by at least the
moved lines and gains no new logic; session-lifecycle plus the five
ruling-4 suites green; the two direct unit tests green with their three
mutants named red; eslint on touched files; build:ui; `bunx tsc --noEmit`
before the final hand-off; no change under `server/backends/`.

Decide with reviewer: class vs factory; forwarding getters vs full
rewrite; the deps object's exact shape.
Locked: rulings 1-8; `runConsumer` and `createSession` do not move in S2.

- [x] S2 landed as 3f9ec5a (class SessionManager<H extends SessionHost>; nine fields as getter-only views on ManagedAgent; 31 write sites and 25 call sites rerouted; agent-manager.ts 8705 -> 8481 lines; two direct unit tests; ruling-7 comment at the guard).
## PICKUP S3 - the consumer loop moves behind the object (Worker 1 / Reviewer 1)

Goal: `runConsumer` lives in `server/session-manager.ts` as a method (or a
private function the object calls), `installSession` no longer takes it
through deps, and the per-event work the loop does on manager state
reaches the manager through callbacks on the deps object. Behaviour
identical: same events, same state transitions, same log lines.

Mechanics and traps (from S2's report):
- The loop reaches into manager state the object must not own:
  `processNormalizedEvent`, `addLogEntry`, `updateState`,
  `officeState.updateAgent` + `emit`, the console, the failure text helpers
  (`humanizeBackendFailure`, `backendFailureMeta`), `diagnoseProcessExit` +
  `envForHints` (Claude only), `detectAgentAuthError` +
  `emitDetectedAuthInstructions`, `pendingFixedCwdReset` +
  `clearStaleAutoResumeState`, `BACKEND_STOPPED_DURING_TURN`, and the
  `host.dormantReason = "stream-ended"` write. Plan-gate the split: which
  become deps callbacks (one per concern, named for what they do, not
  "onEvent") and which stay as a single `onStreamEnded` / `onStreamError`
  callback carrying the loop's local facts. The stream-end and error
  branches are the two places to be careful; move them line for line.
- The bound-session guard `managed.session !== boundSession` becomes
  `this.session !== boundSession`; `consumerPromise` assignment in
  `installSession` stays identical.
- Pins that go red if the loop drifts: session-lifecycle T4 (pre-send
  stream end) and T6b (aborting event filter); queue-reliability L1
  (owned-turn stream end); agent-idle-eviction "backend-death wake";
  agent-death-recovery for the error-path wording. Run all ten files
  from S2's gate.
- Unit tests on the object (extend `server/session-manager.test.ts`):
  (c) a clean stream end while bound settles the turn and nulls
  `consumerPromise`, mutant: skip the null; (d) a stream end after a
  swap (session no longer bound) touches nothing, mutant: drop the
  bound-session guard. Both through a fake session whose iterator the
  test controls.
- Worktree hygiene: after `git rebase main`, run
  `bun install --frozen-lockfile` when the rebase touched bun.lock (S2
  lost time to missing dev deps).
- The `deps.createTurnDeferred` declared but never called in
  command-handlers.ts and the two forwarding lambdas stay for S4.

Acceptance: `runConsumer` gone from agent-manager.ts; the ten-file gate
green; the two new unit tests with their mutants named red; eslint on
touched files; build:ui; `bunx tsc --noEmit` before the final hand-off;
no change under `server/backends/`; `internal-docs/queue-reliability-design.md`
location note updated if it names the loop.

Decide with reviewer: the callback split; whether `runConsumer` is a
method or a module-private function.
Locked: rulings 1-8; `createSession` does not move in S3.

- [x] S3 landed as 913228a (SessionManager.consume owns the loop; five concern-named callbacks; runConsumer gone from agent-manager.ts; two more direct unit tests). Note: agent-manager.di's credential-isolation case (Bun.serve, 30 s cap) times out under concurrent runs and passes alone.
## PICKUP S4 - createSession behind the object, and the twelve call sites (Worker 1 / Reviewer 1)

Goal: every place that swaps or wakes a session calls one entry point on
`SessionManager` and passes what the manager knows; the
`X ? createSession(managed, X) : createSession(managed)` pattern at the
twelve `replaceSession` call sites is gone. Behaviour identical.

Mechanics (from S3's report):
- `createSession` (agent-manager ~4780-4900) is mostly prompt assembly on
  manager and office state (permission bookkeeping, cwd validation,
  session env, backend lookup and resumability check, room and user and
  office prompt, memory refs and notice, system prompt, usage roll on
  resume, environment revision). That knowledge stays in the manager.
  Plan-gate the cut: the object gains `replaceWith(host, resumeSessionId?)`
  (name with the reviewer) that calls a `createSession(host,
  resumeSessionId?)` dep and then does what `replaceSession` does today;
  the manager's `createSession` shrinks to the assembly and returns the
  `BackendSession`. If a cleaner split exists (for example the backend
  dispatch and resumability check moving to the object while the prompt
  assembly stays a dep), argue it in the plan gate with the line counts.
- The twelve call sites migrate to the entry point one by one; the
  hand-off lists each site by line and the exact before/after
  expression. The synchronous-throw rollback documented at the edit path
  (~1229, "a SYNCHRONOUS createSession/replaceSession throw rolls back")
  must keep its ordering: name the test that pins it, or add one.
- Do NOT remove the nine getter views or the two forwarding lambdas in
  this slice; that is S5 with the docs and the loop close.
- Unit test on the object (extend `server/session-manager.test.ts`):
  (e) `replaceWith` closes and drains, then calls the createSession dep
  exactly once with the resume id it was given, then installs, mutant:
  call the dep before the drain; (f) a dep that throws synchronously
  leaves the object with no session and rejects the pending turn with
  `SessionSwappedError`, mutant: swallow the throw.
- Load note for the gates: the credential-isolation DI case in
  agent-manager.di.test.ts (Bun.serve, 30 s cap) times out under
  concurrent lane and ci runs and passes alone; if it fails in your gate,
  rerun that file alone and paste both lines, do not raise the cap.

Acceptance: no caller constructs a session and hands it to
`replaceSession` any more (grep `replaceSession(` shows only the object
and its test); the ten-file gate green; the two new unit tests with their
mutants named red; eslint on touched files; build:ui; `bunx tsc
--noEmit` before the final hand-off; no change under `server/backends/`.

Decide with reviewer: the entry point's name and signature; the exact
cut of `createSession`.
Locked: rulings 1-8; views and forwarding lambdas stay until S5.

- [ ] S4 landed (hash, note)



