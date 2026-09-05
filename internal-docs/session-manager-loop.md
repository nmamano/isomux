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

- [ ] S1 landed (hash, note)
