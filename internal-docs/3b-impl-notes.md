# Phase 3b — Converged Design + Implementation Notes (Isomuxer1 + Reviewer1)

> LIVE working doc for the IN-PROGRESS Phase 3b. Captures the converged design,
> the Isomuxer3 ACL security pins, and the slice sub-plan. Folds into
> internal-docs/generic-runtime-refactor.md at 3b close-out (not done yet).

## STATUS (at session handoff)

- **3b.1** emit/projection foundation — DONE, Reviewer1-signed-off, green.
- **3b.2** view data model (`hidden`/`order`) + migration backfill — DONE, Reviewer1-signed-off, green.
- **3b.3** rule-based access flip — **DONE, green, REVIEWED**:
  - A: `canAccess` flip across all access read-sites + boot owner-migration.
  - B: `auth.ts` stops materializing owner grants (bootstrap + invite-accept; owners seed grants=[], notifRooms preserved).
  - C: create_room fan-out removed (owners by rule via room_created; a member creator gets a grant + full_state; no grant broadcast).
  - E: boot owner-migration extracted to PURE `planOwnerAccessMigration` (server/access-migration.ts) + a thin index.ts wrapper; covered by 8 planner unit cases + a real-boot harness `restart()` integration test (runs-at-boot-after-rooms + idempotent). Plus the `update_user` notifRooms clamp fixed to `accessibleRoomIdsFor` (owners are grants=[] but full-access by rule, so the old allowedRooms clamp wrongly pruned an owner's notif to []).
  - Reviewer1 impl-cleared; Isomuxer3 ACL gate **PASS** (HARD condition: 3b.5 must land before any restart — grants are now the ACL boundary and the all-audience user broadcasts still ship full records).
- **3b.4** view.* routes + per-user reorder — **DONE, green, Reviewer1-cleared**: `clampViewFields` (pure single invariant core) + `applyViewChange` + `getViewProjection`; 5 REST view.* handlers; reorder is now PER-USER (the `sessionHasFullRoomAccess` gate, `agentManager.reorderRooms`, the `OfficeState.reorderRooms` primitive, the `rooms_reordered` OfficeEvent + ServerMessage + index routing + UI reducer all removed); no-oracle writes + order dedupe + `notifRooms ⊆ effective shown`; `claim_user` routed through the core. UI change was pure dead-code removal (build deferred to the coordinated deploy).
- **3b.5** UserPublicWire user-wire projection (close the residual leak) — **IN DESIGN** (with Reviewer1): user_updated/users_list → UserPublicWire (all) + a SEPARATE owners-audience user_admin_updated/users_admin_list; strip office envFile from the member full_state projection; flip the leak test; then Isomuxer3's HARD ACL gate.

## ⚠️ DO NOT RESTART/DEPLOY until 3b.5 lands + the gates clear

3b.3 + 3b.4 are WIP in the working tree (NOT committed; office still runs on b8d1ba7). The boot owner-migration MUTATES persisted owner records (clears grants, seeds `hidden`) and is now TESTED + REVIEWED — BUT 3b.3 is NOT independently deployable: the all-audience `user_updated`/`users_list` still ship full UserRecords, and post-3b grants ARE the ACL boundary, so they leak hidden room ids via other users' grant lists. **3b.5 (UserPublicWire) is a HARD restart-gating dependency** (Isomuxer3). Gate any restart behind: 3b.5 done + Reviewer1 (impl) + Isomuxer3 (ACL, multi-socket) on the 3b.5 diff + an adversarial subagent review of the FULL 3b diff + Nil's explicit go. Then one restart deploys all of 3b at once.

## As-built deltas to reconcile into generic-runtime-refactor.md at close-out

- Follow-up 6 ("update_room_settings 'Room not found' branch is unreachable") is REVIVED for owners: rule-based `canAccess(owner, anyId)` is true even for a nonexistent id, so the access gate passes and the existence check is now reachable → owners get "Room not found" (members still get "You don't have access"). Not a leak; update Follow-up 6.
- The general `update_user` grant broadcast still carries `allowedRooms` (pre-existing leak; board task 85d67fb1) — fixed in 3b.5. Office `envFile` in member full_state (board task 850b46e6) — fixed in 3b.5 (Isomuxer3 Q1b).

---

Wire stays DENSE-INDEX this phase. Behavior-preserving foundation first; semantic flips isolated and characterization-flipped with comments. id-keyed wire is 3c, not here.

## Model

### Access (security)
- `canAccess(user, roomId) = user.role === "owner" || user.grants.includes(roomId)`.
- `allowedRooms` is repurposed as the MEMBER GRANT store only (rename intent: "grants"). Owners ignore it for access (rule = all). Only `users.setAccess` (owner-only) writes grants.

### View preference (per-user, server-stored, non-security)
- `hidden: string[]` — rooms the user has explicitly hidden. Effective `shown = accessible \ hidden`.
- `order: string[]` — SPARSE explicit order; effective order = explicit-order-first, then creation-order fallback for accessible+shown rooms not listed.
- `notifRooms ⊆ effective shown ⊆ accessible`. Clamp notifRooms to effective shown after every view/access mutation.
- `defaultRoomId` clamped to effective shown (else null / first-visible per existing convention).
- Net invariant the model BUYS US: "newly accessible rooms are visible by default" is a RULE, not a fan-out side effect. A new room is accessible (owners by rule; creator by grant), not in `hidden`, and sorts last by creation fallback ⇒ visible to creator+owners with ZERO owner fan-out.

### Predicate naming discipline (Reviewer1)
Keep access vs view separate everywhere: `canAccess(user, roomId)` (security) and `isShown(user, roomId, accessSet)` (view). Do not let legacy names (`roomAllowedForSession`, `sessionHasFullRoomAccess`) imply allowedRooms == visible == owner-access.

## Architecture
- **emit() = audience selection** (from registry, already built). **Projection service = deliver()**: the ONLY place allowed to translate global event payloads into recipient-dense wire state, suppress room-hidden payloads, replay visible transcript/log/slash/session state after a full_state, and call raw `ws.send` for projected fanout. Handlers/core ops call `liveEmit()` ONLY.
- **Raw-send invariant (scoped, Reviewer1):** the negative test forbids raw EVENT FANOUT from handlers/core ops outside `server/events/` + the projection module (explicitly allowlisted as the dispatcher). It does NOT forbid all ws.send — direct request/response, ping/pong, connect-time one-offs, and not-yet-migrated bridge surfaces keep their sends.
- **full_state (shift/move/close/access-change/connect):** recipient-scoped emit (`{userId}` fanout via `sessionsForUser`); projection service owns the dense per-socket shape and performs socket-local replay (logs/slash/session_context) INSIDE deliver. liveEmit(full_state) carries a global/unprojected subject the projection resolves; projection owns the dense wire shape.

## Slices (ordered)
1. **emit/projection foundation (behavior-preserving).** Extract implicit projection (visibleRoomProjection/projectAgentForSession/sendProjectedFullState/push helpers/routeAgentEventToWs) into the declared projection service backing deliver(). Route live room/agent events + full_state + all_rooms_list through liveEmit(). Wire stays byte-identical; deliver strips/shapes any extra carried registry fields back to today's dense shape. `projection.test.ts` stays GREEN UNCHANGED (the proof).
2. **view data model + migration (behavior-preserving).** Add `hidden` + sparse `order`. `order` migrates to `[]` for everyone (sparse ⇒ creation-order fallback = today's global order). Projection reads (order ∩ accessible) \ hidden. Access still materialized ⇒ view byte-identical across slices 2 AND 3.
   **`hidden` migration rule (LOCKED with Reviewer1 — explicit, not impl-time judgment; decides whether an owner can boot a blank office):**
   - Member (any allowedRooms): `hidden = []` (accessible == grants == shown; today's behavior).
   - Owner, missing / non-array allowedRooms: malformed/materialization-drift ⇒ `hidden = []` (sees all by rule; bias to availability).
   - Owner, allowedRooms === `[]`: ambiguous. `[]` is NOT provably self-hide-only (claimUser defaults an owner to `[]` when the caller omits the snapshot — drift can produce it) ⇒ bias to availability, `hidden = []`. Pinned by a migration test so the decision is explicit, not incidental.
   - Owner, non-empty allowedRooms: `hidden = allRooms \ allowedRooms` (preserves a self-hidden owner's current view).
   Needs `allRooms` at migration time ⇒ run the `hidden` seed once rooms are loaded (sequencing detail for slice 2). Migration tests incl. all four owner/member cases.
3. **rule-based access.** Flip access to `canAccess`. Drop owner materialization. Remove create_room owner fan-out + notifRooms auto-sync. create_room grants ONLY the creator (if member). setAccess (owner-only) writes grants + pushes full_state to the TARGET only (no grant broadcast). Flip create_room-fan-out + owner-self-hide tests (outcomes preserved). Tests: create_room writes no owner grant/notif; creator+owners still see the room by effective access/view.
4. **view.* routes + reorder/notif/default (strangler).** REST view.get/setOrder/setShown/setNotifRooms/setDefaultRoom + WS shims delegating to one core op. Delete reorder_rooms gate → per-user sparse order, always allowed, no global _rooms mutation, no rooms_reordered. Non-leak: unknown/inaccessible ids ignored or uniformly rejected without revealing which case. Contract test: notifRooms ⊆ effective shown after every mutation. Flip reorder test.
   **Naming (LOCKED with Reviewer1):** storage/core terminology stays `hidden` (never drift back to `shown[]`). The public route may keep `view.setShown` accepting desired shown ids and convert at the boundary: `hidden = accessible \ requestedShown`.
5. **UserPublicWire user-wire projection.** users_list/user_updated ALWAYS carry UserPublicWire (audience all). Owners get full admin records (grants/env/memberPrompt/view) via SEPARATE owners-audience event ids (e.g. `users_admin_list` / `user_admin_updated`) — do NOT overload users_list with recipient-dependent payloads (cleaner registry audit). Close the residual all-audience leak (esp. member name/edit broadcasts). Flip the leak test: member receives UserPublicWire only; owner admin receives full records only on the owners-audience channel.

## Test gates before the semantic flip (Reviewer1)
- Migration tests for hidden/order/default/notif invariants incl. owner legacy edge.
- Contract: notifRooms ⊆ effective shown after every view/access mutation.
- Create-room regression: no owner grant fan-out, no notif auto-sync, room visible to owners by rule + not-hidden fallback.
- User-wire leak flip: member→UserPublicWire only; owner admin→full records only on owners-audience channel.
- Raw-send invariant scoped to event fanout outside projection, not direct replies.

## Security pins (Isomuxer3 ACL gate — design APPROVED to implement; must-fix BEFORE coding slices 3 + 5)

- **(Q1a) deliver() layering.** SECURITY suppression is `canAccess` (the registry audience); `hidden` is ONLY an additive DISPLAY filter on top (`shown = accessible \ hidden`). Make the layering explicit so no future re-show path can make `hidden` the security gate — re-show consults ONLY `canAccess`.
- **(Q1b) office `envFile` leak — CLOSE in this rewrite** (Phase-2 deferred it HERE; board task 850b46e6). `agent-manager.ts:364/:389` put `office.envFile` into the office-settings payload ⇒ member-projected `full_state.office` leaks it. STRIP `envFile` from member projection (owner-only); `office_settings_updated` (audience all) carries `{name,prompt}` only. TEST: a member's `full_state` contains no `envFile`. Fold into slice 5 (all-audience field reduction).
- **(Q2) preference-write READ-BACK oracle (slice 4).** Uniform-ignore on the write is necessary but NOT sufficient — the hole is read-back. Filter-on-WRITE (drop unknown/inaccessible ids before persist) AND/OR `view.get` returns ONLY the computed effective projection (∩ accessible). TEST: "view.get never returns a roomId the caller cannot access." Error shape: inaccessible / unknown / accessible-but-hidden ALL identical — silent-ignore+clamp, NEVER reject (reject is the oracle). `defaultRoomId` trap: `setDefaultRoom(inaccessible)` and `setDefaultRoom(accessible-but-hidden)` take the SAME path (clamp to null/first-visible).
- **(Q3) rule-based access is NOT just create_room — flip EVERY access read-site to `canAccess` in slice 3:**
  - `server/index.ts`: `visibleRoomProjection` (core), `agentVisibleForSession`, `roomAllowedForSession`/`sessionHasFullRoomAccess`, `liveEmitDeps.sessionsForRoomAccess`, `buildLiveGuardDeps.hasRoomAccessForUser`, `sendProjectedFullState` killed-filter.
  - `server/presence.ts (:15/:37/:95)`: sanitizer validates against sender `allowedRooms` ⇒ post-flip would REJECT an owner's presence in a rule-accessible room (fail-closed break + projection mismatch). Flip to `canAccess`.
  - `server/auth.ts` owner seeding: bootstrap (:607/:665) + invite acceptance (:769 `owner ? snapshotRoomIds()`) materialize owner `allowedRooms=all` — the SAME fan-out as create_room. STOP it (owners seed grants=∅; rule covers access).
- **(Q4) all-audience confirm (slice 5).** No `audience:all` event carries a `UserRecord`/sensitive field (`office_settings_updated` `{name,prompt}` only; tasks/cron carry names/attribution, not env). Owners-audience admin event is the ONLY full-record carrier. SELF channel scrub: a member's `UserSelfWire` may carry their OWN grants/view but never `office.envFile` or other users' data.
- **(Q5) migration safety — two-phase, CONVERGED with both reviewers:**
  - **Slice 2 = pure default-[] backfill (DONE).** On load, backfill absent `hidden`/`order` to `[]`. NO complement seed here: slice 2 keeps access materialized, so materialized access alone preserves every view (a self-hiding owner already sees only allowedRooms today). Slice 2 persists nothing derived from `allRooms`, so a restart between slices can lose nothing.
  - **Slice 3 = access flip + owner migration (idempotent, keyed by "owner allowedRooms non-empty"). For each owner, in order:**
    1. Seed `hidden` from the OLD allowedRooms with an EFFECTIVE-coverage guard (Isomuxer3): `hidden = (allowedRooms ∩ currentRooms) empty ? ∅ : allRooms \ allowedRooms`. The ∩-currentRooms guard makes blank-office-avoidance independent of prune-before-migrate ordering — a non-empty-but-all-STALE allowedRooms (e.g. `[deletedId]`) → ∅ (sees all), not blank.
    2. THEN clear owner grants `allowedRooms = ∅` (compute hidden FIRST). Grants are a member-only store; the rule covers owner access.
  - **DEMOTION BOMB = the SAME fix as the Q3 auth.ts removal — BOTH land in slice 3 or it is incomplete (Isomuxer3):** clearing EXISTING owners' grants closes the bomb only for current owners. A NEW owner invited after 3b RE-ARMS it unless `auth.ts` STOPS materializing owner grants at invite-acceptance (:769 `owner ? snapshotRoomIds()`) AND bootstrap (:607/:665). Owners seed grants=∅ going forward; rule covers access. Any future role-change path must (re)compute grants.
  - Q5 DISAGREEMENT RESOLVED: Isomuxer3 withdrew the blanket-∅ (verified `sessionHasFullRoomAccess` keys on allowedRooms COVERAGE not role ⇒ a partial owner already sees only allowedRooms today). Complement-for-non-empty locked as strictly behavior-preserving; empty / all-stale → ∅ guard.
  - TESTS (slice 3): legacy owner `allowedRooms=[]` → `hidden=∅`; owner `allowedRooms=[deletedId]` (all-stale) → `hidden=∅` (not blank); self-hiding owner `[r1,r2]/all=3` → `hidden={r3}`; demoted ex-owner → grants-only access; NEW owner invited post-3b → grants=∅ (no re-arm).
- **(Q6) raw-send invariant is BEHAVIORAL, not a file-allowlist.** Nothing outside the projection dispatcher may iterate `sessionsForUser`/`browsers`/`broadcast` (multi-socket fanout); a direct reply targets the caller's OWN socket only. Enumerate retained bridge sends + assert each is caller's-own-socket OR ACL-correct. (Slice-1 bridge `agent_removed` broadcast-all = today's minor leak, tightened in 3b.3 — audited, bounded, not unbounded.)

Isomuxer3 will run his own multi-socket projection tests on the slice 3 + slice 5 diffs (the two that can leak).

## Slice 3 implementation sub-plan (the security flip — execute each to a GREEN checkpoint; bring the WHOLE diff to Reviewer1 + Isomuxer3)

BOOT-ORDER: the owner migration needs BOTH users AND rooms, so it is a BOOT-time step (index.ts startServer, after agentManager rooms + users load), NOT users.ts load(). Idempotent marker = "owner allowedRooms non-empty" (a migrated owner has []).

- **3.A canAccess + atomic flip (index.ts + presence + migration + test-flip):**
  - `canAccess(user, roomId) = user.role === "owner" || user.allowedRooms.includes(roomId)`.
  - Flip `roomAllowedForSession` (index.ts:996) → canAccess; `sessionHasFullRoomAccess` (:985) → owner always full, member full iff grants cover all rooms. (sessionsForRoomAccess, buildLiveGuardDeps.hasRoomAccessForUser, agentVisibleForSession, sendProjectedFullState killed-filter, visibleRoomProjection, and the room handlers all read through these two → pick up the flip for free.)
  - DIRECT allowedRooms access-reads NOT via those two predicates (flip each individually): presence_update sanitizer (index.ts:2189 `user.allowedRooms.includes(r.id)`); the update_user presence allowedSet (`new Set(result.user.allowedRooms)` ~:3327 → build from canAccess: owner→all current rooms, member→grants); and audit buildPresenceListFor (:892). NOTE: create_room's `u.allowedRooms.includes(newRoomId)` (:3009) is part of the fan-out REMOVED in 3.C, not a flip.
  - Boot-migration placement: in startServer AFTER agentManager construct (:256, getRooms() valid synchronously) and force users load (listUsers()); run the per-owner seed-hidden-then-clear-grants there.
  - Boot migration (after rooms+users load): for each owner with allowedRooms non-empty → `hidden = (allowedRooms ∩ currentRooms) empty ? ∅ : allRooms \ allowedRooms` (merge with existing hidden), THEN `allowedRooms = []`. Persist. Idempotent.
  - presence: flip the index.ts call sites that build the allowedSet fed to refreshPresenceForUser/setPresence to use canAccess (owner → all current rooms; member → grants). presence.ts internals take a Set, so the seam is the Set build.
  - Flip owner-self-hide characterization test (projection.test:331): owner self-hide is now a VIEW pref (hidden), outcome preserved (owner main view excludes the room, all_rooms_list unfiltered).
  - Update stale "access fully encoded in allowedRooms" comments (shared/types.ts, index.ts) — Reviewer1 note.
- **3.B stop auth.ts owner materialization (has rollback paths — review precisely):** bootstrap creation (:605-607 drop snapshot), bootstrap promotion (:664-687 seed []/skip snapshot + adjust rollback), invite-accept (:767-769 drop owner snapshot). New owners seed grants=[]. Test: new post-3b owner → grants=∅ (no demotion re-arm).
- **3.C remove create_room fan-out (:2820-2881):** creator gets a grant only if member; owners by rule; NO allowedRooms/notifRooms fan-out; NO user_updated/users_list fan-out for the new room. Flip create_room test (projection.test:684): owner sees the new room via room_created (rule), not fan-out; the KNOWN-LEAK assertion flips (no user_updated carrying the new room id to other members).
- **3.D setAccess core (WS path; full view.* REST is slice 4):** owner-only grant write → writes member grants + pushes full_state to the target only (no grant broadcast). Clamp notifRooms ⊆ effective shown ⊆ accessible.
- **3.E tests:** demotion regression (ex-owner → grants-only); migration (legacy []→∅, stale-id→∅, self-hide→complement); multi-socket member-vs-owner suppression. Isomuxer3 runs his own set too.
