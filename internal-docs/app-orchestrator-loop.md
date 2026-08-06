# App-orchestrator loop - standing orders + slice handoffs

Working artifact for the overnight slice loop of 2026-08-06 (task f86bb897),
orchestrated by Isomux Manager. Workers: re-read this WHOLE file at the start
of every slice - conversations compact, files don't. Delete or archive after
the loop closes.

## North star

Phase 1 of `agent-apps-design.md`, landed clean in main: agents register web
apps by name via the isomux API; isomux allocates the port, runs each app as a
systemd user unit that outlives agents, sessions, and isomux restarts; an Apps
tab shows and manages them. Shelf, not ecosystem. Phase 2 (app tokens +
app-to-agent messaging) only if phase 1 is solid with night left.

## Process per slice

1. Manager authors the SLICE-N PICKUP section below, clears the worker's
   session, sets its effort, sends it the pickup.
2. Worker reads this file + the design doc, writes a short plan, sends it to
   its counterpart reviewer (plan-gate). Adjust on feedback before coding.
3. Worker implements IN MAIN (`~/nil/isomux`, no worktree), one slice only.
4. Worker runs the always-run gates (below), fixes until green.
5. Worker freezes (no further edits), fingerprints the diff
   (`git diff HEAD | wc -l` + `md5sum`, untracked included via
   `git add --intent-to-add .`), sends the reviewer the diff-gate request
   quoting the fingerprint. Applies verdict findings, re-fingerprints,
   re-verdicts until approve.
6. Worker reports to Isomux Manager: what changed, how verified, reviewer
   verdict, ALL added/edited prose quoted verbatim, anything parked.
7. Manager sanity-checks (reads code only where the summary looks thin),
   runs `bunx prettier --write` on touched files, commits ONE focused commit
   ("Implemented by IsomuxerN; reviewed by ReviewerN" + Co-Authored-By), ticks
   the checkbox, authors the next pickup folding in what this slice taught.

Never two slices in flight. Never start N+1 with N uncommitted.

## Gates per slice (always-run, exact commands)

- `bunx eslint <touched files>` - clean.
- `bun test > /tmp/slice-test.log 2>&1; echo exit=$?` - exit=0. NEVER pipe
  the run through tail/grep in the same command; redirect, echo $?, then read.
- `bun run build:ui > /tmp/slice-build.log 2>&1; echo exit=$?` - exit=0.
- Slices with server behavior: isolated-instance smoke - boot with
  `ISOMUX_HOME=$(mktemp -d) PORT=141xx bun server/isomux-office.ts`, drive the
  new API with curl, judge by API responses and state files on disk (the
  evidence surface), kill the instance, rm the temp dir.
- New/changed tests must FAIL when the feature is reverted (mutation-check the
  test, at least mentally; state how you know in the report).

Manager-only, before any live-office restart: full `bun run ci` green AND the
isolated boot smoke green AND a wake-up message scheduled to self (~2 min out).
Restart authorization for tonight granted by Nil (2026-08-06, this session).

## Standing rails (prohibitions)

- NEVER touch the live office state (`~/.isomux`) or the live service from
  tests or dev runs. Isolated instances only: own PORT + mktemp ISOMUX_HOME.
- Workers never restart the isomux service. Only the manager does, per above.
- No `git push`. No commits by workers - the manager commits each slice.
- Test systemd units are named `isomux-app-test-*` and are stopped, disabled,
  and removed before the slice closes. No unit created by testing survives.
- Never weaken or skip a gate to pass. A gate failure is fixed in-slice or the
  slice stops and the blocker is queued.
- Do not relitigate Nil's rulings: shelf (no ecosystem provisions), no
  human-approval click on registration, no app cap beyond a generous sanity
  constant, systemd user units (not a hand-rolled supervisor), agents never
  write unit files.
- No new dependencies without queueing for Nil.
- Scope fence: policy or API-surface choices not covered by the design doc or
  this file go to the manager, not into code.

## Decision protocol

- Worker + reviewer settle: implementation details, exact validation rules,
  state-file shape, test strategy.
- Manager settles: route naming, port range, slice scope calls, anything the
  worker+reviewer deadlock on.
- PARKED FOR NIL (morning report, never decided in-loop): final wording
  sign-off on all prose (docs, UI strings, system-prompt copy), anything
  expanding the API surface beyond the design doc, merge-visible product
  behavior not in the doc, push, deploy beyond tonight's test restarts.

## Slice plan

- [x] S1  Registry core: data model, persistence, port allocation, name
         validation + tombstones, per-app data dir, agent HTTP API
         (register/list/get/delete), tests. No systemd yet.
         (Isomuxer2/Reviewer2, 3 review rounds, committed with this edit.)
- [x] S2  Supervisor: unit generation, start/stop/enable, $PORT injection,
         journald log surfacing, restart counts, MemoryMax/CPUQuota, delete
         cleans up fully. Live-office restart checkpoint after commit.
         (Isomuxer2/Reviewer2, 6 rounds, approved 9de2672f, committed with
         this edit. Restart checkpoint deferred to after S2b/S2c commit.)
- [x] S2b PATCH /api/apps/:name (command/cwd/description; name+port
         immutable), unit regen + daemon-reload on change. Ruled by Nil via
         least-surprise delegation. Lane: Isomuxer2/Reviewer2, 3 rounds,
         approved 4b6dbcc3, committed with this edit. Run state preserved:
         running apps restart into the new command, stopped stay stopped.
- [ ] S2c Installer compat: system-unit VPS installs (deploy/install.sh
         service user) have no linger / XDG_RUNTIME_DIR, so systemctl --user
         cannot run. Enable linger + supply user-manager env, with deploy/
         tests. Found by Reviewer2 in the S2 diff-gate; mandatory for
         phase 1 (no box-specific features rule). Lane: Isomuxer3/Reviewer3.
         PARALLEL-PAIR EXCEPTION to the one-slice rail, manager-approved:
         S2b touches server/ + shared/, S2c touches deploy/ (+docs) - fully
         disjoint files, separate reviewers, separate commits, both from the
         S2 commit baseline. Any overlap discovered -> S2c yields and waits.
         S2c DONE first (Isomuxer3/Reviewer3, 1 round, no findings, approved
         21b4b3ae, committed while S2b still in flight). Linger-only cold-
         boot case unproven until a real VPS install - rides task 5a8e4b08.
- [x] S3  Apps tab UI beside Cronjobs + WS sync: list, state, restart count,
         logs, stop/delete. Restart checkpoint.
         (Isomuxer3/Reviewer3, 3 rounds, approved 5625d69b, committed with
         this edit. Fetch-on-open + 5s single-flight poll while open;
         recipient-scoped app_upserted/app_deleted deltas; hydrationEpoch
         refetch. Screenshots under /tmp/s3-shots/.)
- [x] S4  Conventions + docs: system-prompt guidance replaces "pick an
         uncommon port", ROUTE_LABELS entries, doc surfaces per
         internal-docs/documentation.md.
         (Isomuxer2/Reviewer2, 2 rounds, approved 041e4666, committed with
         this edit. External-repo surfaces of documentation.md §6-11 parked;
         humanizeIsomuxRequest apps arm parked as cheap follow-up.)
- [x] S5  (stretch) App tokens: hashed persistence per tokens.ts secrecy rule,
         injected as ISOMUX_APP_TOKEN.
         (Isomuxer3/Reviewer3, 4 rounds, approved 016ec33c, committed with
         this edit. APP scope authorizes NOTHING yet - whole-table test pins
         it; S6 edits that test deliberately. Boot reconciliation self-heals
         token/unit pairs. Found+fixed in-slice: app tokens would have
         inherited owner room access via hasRoomAccess.)
- [x] S6  (stretch) App-to-agent messaging: scoped capability, rate limit +
         daily cap constants, non-authority labelling.
         (Isomuxer3/Reviewer3, 2 rounds, approved 69ddc073 pre-format /
         9f950b42 post-prettier formatting-only delta, committed with this
         edit. One route POST /api/app/message, app scope only; 5/min burst
         + 50/rolling-24h daily, day spent only on accepted delivery;
         [App "name"] labelling end to end incl. boot replay.)

## LOOP COMPLETE (2026-08-06, ~06:00 PT)

All six slices plus S2b/S2c landed: phase 1 AND phase 2 of
agent-apps-design.md are committed, gated, adversarially reviewed, and (as
of the final restart) live. Every slice: worker-implemented,
counterpart-reviewed on announced fingerprints, mutation-checked, committed
by the manager. Nothing pushed. Morning items: Nil's copy sign-off (S4 + S6
prose), the parked queue above, board flip of f86bb897 + phase-3 follow-up
task. This file can be archived or deleted once the morning pass is done.

## Deferred / parked

- Phase 3 (stable hostnames on the port-proxy transport) - hosted infra
  dependency, not tonight.
- Update story for apps (design doc open question) - not tonight.
- Doc nit from S3 round 3 (Reviewer3 said fix in a future pass, not the
  frozen diff): shouldCommit docstring still lists "unmount" as a
  generation example and one test label says "(unmount, delete)" - leftovers
  from removing the unmount bump. Runtime logic correct.
- Morning options for Nil from S3: register-from-UI / edit-from-UI forms;
  whether the port stays plain text (honest on hosted where ports are
  unreachable) or becomes a link on tailnet boxes.
- PARKED FOR NIL (from S5): (1) the app token env file is the FIRST raw
  credential isomux persists, and backup.ts tars the whole state root - so
  backups now contain live app tokens. Mitigation available if wanted:
  exclude apps/units from the backup; boot reconciliation already self-heals
  and would rotate on restore. (2) rotation-on-demand route: deferred, needs
  his sign-off as new API surface. (3) restated honestly: apps share one
  Unix account - the token carries scope, not secrecy from sibling apps.
- PARKED FOR NIL: none open from phase 1. Mid-loop rulings (Nil, 2026-08-06, from phone):
  restart/start/stop routes confirmed; remaining calls delegated to the
  manager under "whatever behavior is less surprising to our users",
  resolved as:
  - DELETE keeps the per-app data dir (uninstall-keeps-documents; silent
    destruction is the surprising branch).
  - Visibility stays owner + office owner (matches the adjacent Cronjobs
    tab; widening later surprises nobody, narrowing would).
  - Update verb WILL exist: PATCH /api/apps/:name for command/cwd/
    description, name and port immutable ("a typo burns the name forever"
    is maximal surprise). Built as a small S2b step after S2 lands, with
    the same gates - not mid-S2.

## Resources

- Design: `internal-docs/agent-apps-design.md` (rulings inside are final),
  `internal-docs/port-proxy-design.md` (transport it will one day ride).
- Precedent for "a thing isomux runs that is not an agent": cronjobs -
  `server/cronjob-manager.ts`, `server/cronjob-persistence.ts`, Cronjobs tab
  in `ui/`.
- Token model (S5): `server/identity/tokens.ts`.
- State-dir isolation: `server/config.ts` (ISOMUX_HOME, read before import);
  listen port: env PORT (server/isomux-office.ts ~4784).
- Agent-facing route cards: `ui/log-view/isomux-curl.ts` ROUTE_LABELS (S4).
- Doc surfaces checklist: `internal-docs/documentation.md`.
- Testing patterns: `internal-docs/testing-guide.md`.
- Portless prior-art notes: `/tmp/portless-lessons.md` (flag-injection table
  for S2; reference only, Apache-2.0, borrow with attribution).
- Baseline: commit b0b5afa; `bun run ci` green (log: /tmp/ci-baseline.log);
  systemd user-unit round-trip probed OK; Bun + systemd versions as on auntie.

## SLICE-1 PICKUP (authored 2026-08-06, baseline b0b5afa)

Goal: the registry exists and is drivable end-to-end by curl against an
isolated instance - register, list, get, delete - with allocation, validation,
persistence, and tests. Nothing runs yet; `state` is `registered`.

Load-bearing mechanics and traps:
- All paths through `server/config.ts` helpers so ISOMUX_HOME redirection
  works; never hardcode `~/.isomux`.
- Name is a future hostname label: lowercase `[a-z0-9]([a-z0-9-]*[a-z0-9])?`,
  max 63 chars, plus a reserved list (at least: www, api, apps, office,
  isomux, admin, mail, smtp, ns1, ns2). Reviewer may extend.
- Deleting an app tombstones its name AND its port (design doc section 4:
  never recycle a hostname; a freed port under a stale bookmark is the same
  trap). Tombstones persist.
- Port allocation: contiguous range, pick the lowest free, skip tombstoned;
  range chosen to avoid common dev defaults (3000, 5173, 8080...) and the
  office's own 4000. Propose the range in the plan-gate.
- Per-app data dir created at registration, path returned to the agent.
- Sanity constant on registered apps, generous (order of 100), plain named
  constant, no env var.
- Ownership: app belongs to the registering agent's manager (user); registering
  agent recorded as attribution + default message target (S6 uses it).
- API: follow the existing agent-route auth pattern (bearer token). Humans
  (UI session auth) get the same reads in S3 - shape the handlers so that
  works. Register/delete from the UI side is also allowed (agents-can-do-what-
  humans-can-do cuts both ways) but S3 wires it.
- Start command + cwd are stored verbatim in S1; validation of runnability is
  S2's problem. Do validate cwd is an absolute path that exists.
- Tests: registry unit tests with tmp ISOMUX_HOME (persistence round-trip,
  allocation, tombstones, validation, delete) + route tests per the existing
  server test patterns in testing-guide.md.

Acceptance:
- Isolated-instance curl demo transcript in the report (register -> list ->
  get -> delete -> re-register same name REJECTED with a clear error).
- All always-run gates green; reviewer approve on the final fingerprint.

Decide with reviewer: state-file layout (one apps.json vs per-app files -
look at how agents/cronjobs persist and stay consistent with house style),
error-shape of API responses (match existing routes), exact port range.

Locked: everything in Standing rails; route base path `/api/apps`.

## SLICE-2 PICKUP (authored after S1's commit; baseline = that commit)

What S1 taught (real, from its report):
- `server/app-registry.ts`: pure helpers + injectable
  `createAppRegistry({dir, now, probePort})`, production singleton over
  `STATE_ROOT/apps`. State: `apps.json` + `app-history.json` (tombstones) +
  `data/<name>/`. Nothing derived is persisted: no `state`, no `dataDir`
  (derived from root + name). Corruption fails CLOSED - every operation
  refuses on an unreadable/inconsistent view; do not weaken this in S2.
- Port window 21000-21999 is LOAD-BEARING (records validated against it on
  load); changing it is a migration. Registration currently returns
  `state: "registered"` hardcoded; S2 makes state real.
- `server/routes/handlers/apps.ts` has an exhaustive AppErrorCode -> HTTP
  table (new code without a status fails to compile). Guard:
  `appOwnerOrOfficeOwner`; `app:read`/`app:write` are baseline agent caps.
- Test shapes to extend: `server/app-registry.test.ts` (50 tests),
  `server/test-support/routes-apps-rest.test.ts` (13, real HTTP + real
  minted tokens). Mutation-check new tests and SAY SO in the report.

Goal: registered apps actually run. Register writes + starts + enables an
`isomux-app-<name>.service` user unit; delete stops, disables, removes the
unit (daemon-reload), keeping S1's tombstone semantics; registry reads return
real state (running/failed/stopped + restart count); recent logs reachable
via the API from journald. An app keeps running across an isomux restart with
nothing re-injected.

Load-bearing mechanics and traps:
- THE ISOLATION HAZARD (rail, non-negotiable): systemd is machine-global.
  An isolated instance (tmp ISOMUX_HOME) or a test must NEVER create, touch,
  or list-manage the production `isomux-app-<name>` namespace. Put every
  systemctl/journalctl/unit-file operation behind ONE injectable seam
  (testing-guide.md seam-map style): unit tests use a fake; the ONE gated
  live-systemd test uses `isomux-app-test-*` names with cleanup that runs
  even on failure. How the isolated-instance demo avoids the production
  prefix is a decide-with-reviewer design point - no env-var knob unless
  genuinely unavoidable (Nil's rule), prefer deriving from injected deps.
- Unit content: ExecStart from stored command, WorkingDirectory from cwd,
  Environment=PORT=<port> + ISOMUX_APP_DATA_DIR=<data dir>,
  Restart=on-failure, MemoryMax + CPUQuota as plain named constants.
- systemd env is MINIMAL - `bun run dev` style commands need PATH (portless
  walked node_modules/.bin up from cwd; see /tmp/portless-lessons.md §3).
  Decide the PATH story with the reviewer and state it in the report.
- daemon-reload after unit file writes/removals. Verify linger for
  reboot-survival of user units (loginctl show-user); report the finding -
  it feeds the hosted story.
- State reads: never shell out per app per read; cache/TTL or interval
  refresh, reviewer call. Health note from portless: a listening port is
  not app identity.
- Flag injection beyond $PORT (portless framework table): nice-to-have; if
  it exceeds ~30 lines of table+plumbing, park it for Nil instead.
- Journald: last N lines per app behind the same seam; S3 consumes it.

Acceptance:
- Isolated-instance demo transcript: register a tiny real server (e.g. a
  bun one-liner), curl it on its allocated port, kill its process and show
  the restart count rise, delete and show `systemctl --user list-units
  'isomux-app-*'` untouched by the whole run (isolation hazard proven) and
  the test-prefix units gone.
- Gated live-systemd test green; unit-file generation golden-file tests;
  always-run gates green; reviewer approve on final fingerprint; explicit
  cleanup proof (no stray units).

Decide with reviewer: state-refresh mechanism, unit template contents,
resource-limit constants, PATH story, isolated-demo prefix mechanism.

Locked: systemd user units (no hand-rolled supervisor), unit naming
`isomux-app-<name>` in production, S1's corruption posture and port window,
everything in Standing rails.

## SLICE-2b PICKUP (authored after S2's commit; baseline = that commit)

What S2 taught (real, from its report): `server/app-supervisor.ts` is the ONE
seam over systemd (SupervisorHost interface; fake in
`server/test-support/fake-app-supervisor.ts`, injected by the harness by
default with no way to request the real one). The start command never enters
ExecStart - a generated launcher script (0600, atomic write with mode) holds
it verbatim. Unit namespace derives from the state root (`isomux-app-<name>`
only for the default root; any other root gets `isomux-app-test-.<sha256>-`,
and the `.` is unreachable from valid app names). reset-failed precedes every
start/restart or a start-limited unit refuses recovery. startError is
in-memory only. Unit template: PORT / ISOMUX_APP_NAME / ISOMUX_APP_DATA_DIR /
PATH, Restart=on-failure, RestartSec=2, StartLimitIntervalSec=60 +
StartLimitBurst=5, MemoryMax=512M, CPUQuota=100%, TimeoutStopSec=10.

Goal: `PATCH /api/apps/:name` - update command, cwd, description (any
subset). Name and port stay immutable (they are the identity and the
tombstone contract). This is the verb that stops a mistyped command from
burning a hostname forever.

Load-bearing mechanics and traps:
- Validation identical to register (command length, cwd absolute + exists,
  description length). Same error codes where they apply; new prose quoted
  verbatim in the report.
- On command/cwd change for an app whose unit is installed: rewrite launcher
  + unit, daemon-reload, and PRESERVE the run state - a running app is
  restarted into the new command; a stopped app stays stopped with the new
  files in place; a failed app stays failed until an explicit recovery verb
  (decide exact semantics with reviewer, but least-surprise rules: never
  silently start something the user had stopped).
- Description-only change must NOT touch systemd at all.
- Registry write and unit rewrite ordering: follow S2's pattern (the
  registry is the source of truth; a half-finished update must be
  recoverable; mutation-check the ordering).
- Wire: 200 with the full updated AppWire (truthful state, startError if the
  restart tripped it).
- Guard: appOwnerOrOfficeOwner, cap app:write, opId apps.update, no emits.
- Tests: registry/service unit tests + REST tests in the existing suites;
  golden unit regen; mutation-check and say so.

Acceptance: isolated-instance demo (register running app -> PATCH command ->
still running with new behavior; PATCH on stopped app -> stays stopped;
description-only PATCH -> no systemd calls (prove via fake-host call log));
always-run gates + test:systemd green; reviewer approve on final
fingerprint; announced-fingerprint protocol (one at a time, no crossings).

Locked: name/port immutability, S2's seam (no new systemd call sites outside
SupervisorHost), everything in Standing rails.

## SLICE-2c PICKUP (authored after S2's commit; baseline = that commit)

Origin: Reviewer2's S2 diff-gate finding, accepted by manager ruling. The
shipped VPS installer (`deploy/install.sh`) runs isomux as a SYSTEM unit
under an unprivileged service user with no linger and no XDG_RUNTIME_DIR, an
environment where `systemctl --user` cannot function at all - so S2's app
supervisor works on a tailnet box like auntie (linger on) and cannot start
apps on an installer-built VPS.

Goal: an installer-built box can run the app supervisor. Keep Nil's locked
user-unit transport; fix the environment the installer provides.

Load-bearing mechanics and traps:
- `loginctl enable-linger <service user>` in install.sh (idempotent), which
  starts and keeps `user@<uid>.service` - the user manager - alive.
- The isomux process itself needs XDG_RUNTIME_DIR=/run/user/<uid> (and
  whatever bus address systemctl --user needs) in its SYSTEM unit
  environment to reach that user manager. Verify empirically what the
  minimum is: probe on auntie with a scrubbed env
  (`env -i XDG_RUNTIME_DIR=... systemctl --user is-active isomux`) rather
  than trusting documentation.
- EXISTING installs must converge too, not just fresh ones (standing rule:
  no manual recurring ops): the update path (scripts/update.sh /
  release-design.md) or the service unit itself must apply the same fix on
  update. Check internal-docs/release-design.md consistency; this repo
  ships to external self-hosters, so everything stays generic and
  backward compatible.
- Tests: deploy/install-sh.test.ts pins installer content - extend it. Do
  NOT weaken existing pins.
- Full end-to-end VPS validation is NOT tonight's acceptance: it rides the
  existing test-box reinstall task (5a8e4b08, morning follow-up). Say so in
  the report rather than overclaiming.
- Touch ONLY deploy/ + scripts/ + docs. If you find yourself needing to
  edit server/ or shared/, STOP and message the manager (S2b owns those
  files tonight).

Acceptance: install-sh tests green; scrubbed-env probe transcript on auntie
proving the env recipe works; always-run gates green; reviewer approve on
final announced fingerprint; report states exactly what remains unproven
until a real VPS install (and that 5a8e4b08 covers it).

Locked: user-unit transport (no system-unit apps, no root), installer stays
generic (no auntie-only or Hetzner-only branches), everything in Standing
rails.

## SLICE-3 PICKUP (authored after S2b's commit; baseline = that commit)

What S2/S2b left for the UI (real, from their reports): every apps route
declares `emits: []` today - no WS event exists, so a second browser tab
never live-updates; S3 owns that wiring. AppWire: name, port, command, cwd,
description?, userId, username, createdBy, createdAt, dataDir, state
(running|starting|stopped|failed|unknown), restartCount, startError?.
startError is IN-MEMORY only and vanishes on isomux restart - show it when
present, but its absence proves nothing; `state` is the durable signal.
Server-side app state is cached with a 1500ms TTL behind the supervisor
seam, so reads are cheap but not free - the tab still should not hammer.
Verbs that exist: POST /api/apps/:name/{start,stop,restart}, DELETE,
PATCH (apps.update), GET /api/apps/:name/logs?lines=N.

Goal: the Apps tab, beside Cronjobs, per the design doc surface: list with
name, state, restart count, port, description, attribution; a logs view;
start/stop/restart/delete actions; live-updating via WS. Visibility follows
the ruled shape: own apps + office owner sees all.

Load-bearing mechanics and traps:
- Follow the Cronjobs tab as the structural precedent (route, store slice,
  view component, WS flow). Add the WS event the routes now lack and make
  the handlers emit it; decide with reviewer whether apps ride full_state
  replay or fetch-on-view like cron run transcripts.
- RECONNECT LESSON (room memory, Isomuxer4 2026-08-05): ui/ws.ts onVisible()
  can reconnect WITHOUT the store's `connected` flag ever flipping false, so
  any effect keyed on a false->true edge silently never re-runs. If the view
  caches anything full_state drops, key the refetch on a hydration counter
  bumped in the full_state reducer, not on `connected`.
- Delete is PERMANENT (name retired forever) - the confirm affordance must
  say so plainly. No approval gates on anything else (Nil's ruling).
- iOS RULE (room memory): Safari emoji-renders glyphs like the black
  triangles, overriding CSS color - no raw play/star glyphs on mobile
  surfaces; use SVG or gate behind !mobile.
- Register-from-UI form and edit-from-UI: NOT tonight; the tab is a viewer
  plus verbs. Park both as morning options for Nil.
- Visual verification per room recipes: demo bundle built WITHOUT
  --splitting, demoApi needs an arm for EVERY new endpoint it touches,
  serve a /tmp copy over http (file:// dies on CORS), drive with
  playwright-core + channel:"chrome" (no browser download), and use
  Emulation.setDeviceMetricsOverride for exact viewports. Delete harness
  files before the fingerprint. Screenshots (desktop + mobile) saved under
  /tmp for the morning report - list their paths in your report.
- Server files are yours too this slice (events + full_state + emits) - no
  parallel lane is running.

Acceptance: screenshots showing the tab with real-shaped data (list, logs,
a failed app with startError, mobile viewport); demo-driven verb clicks
proven (fake-supervisor-backed isolated instance or demo bundle); always-run
gates + test:systemd green (server files change); reviewer approve on final
announced fingerprint; ALL UI strings quoted verbatim in the report.

Locked: visibility shape (own + office owner), delete-retires-name wording
must be truthful, S2's seam (no new systemd call sites), Standing rails.

## SLICE-4 PICKUP (authored after S3's commit; baseline = that commit)

The feature is built (S1-S3 + S2b/S2c); S4 makes agents and docs know it
exists. Pure copy + labels - no behavior changes. Everything you write is
wordsmithed prose Nil signs off in the morning: quote ALL of it verbatim in
your report, and draft SHORT - Nil strips the obvious parts of any draft
(room memory: "notice the pattern, I always remove the obvious parts").

Scope, in order of importance:
1. server/system-prompt.ts - replace the "pick an uncommon port and keep
   it" guidance with the register-an-app flow: register (name, command,
   cwd) via POST /api/apps with your bearer token; isomux allocates $PORT,
   runs it as a service that survives sessions, isomux restarts and
   reboots; PATCH to fix command/cwd; start/stop/restart/logs verbs;
   delete retires the name FOREVER (say it); data dir provided; the Apps
   tab shows it to the boss. Mention what apps are for (something the boss
   uses, not scratch experiments). Keep the existing per-engine structure
   (claude vs codex arms) in mind - guidance for all isomux deployments
   belongs here, not in office memory (room-memory rule).
2. ROUTE_LABELS in ui/log-view/isomux-curl.ts - friendly cards for ALL
   apps routes: register/list/get/patch/delete/start/stop/restart/logs
   (the 2026-07-18 lesson: new agent-facing routes fall back to raw JSON
   cards without this).
3. Doc surfaces per internal-docs/documentation.md (read it - it is the
   authoritative list; expect at least README features, docs/features.md,
   api/chat.ts chatbot list). MARKETING RULES (room memory): describe by
   user capability, never internal mechanism (no endpoints, no systemd, no
   port numbers); no "single/simple/lightweight" small-signaling words; no
   edge-case caveat clauses.
4. docs/vps-install.md "What it does": S2c deferred its linger bullet here
   deliberately - now the feature is visible, add it if documentation.md
   says that surface needs it; keep it capability-level.
5. AGENTS.md if documentation.md lists it (S2b noted it has no apps
   mention at all).

Gates: always-run set (bun test, build:ui, eslint on touched files; tsc if
any ts changes). test:systemd only if server files change. Same
announced-fingerprint diff-gate with your reviewer.

Locked: no behavior changes, no new routes, rulings stand, Standing rails.

## SLICE-5 PICKUP (stretch; authored after S4's commit; baseline = that commit)

Phase 1 is landed and live; Nil's condition for phase 2 ("if phase 1 is
ready and solid, feel free to continue") is met. S5 is the first phase-2
slice: app tokens. S6 (the messaging route they authorize) follows only if
S5 lands clean; S5 alone must be inert-but-harmless (a minted token whose
capabilities S6 defines is fine; nothing may widen).

Goal: every registered app gets a scoped token, injected as
ISOMUX_APP_TOKEN, that SURVIVES an isomux restart - the first token scope
that must, since apps outlive the isomux process (design doc section 5).

Load-bearing mechanics and traps:
- Read server/identity/tokens.ts FIRST: the secrecy rule (hashed at rest)
  is stated there and the design doc names it as the constraint. Plaintext
  exists only at mint time, injected into the app's environment; isomux
  persists only the hash.
- Identity: a new APP scope in the identity model with capabilities
  defined but EMPTY-of-routes until S6 (mirror how CRON-RUN scope denies
  app routes today). An app token must NOT pass agent guards anywhere -
  extend the routes-table contract tests that pin capability sets.
- Injection point: the launcher script (0600) is where secrets already
  live; the unit file is not. BUT be honest about the boundary (S2c's doc
  paragraph): every app runs as the same Unix account, so cross-app secret
  isolation is not enforceable at this layer - the token's value is its
  narrow SCOPE, not its secrecy from sibling apps. State this in code
  comments and the report, don't oversell.
- Lifecycle: mint at register, re-inject on reinstall (PATCH), revoke +
  delete hash on app delete. Restart of isomux must NOT rotate tokens (that
  would need unit rewrites - the exact thing persistence exists to avoid).
  Decide rotation-on-demand (POST .../rotate-token?) with me BEFORE
  building it - it is new API surface.
- Registry stores the hash alongside the app record (or sibling file -
  match house style with reviewer); corruption posture: fail-closed like
  everything else, but a missing hash for an existing app must not brick
  the app - define and test the degraded behavior.
- Tests: identity guard matrix, persistence round-trip, launcher content
  (golden), reinstall preserves token, delete revokes. Mutation-check.
- test:systemd extended or verified still green (launcher changes).

Acceptance: isolated-instance demo - register app, its env carries a token,
isomux restarted (isolated instance only!), token still valid (hash
verifies), PATCH preserves it, delete revokes it; gates green; reviewer
approve on announced fingerprint; all new strings verbatim.

Locked: hashed-at-rest, no new agent-facing routes without manager signoff,
S6 defines what the token can DO, Standing rails.

## SLICE-6 PICKUP (stretch; authored after S5's commit; baseline = that commit)

What S5 taught (real, from its report): TokenScope "app" exists with
APP_CAPABILITIES = [] and a whole-table reachability test asserting NO route
authorizes an app identity - S6's one deliberate breakage is editing that
test to open exactly one route. Token resolution rides auth-middleware's
resolveToken ?? appIdentityFromToken; Identity.appName carries the app;
identity.userId is the owner (truthful, never authority). S5 deferred to S6:
the registry-existence check on token resolution (the messaging route must
load the app record anyway). EnvironmentFile is not quote-parsed; unit files
land 0664; `systemctl show` never prints EnvironmentFile values.

Goal: close the loop - an app can message the agent that built it. One new
route, authorized ONLY by app scope, rate-limited, clearly labelled as
non-authority. Plus the ISOMUX_APP_TOKEN prose that S5 deliberately left
unwritten (an env var that authorizes nothing was not worth documenting;
now it is).

Load-bearing mechanics and traps:
- Route shape: the token IS the app - no :name param to trust. Something
  like POST /api/app/message (manager has pre-approved exactly ONE route;
  final path is a decide-with-reviewer, announce in the plan-gate). Body:
  {text}. New capability e.g. app:message, added to APP_CAPABILITIES only.
- Target: the registry's creating agent. If that agent no longer exists,
  fail with a clear, actionable error (retargeting is future work - park
  it). Reuse the existing agent-message delivery path (queued vs immediate)
  rather than inventing one.
- LABELLING: the receiving agent must see app-origin messages as
  non-authority, the same rule the system prompt states for agent-to-agent
  messages - e.g. a distinct prefix carrying the app name. Wording is
  Nil-signoff material: quote it verbatim.
- RATE LIMIT: messages wake agents and burn model tokens (design section
  5: "an app in a loop is a bill"). Per-app limit + daily cap, plain named
  constants (no env vars), 429 with a message that tells the app WHEN to
  retry. Persist enough to survive a restart honestly or state plainly
  that limits reset on restart - decide with reviewer, don't pretend.
- Registry-existence check on token resolution lands here (a token whose
  app record is gone resolves to nothing).
- PROSE (all verbatim in report): system-prompt addition telling agents
  their apps can message them back via ISOMUX_APP_TOKEN + how to wire it;
  keep it SHORT (Nil strips the obvious). Whether any doc surface mentions
  it: check documentation.md, capability-level only.
- Tests: the deliberate whole-table edit (one route, app scope only);
  rate-limit matrix; dead-agent path; delivery labelling; mutation-check.

Acceptance: isolated-instance demo - registered app POSTs with its token,
the owning agent's queue shows the labelled message; second POST past the
limit gets 429; deleted app's token gets 401; gates + test:systemd green;
reviewer approve on announced fingerprint.

Locked: ONE route, app scope only, APP_CAPABILITIES grows by exactly one,
no UI work (tab surfacing of caps/limits parked), Standing rails.
