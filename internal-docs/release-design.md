# Isomux release channel

> Status: design only (2026-07-19). Slice C1 of hosted isomux (task
> c91af4a4), see `hosted-isomux-design.md`. Nothing here is implemented.

## What a release is

A **CalVer git tag on the GitHub repo**: `v2026.7.19` (append `.2` for a
second tag the same day). SemVer would be noise - no library consumers, no
API-compat contract to encode - and CalVer makes a customer box's staleness
readable at a glance. Tags are annotated, and each gets a GitHub Release
with auto-generated notes.

No build artifacts. A customer box builds the UI itself (`bun run
build:ui`) and pins deps via the committed lockfile
(`bun install --frozen-lockfile`), so a tag plus a pinned Bun version fully
determines the deployment. Bun must be pinned in CI too, or the release
gate tests a different runtime than customer boxes run.

**Gates.** CI already runs format, lint, tsc, the full test suite, and the
UI build on every push to main (`.github/workflows/build.yml`). Tagging
adds two manual conditions:

1. The commit has been serving Nil's own office for ~a day (dogfooding is
   the smoke test - it exercises real agents, restarts, and the UI in a way
   no scripted check would).
2. Nil or a delegated agent runs a small `scripts/release.sh` that verifies
   CI is green for the commit, refuses to reuse an existing tag, tags
   (annotated), and pushes the tag.

Cadence: on demand, when hosted boxes need something.

## Installer contract

`ISOMUX_REF` is a tag name; the installer runs
`git clone --depth 1 --branch $ISOMUX_REF`. When unset, it resolves the
default from `GET api.github.com/repos/nmamano/isomux/releases/latest`
(public, unauthenticated) - no moving `stable` branch to maintain.

## Update path on a customer box

A `scripts/update.sh` committed in the repo (so each release ships updater
fixes), but always **executed as a copy** at a stable installer-owned path:
step 2 replaces the checkout under the script, and shells read scripts
incrementally, so running it in place can splice old and new updater logic
mid-flight. Its config (repo path, service name, state root, backup
destination, Bun path) comes from a root-of-trust file written by the
installer, never from the caller. It accepts only an exact CalVer tag,
resolves it to a commit, and refuses downgrades unless explicitly flagged.

It must run **outside the server process** - it restarts the server, which
would kill any in-server parent. The in-UI trigger spawns it as a transient
systemd user *service* (`systemd-run --user`, its own unit, not ordered
against `isomux.service`; user lingering is already an installer
requirement), takes a `flock` so triggers cannot overlap, and returns the
unit name to the UI immediately. Progress and result are written to a
status file **outside** `$ISOMUX_HOME`, because rollback may replace that
directory.

1. Record the currently checked-out tag.
2. `git fetch --tags && git checkout <target>`.
3. `bun install --frozen-lockfile`, `bun run build:ui`. On failure, the
   running server process is untouched, but `node_modules` and the
   live-served `ui/dist` may already be dirty: recover by checking out the
   old tag, reinstalling its lockfile, and rebuilding its UI (and report if
   recovery itself fails).
4. `systemctl --user stop isomux`, wait until inactive. The update
   interrupts agents anyway; quiescing *before* the snapshot is what makes
   it a coherent rollback image (a live tar can catch related state files
   on opposite sides of a mutation - fine for disaster recovery, not for a
   rollback promise).
5. Snapshot the stopped state: tar `$ISOMUX_HOME` to a uniquely-named file
   outside it and verify the tarball. If this fails, check out the old tag,
   reinstall, rebuild the old UI, and start it - state is untouched, but
   the target's UI was already built in step 3.
6. `systemctl --user start isomux`; poll a readiness endpoint (up *after*
   migrations, since those rewrite state on boot) for ~60s.
7. On failed readiness, roll back fully: stop and wait inactive (never
   restore under a live or crash-looping process), restore the entire state
   root from the step-5 snapshot, check out the previous tag, reinstall,
   build, start, report failure upstream.

Rollback always restores the full snapshot - no "did a migration run?"
detection. The codebase has no schema version or migration ledger to make
that call reliably (migrations are ad-hoc and lazy), and the snapshot is
taken with the server stopped, so unconditional restore loses nothing and
removes the hardest-to-test branch. A durable schema version can refine
this later.

**Role of the daily backups** (`~/isomux-backups`, 7-day retention):
disaster recovery only. They are up to 24h stale and date-only-named; the
updater takes its own fresh snapshot.

## Update trigger: three options

The tension: a restart kills every in-flight agent turn. Queued and
scheduled messages survive, sessions resume - so the harm is interruption
and lost partial work, not data loss. The customer is best placed to judge
whether an interruption right now is acceptable.

**A. Operator-pushed.** Control plane rolls out to the fleet on our
schedule. Uniform fleet, security fixes land fast; but we restart into a
customer's running agents blind, and every rollout is our pager.

**B. Customer-clicked.** The isomux UI shows an "update available" banner;
the customer clicks when it suits them. Zero surprise, lowest ops load.
Cost: the fleet fragments across versions and stragglers linger.

**C. Automatic with maintenance window.** The box self-updates at a quiet
hour if no agent has run a turn recently. No clicks, but "quiet hour" is
shaky in an office with cronjobs and scheduled self-messages that
legitimately run at 4am, and it's the most machinery.

**Recommendation: B, with an operator override for security fixes.** The
server already tracks which agents are mid-turn, so the button can say
"update now (2 agents busy)" or offer "apply when idle". All three options
call the same `update.sh`; A and C are policy layers that can be added
later without redesign. For the initial influencer-comped fleet, B is also
the honest match for our support capacity.

## Gaps in the current repo

- No version identity anywhere: `package.json` has no `version`, no
  constant in code, no `GET /version` endpoint. Without it there is no
  "update available" banner and no way for the control plane to audit the
  fleet.
- No readiness endpoint for the updater's post-restart check: unauth,
  minimal response, up only after migrations complete, rate-limited if
  exposed (with localhost polling exempt, so polling cannot manufacture a
  rollback).
- No snapshot primitive: `server/backup.ts` is private, timer-coupled, and
  date-only-named. Extract a shared "snapshot now" function or have
  `update.sh` tar directly.
- No `update.sh` / `release.sh`, and none of the updater plumbing: the
  owner-only authenticated trigger route, the singleton lock, status/result
  persistence, target validation, or tests for the failure paths (failed
  install, build, start, readiness, restore).
- Bun unpinned in both CI and the docs' install instructions.
- `backup.ts` references `internal-docs/backup-restore.md`, which does not
  exist. The restore procedure the rollback story leans on is undocumented.
- (Separate fix, main:) `hosted-isomux-design.md` says daily backups land
  in `~/.isomux/backups/`; they land in `~/isomux-backups`.
