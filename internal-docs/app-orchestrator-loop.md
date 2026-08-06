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

- [ ] S1  Registry core: data model, persistence, port allocation, name
         validation + tombstones, per-app data dir, agent HTTP API
         (register/list/get/delete), tests. No systemd yet.
- [ ] S2  Supervisor: unit generation, start/stop/enable, $PORT injection,
         journald log surfacing, restart counts, MemoryMax/CPUQuota, delete
         cleans up fully. Live-office restart checkpoint after commit.
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
- PARKED FOR NIL: (queue grows during the loop; empty at kickoff)

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

(SLICE-2 PICKUP is authored after S1 commits, folding in what S1 taught.)
