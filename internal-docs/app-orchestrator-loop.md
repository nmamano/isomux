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
- [ ] S2b PATCH /api/apps/:name (command/cwd/description; name+port
         immutable), unit regen + daemon-reload on change. Ruled by Nil via
         least-surprise delegation. Lane: Isomuxer2/Reviewer2.
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
- [ ] S3  Apps tab UI beside Cronjobs + WS sync: list, state, restart count,
         logs, stop/delete. Restart checkpoint.
- [ ] S4  Conventions + docs: system-prompt guidance replaces "pick an
         uncommon port", ROUTE_LABELS entries, doc surfaces per
         internal-docs/documentation.md.
- [ ] S5  (stretch) App tokens: hashed persistence per tokens.ts secrecy rule,
         injected as ISOMUX_APP_TOKEN.
- [ ] S6  (stretch) App-to-agent messaging: scoped capability, rate limit +
         daily cap constants, non-authority labelling.

## Deferred / parked

- Phase 3 (stable hostnames on the port-proxy transport) - hosted infra
  dependency, not tonight.
- Update story for apps (design doc open question) - not tonight.
- PARKED FOR NIL: none open. Mid-loop rulings (Nil, 2026-08-06, from phone):
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
