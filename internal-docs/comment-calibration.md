# Comment calibration

Calibration date: 2026-09-04. This document is temporary and will be deleted after Nil rules on the disputed examples.

## Scope and measurement

The census includes non-test `.ts` and `.tsx` files in `server/`, `ui/`, and `shared/`. It excludes `server/backends/codex/_generated`, the plugin files, and the slide-mode files named in task e01d4e2e. A line counts as a comment when it starts with `//` or `/*`, or is inside a `/* ... */` block. A nonblank remaining line counts as code.

| Directory | Files | Comment lines | Code lines | Comment/code |
| --- | ---: | ---: | ---: | ---: |
| `server/` | 168 | 17,565 | 50,988 | 0.34 |
| `ui/` | 113 | 4,921 | 39,339 | 0.13 |
| `shared/` | 18 | 1,370 | 2,533 | 0.54 |
| Total | 299 | 23,856 | 92,860 | 0.26 |

This is a diagnostic stratified sample, not a representative sample. It over-weights rare classes so Nil can rule on them. Its final keep/cut ratio will not estimate how much of the corpus should be removed. The corpus is about 74% `server/`, 21% `ui/`, and 6% `shared/` comment lines; this sample contains 29, 8, and 3 items from those directories. Reviewer 2 also made two independent uniform draws of 40 comment blocks (seeds 20260904 and 777) on 2026-09-04. About four of those 80 blocks were weak enough to cut. Those draws were almost all decision rationale. They do not support the premise that this tree has broad comment bloat.

## Blind sample

Reviewer 2 rated the initial version blind before seeing the worker's ratings. Each citation now names the first quoted source line. Long comments stop after eight source lines and use a marked truncation line. All entries were checked by a source-extraction script after the initial hand-transcribed draft produced citation errors.

### File-header blocks and long comments

1. `server/auth-middleware.ts:1`

   ```ts
   // HTTP middleware + WS upgrade auth + /auth/* routes.
   //
   // The whole gating layer lives in this file so a future audit can read one
   // file end-to-end and trace every request shape.
   ```

2. `server/backends/claude.ts:1`

   ```ts
   // Claude backend (final shape, step 2c).
   //
   // Owns every `@anthropic-ai/...` import. agent-manager talks to this module
   // through the Backend / BackendSession interface only:
   //
   //   orchestrator        ────────►  claudeBackend.createSession(opts)
   //                                          │
   //                                          ▼
   // ... [truncated after 8 source lines]
   ```

3. `server/log-search-child.ts:1`

   ```ts
   // Child process for the conversation-log search scan. Reads one JSON request on
   // stdin, runs the shared core, writes one JSON envelope on stdout, exits.
   //
   // WHY A SEPARATE PROCESS AND NOT A WORKER THREAD - this is the ReDoS guard, and
   // only a process actually delivers one in this runtime. Nil's spec called for
   // regex support with "a match timeout or an RE2-style engine". Everything below
   // was measured, not assumed:
   //
   // ... [truncated after 8 source lines]
   ```

4. `server/storage-roots.ts:1`

   ```ts
   // The office's PRODUCTION storage roots, in one place (task 1387a9c7).
   //
   // server/storage-usage.ts is deliberately root-injected - every path is a
   // parameter so tests measure a temp fixture tree. That leaves the question of
   // where the real paths come from, and there are now two callers that need the
   // same answer: the /api/storage/usage route (server/isomux-office.ts) and the
   // /isomux-storage slash command (server/command-handlers.ts). Resolving them
   // twice would let the two surfaces disagree about what "isomux storage" is, so
   // ... [truncated after 8 source lines]
   ```

5. `ui/view-persistence.ts:1`

   ```ts
   // Refresh persistence: client-side (localStorage) memory of where the user
   // was in the UI, so a page reload reopens the same spot, plus unsent chat
   // drafts so an accidental reload doesn't eat typed-but-unsent text.
   //
   // localStorage over sessionStorage deliberately:
   // - On phones (esp. iOS PWA) the webview is killed and relaunched constantly;
   //   sessionStorage does not reliably survive that, and the relaunch is exactly
   //   the "reload lost my place / my draft" pain being fixed.
   // ... [truncated after 8 source lines]
   ```

6. `ui/log-view/isomux-curl.ts:1`

   ```ts
   // Parser for curl commands that target the isomux server's own API.
   //
   // The chat transcript is full of Bash tool calls like
   //   curl -s -X POST localhost:4000/api/agents/<id>/messages -H 'Content-Type:
   //   application/json' -d '{"text":"..."}'
   // Since we know the shape of our own API, we can render these as a structured
   // card (method badge, route, key payload fields) instead of raw shell text.
   //
   // ... [truncated after 8 source lines]
   ```

### Inline rationale and papercuts

7. `server/auth-middleware.ts:39`

   ```ts
   // Fires after the office gets its first owner - either through the tokenless
   // claim form (handleClaim → claimOwnership) or the legacy bootstrap-invite
   // accept path (handleAccept where isBootstrap is true). Awaited best-effort
   // after the session has persisted but before the redirect response is
   // returned; the hook MUST NOT roll auth state back on its own failure, and
   // the caller must log + swallow any throw. `null` resets for repeated test
   // boots.
   ```

8. `server/cronjob-manager.ts:226`

   ```ts
   // Synchronously-claimed slot for runs whose resume/fork is mid-startup but
   // hasn't reached `activeRuns.set` yet. Without this gate, a second concurrent
   // send/edit call for the same runId would pass the activeRuns.has() check
   // during the awaits in editRunMessage (getSessionMessages → forkSession),
   // fork twice, and end up overwriting each other's ActiveRun entries.
   ```

9. `server/cronjob-manager.ts:262`

   ```ts
   // floor + 1 (not ceil): when elapsed lands exactly on a period boundary,
   // ceil(N) = N gives nextFireAt == now and the scheduler fires immediately.
   // floor(N) + 1 always returns the *next* future period.
   ```

10. `server/command-handlers.ts:246`

   ```ts
   // Build the new session BEFORE destroying pending control state and
   // the message queue. If createSession throws (bad cwd, broken env,
   // etc.) the user sees a visible error and the prior pending/queue
   // state stays intact - they can retry or pick another recovery path.
   // Once createSession returns, the swap commits: pending/queue clear,
   // topic persists, replaceSession installs. Queue must clear BEFORE
   // replaceSession or the post-swap idle trigger flushes prior-context
   // messages into the fresh session.
   ```

11. `server/app-domain.ts:52`

   ```ts
   // Tailscale's MagicDNS namespace, which is a separate refusal from the one
   // above: a name like `auntie.parrot-fish.ts.net` is real and resolvable, and
   // an office served there is genuinely on HTTPS. What it cannot do is carry
   // CHILDREN - MagicDNS has no wildcard records and a Tailscale certificate
   // covers the node's own name only - so deriving a domain here would hand every
   // app an address that resolves nowhere and put that address in its
   // environment. A tailnet office keeps port links instead (Nil, 2026-08-08).
   //
   // ... [truncated after 8 source lines]
   ```

12. `server/app-domain.ts:96`

   ```ts
   // Dotted name required: a single-label office host is an intranet name that
   // cannot carry a public wildcard record.
   ```

13. `server/safety-policy.ts:21`

   ```ts
   // The write-protection root follows the active state root, so a test that
   // redirects ISOMUX_HOME protects its temp dir rather than the real one.
   // NOTE: the literal "~/.isomux" patterns in the command-text checks below are
   // deliberately NOT derived from this - they match what an agent literally
   // typed, not resolved app state. Do not replace those literals with STATE_ROOT.
   ```

14. `server/internal-types.ts:127`

   ```ts
   // Set while abort() is mid-flight (between session.close() and installSession of the
   // replacement). sendMessage awaits this so a follow-up message arriving in the gap
   // doesn't see session=null and amputate context by spinning up a fresh blank session.
   // Also serves as a partial swap-lock: serializes the most user-visible variant
   // (sendMessage-during-abort) of the broader concurrency hole where multiple swap
   // callers (newConversation/resume/editAgent/editMessage/`/clear`) can race and
   // orphan the loser's session. See task 154e2c14. Don't remove without replacing.
   ```

15. `server/app-proxy.ts:296`

   ```ts
   // Set-Cookie is handled below: iterating a Headers object folds repeated
   // field lines into one comma-joined value, and an `Expires` date contains a
   // comma - so re-appending that string would hand the browser one malformed
   // cookie instead of two good ones.
   ```

16. `server/app-auth.ts:133`

   ```ts
   // Same shape as ready-limiter.ts, twice, with the failure posture as a
   // constructor argument because the two sides fail in opposite directions:
   //
   //   mint  - fail CLOSED when the table is full. Refusing to mint is a 429 the
   //           user can retry; minting untracked would remove the only bound on
   //           a redirect loop.
   //   redeem - fail OPEN. It guards a 256-bit code, so it is nuisance control,
   //           and a full table failing closed would lock every app's users out
   // ... [truncated after 8 source lines]
   ```

17. `server/routes/handlers/agents.ts:95`

   ```ts
   // Stops whatever the agent is doing: cancels the in-flight turn, and denies
   // a permission prompt it is parked on. Returns the outcome rather than void
   // (task 29daebe2) - an agent with no turn and no prompt has nothing to stop,
   // and reporting that as success told operators the opposite of the truth.
   ```

18. `shared/types.ts:127`

   ```ts
   // Repointing a family at a newer model the bundled CLI doesn't know yet? Bump
   // @anthropic-ai/claude-agent-sdk in the same commit, the way c2f0946 and
   // 136fc53 did -- the CLI reports the model's context window, and an
   // unrecognized id makes it fall back to a 200k default (task 89925a7c).
   ```

19. `shared/languages.ts:13`

   ```ts
   // `as const` (not a LanguageOption[] annotation) so SupportedLanguageCode below
   // can be DERIVED from this table: adding a language here widens the type
   // everywhere, and a typo'd code becomes a compile error rather than a value
   // that only fails at runtime.
   ```

20. `shared/contract-shapes.ts:283`

   ```ts
   * Which two-step prompt the agent is parked on RIGHT NOW, or null.
   *
   * LIVE AGENT STATE, NOT SESSION HISTORY (task 29daebe2). It describes the
   * agent at the moment of THIS request and says nothing about the session
   * being read: a transcript fetched for an old session still reports the
   * agent's current prompt, and re-reading the same session later can return a
   * different value. Present because a permission prompt is written as an
   * ephemeral log entry and never reaches the transcript, so a reader sees a
   * ... [truncated after 8 source lines]
   ```

### Narration

Narration is thin in this tree. Items 23-26 are clear narration; item 21 is disputed. The stratified sample could not support six clear narration slots, consistent with the uniform draws finding about four weak blocks in 80.

21. `server/cronjob-manager.ts:240`

   ```ts
   // Event sink (instance-scoped). isomux-office.ts overrides via onCronjobEvent() after
   // construction; deps.eventSink lets tests capture emitted events.
   ```

### Inline rationale and papercuts, continued

22. `ui/log-view/TerminalPanel.tsx:482`

   ```ts
   // Trick xterm into rendering its focused cursor (block + blink) even
   // though we route input via our own proxy and the helper textarea is
   // hidden. xterm registers a real DOM "focus" listener on the
   // textarea that just sets _isFocused=true; dispatching the event
   // synthetically fires that listener regardless of display state.
   // CAUTION: depends on xterm's internal focus tracking being a pure
   // DOM-event listener - verified in @xterm/xterm 6.0.0. If a future
   // release polls document.activeElement instead, the cursor will
   // ... [truncated after 8 source lines]
   ```

### Narration, continued

23. `ui/App.tsx:553`

   ```ts
   // Sync history stack with view state
   ```

24. `ui/office/Character.tsx:185`

   ```ts
   // Slightly darker version of hair color for beard
   ```

25. `ui/office/StatusLight.tsx:25`

   ```ts
   // Apply escalation colors for active states
   ```

26. `ui/log-view/Markdown.tsx:70`

   ```ts
   // Override link renderer to always open in new tab
   ```

### Dated history, task, phase, and option references

27. `server/command-handlers.ts:274`

   ```ts
   // Conversation boundary: reset context-fullness state and broadcast the
   // pill clear. Runs AFTER the swap resolves (unlike newConversation's
   // pre-await reset) - safe here because replaceSession already installed
   // the new session, so every old-session in-flight sample is orphaned by
   // the session-identity check regardless of gen. Missing this reset left
   // the pill showing the PREVIOUS conversation's reading after a typed
   // /clear, and carried its fired thresholds into the fresh conversation
   // (fixed 2026-07-18; the API /clear path resets via newConversation).
   ```

28. `server/persistence.ts:656`

   ```ts
   // Engine. Missing field defaults to "claude" on load (legacy agents spawned
   // before this field was added). Fixed at spawn - see task f352984f Round 3.
   ```

29. `server/identity/guards.ts:143`

   ```ts
   // `public` in the spec. Always allows: it is the declared marker for the
   // pre-authn login/static surface, which is served BEFORE the dispatcher (so the
   // dispatcher's null-identity → 401 rule never applies to it). Named with a
   // `Guard` suffix because `public` is a reserved word. NOTE for 2.3: route public
   // surfaces AROUND authorize(), never through it with a null identity - the
   // dispatcher intentionally maps a null identity to 401 before any guard runs.
   ```

30. `server/isomux-office.ts:5013`

   ```ts
   // Unified REST surface (Phase 3a). Routes declared in the typed table are
   // dispatched through the executor: identity -> authorize -> preconditions
   // -> idempotency -> handler -> emit. Identity is REQUIRED (cookie or
   // bearer). An unmatched or not-yet-migrated /api path falls through to the
   // legacy handlers (/api/upload, /api/files, /api/images) and the static
   // serve below.
   ```

### Comment-shaped code and pseudocode: complete heuristic enumeration

No dormant executable statement was found. The three in-scope blocks that match the broader visual heuristic are documentation or pseudocode, not code that can be uncommented. Items 2, 31, and 40 are the complete heuristic class: the Claude call-flow diagram, the Codex state-machine diagram, and the rule expression.

31. `server/backends/codex/adapter.ts:533`

   ```ts
   // State machine:
   //
   //   constructor()
   //        │  (spawn subprocess; start bootstrap)
   //        ▼
   //   INITIALIZING ──── initialize() + thread/start ────► READY (system_init emitted)
   //        │                                                  │
   //        │                                                  │  send()/approve()/abort()
   // ... [truncated after 8 source lines]
   ```

### Tagged comments: complete enumeration

The in-scope tree contains one `TODO`/`FIXME`/`XXX`/`HACK` comment. Item 32 is the whole class. The complete set of line-leading `NOTE`, `WARNING`, `IMPORTANT`, or `CAUTION` tags appears in items 13, 22, and 33-37. `server/test-support/` is in scope because these support files are non-test source even when their consumers are tests.

32. `ui/log-view/TerminalPanel.tsx:141`

   ```ts
   // ... [preceding 7 source lines omitted]
   // TODO (CJK IME): hiding xterm's helper textarea (display:none) means the
   // in-place IME composition decoration users see while composing CJK / voice
   // dictation isn't rendered. Acceptable for English/swipe; revisit if mobile
   // CJK support is requested.
   ```

33. `server/test-support/preload.ts:10`

   ```ts
   // ... [preceding 9 source lines omitted]
   // IMPORTANT: this file must NOT import server/config.ts. config.ts resolves
   // STATE_ROOT once at import; importing it here (directly or transitively) before
   // we set ISOMUX_HOME would freeze STATE_ROOT to the real home. temp-state.ts
   // pulls in only os/fs/path, so it is safe to import.
   ```

34. `server/persistence.ts:701`

   ```ts
   // NOTE: `privileged` needs no backfill here. It's an optional field and every
   // read site coerces a missing value with `?? false`, so a legacy agent (no
   // field) already behaves as not-privileged - and NOT rewriting it keeps the
   // saveAgents->loadAgents round-trip lossless.
   ```

35. `server/isomux-office.ts:2745`

   ```ts
   // NOTE (room-scoped board): the loop above stripped the closed roomId
   // from every user's allowedRooms, and owners project against LIVE rooms
   // - so this room's tasks are now inaccessible to EVERYONE and simply
   // become orphans carrying a dead roomId. Whether a close should reassign
   // those tasks to global, delete them, or preserve them as inaccessible
   // orphans is an unresolved product decision flagged to the Manager, and
   // this re-push does NOT settle it: the task RECORDS are untouched either
   // way. It only makes live boards agree with what a reload already shows,
   // ... [truncated after 8 source lines]
   ```

36. `server/agent-manager.ts:4383`

   ```ts
   // ... [preceding 4 source lines omitted]
   // IMPORTANT - drain-before-install is load-bearing. Switching to swap-then-
   // drain (install new synchronously, drain old in background) is tempting
   // because it would let follow-up messages typed after Ctrl+C reach the LLM
   // without waiting ~3s for the old session to drain. Don't do it without
   // first verifying there's no on-disk race on the shared sessionId .jsonl
   // between the dying-old and starting-new subprocesses - both write to the
   // same file when the new session is created with --resume. See task
   // 154e2c14's STILL OPEN section for context. The current sendMessage
   // ... [truncated after 8 source lines]
   ```

37. `server/log-search.ts:781`

   ```ts
   // NOTE the limit of this branch: reconstruction materializes the whole
   // ancestry BEFORE the first deadline check, so a single enormous session
   // can blow past the cooperative budget and end at the hard deadline (a
   // SIGKILL, so no partial at all) instead of returning one. The per-entry
   // check below bounds the MATCHING, not the reading. Acceptable because the
   // scan is process-isolated and hard-bounded either way; a streaming
   // reconstructed iterator is the fix if this ever bites.
   ```

### Section banners

38. `server/cronjob-manager.ts:248`

   ```ts
   // ---------------------------------------------------------------------------
   // Schedule math
   // ---------------------------------------------------------------------------
   ```

39. `server/log-search.ts:520`

   ```ts
   // --- Index mode -------------------------------------------------------------
   ```

### Comment-shaped code and pseudocode, continued

40. `server/identity/guard-deps.ts:25`

   ```ts
   // The live RULE-BASED access predicate for a user, keyed by userId:
   // sessionHasFullRoomAccess(session) || roomAllowedForSession(session, roomId)
   // (both now route through canAccess: owners by rule, members by grants), with
   // session reduced to { userId }. The isomux-office.ts seam supplies this closure.
   ```

## Proposed criteria

The gate for keeping a comment is high. Keep one when it does at least one of these:

1. It justifies a code decision that goes against general convention, and gives the reason. Example: item 16 explains why one rate limiter fails closed while the other fails open.
2. It points to a papercut that someone modifying the code is likely to hit. Example: item 15 warns that folding repeated `Set-Cookie` fields corrupts cookies whose expiry contains a comma.
3. It states a contract or invariant that the type cannot express. Example: item 20 distinguishes current live agent state from the historical session named by the response.
4. It states module ownership or a boundary that tells a modifier which of similar modules owns a behavior. Example: item 1 puts the full HTTP and WebSocket authentication gate in one auditable module.
5. It decodes an external behavior or magic arithmetic that the code cannot explain by naming alone. Example: item 9 explains the exact-boundary failure caused by `ceil`.

Cut these classes by default:

| Class | Granularity | Rule |
| --- | --- | --- |
| Narration of the next line | Whole comment | Cut unless it adds a reason, constraint, or non-obvious contract. |
| Dated history | Fragment | Cut a date that records when a decision was made. Keep a date or version that bounds what was verified, such as item 22's `verified in @xterm/xterm 6.0.0`; without that scope, the measured claim cannot be checked. Keep the parent block when its current rationale still meets a keep criterion. |
| Commit, task, phase, or option reference | Fragment | Cut the reference span. Keep the parent block when its current rationale still meets a keep criterion. A block made only of the reference is a whole-comment cut. |
| Commented-out code | Whole comment | Cut. No dormant executable statement was found in scope. |
| Reviewer-attribution note | Whole comment | Cut. The code must carry the reason, not the review history. |

The fragment rule matters in this tree. Reviewer 2 grouped all 5,604 in-scope contiguous comment blocks on 2026-09-04:

| Marker | Blocks | Standalone one-line blocks | Blocks of 3+ lines |
| --- | ---: | ---: | ---: |
| `task <hex>` | 253 | 0 | 240 |
| ISO date (`20xx-xx-xx`) | 45 | 0 | 41 |
| `Phase N` | 116 | 5 | 102 |

Task IDs and dates are almost always fragments inside substantive rationale. Treating the marker as a whole-comment class would remove about 300 rationale blocks instead of removing their history fragments.

## Recommendations and disagreements

Worker recommendation: 33 keep, 7 cut. This is a calibration count, not an estimate for the corpus.

| Item | Worker | Reason |
| ---: | --- | --- |
| 1 | Keep | K4: declares the authentication audit boundary. |
| 2 | Keep | K4: declares SDK ownership and the backend interface boundary. Cut the `final shape, step 2c` fragment. |
| 3 | Keep | K1: gives measured evidence for the unusual child-process design. |
| 4 | Keep | K4: explains why root resolution is separate. Cut the task-ID fragment. |
| 5 | Keep | K1: explains the non-default storage choice and its mobile failure mode. |
| 6 | Keep | K4: defines the conservative parser boundary and fallback posture. |
| 7 | Keep | K3: states failure and rollback obligations for the hook. |
| 8 | Keep | K2: names the double-fork race that the synchronous claim prevents. |
| 9 | Keep | K5: explains boundary arithmetic that the expression does not reveal. |
| 10 | Keep | K2/K3: states ordering constraints and their failure modes. |
| 11 | Keep | K1: explains the MagicDNS exception. Cut the attribution/date fragment. |
| 12 | Keep | K1/K5: explains why hostname validation requires two labels. |
| 13 | Keep | K1/K2: explains the test-root choice and warns against deriving literal command patterns from it. |
| 14 | Keep | K2/K3: documents the partial swap lock and the race it prevents. The task pointer is an open question. |
| 15 | Keep | K2: warns about the repeated-header and comma interaction. |
| 16 | Keep | K1: explains the opposite rate-limit failure postures. |
| 17 | Keep | K3: explains why abort returns an outcome. Cut the task-ID fragment. |
| 18 | Keep | K2: warns that a model-only bump silently gets the wrong context window. Cut commit IDs and the task ID. |
| 19 | Keep | K1: explains why the table uses `as const`. |
| 20 | Keep | K3: distinguishes live response state from requested history. Cut the task-ID fragment. |
| 21 | Cut | Narration: the assignments directly show both wiring paths. |
| 22 | Keep | K2/K5: records the xterm implementation detail on which the synthetic focus event depends. |
| 23 | Cut | Narration: the following history calls show the synchronization. |
| 24 | Cut | Narration: the opacity value shows the darker beard treatment. |
| 25 | Cut | Narration: the branch and escalation constants state this behavior. |
| 26 | Cut | Narration: the renderer assignment states the behavior and gives no reason. |
| 27 | Keep | K2: names the stale-state failure that the reset prevents. Cut the dated fix fragment. |
| 28 | Keep | K3: defines the missing-field compatibility behavior. Cut the task/Round fragment. |
| 29 | Keep | K1/K3: explains the reserved-word name and the pre-dispatch boundary. Cut `NOTE for 2.3`. |
| 30 | Keep | K4: states the executor pipeline and legacy fallback boundary. Cut the phase label. |
| 31 | Keep | K3/K4: shows a lifecycle spread across several methods. |
| 32 | Keep | K2: records an accepted limitation and a concrete revisit trigger. |
| 33 | Keep | K2: warns that an early import can point tests at live state. |
| 34 | Keep | K1/K2: explains why the missing migration is intentional. |
| 35 | Keep | K2/K3: states the unresolved orphan semantics and what this path does not change. |
| 36 | Keep | K2: warns against a tempting session-swap order. The still-open task pointer is an open question. |
| 37 | Keep | K2: states a known hard-deadline limit and the repair if it becomes material. |
| 38 | Cut | Section banner: the following function names the schedule-math section. |
| 39 | Cut | Section banner: the following function names index mode. |
| 40 | Keep | K3/K4: defines the injected access predicate and its production seam. Keep the `canAccess` span because it states the current delegation path. |

Known disagreements after the blind rating:

- Item 21: Reviewer 2 says keep under K3/K4 because it states who overrides the sink and when. The worker says cut because the adjacent initialization and setter show both facts directly.
- Item 40 fragment, `(both now route through canAccess: owners by rule, members by grants)`: Reviewer 2 says cut it as history inside a keeper. The worker says keep it because it states the current authorization delegation and actor split.
- Removed round-1 item `server/app-domain.ts:101` (`The address an app answers at ... DERIVED, never stored`): Reviewer 2 says keep under K1/K4 because it explains why no stored field exists. The worker says cut because the function signature and body directly show that the URL is derived. This remains a calibration disagreement even though the block left the 40-item sample.

Reviewer 2 and the worker both recommend cutting items 38 and 39. The counter-position is that banners help navigation in files that run to thousands of lines and are cheaper to scan than function declarations.

Between rounds, the prior items 17 and 18 left to add task and commit-reference coverage, and the prior item 22 left to restore the 29/8/3 directory balance while adding the missing tagged blocks. Reviewer 2 later rated all four replacement blocks keep.

## Open questions

1. Does Nil agree that dated history and task, commit, phase, and option references are fragment classes, while narration, dormant code, and reviewer attribution are whole-comment classes?
2. When a task reference points to still-open design context, as in items 14 and 36, is it a live pointer worth keeping or history that the comment must state directly?
3. Should section banners in very large files be cut because they duplicate nearby names, or kept as navigation aids?
