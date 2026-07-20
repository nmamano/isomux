# Isomux release channel

> Status: designed 2026-07-19; the shell-drivable core is implemented (see
> "Status" at the bottom for what shipped vs. what remains). Slice C1 of
> hosted isomux (task c91af4a4), see `hosted-isomux-design.md`.

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
   the Build workflow itself is green for the commit (not merely "some
   check"), refuses to reuse an existing tag, refuses a bun-pin change
   since the previous release (see the invariant below), tags (annotated),
   and pushes the tag.

**Bun invariant.** Customer updaters warn - they do not switch runtimes -
when a release pins a different bun than the box runs, and rollback runs on
the installed bun. So until versioned side-by-side bun installs exist, a
release must pin the same bun as the previous release; `release.sh`
enforces this mechanically (`RELEASE_ALLOW_BUN_CHANGE=1` overrides, which
means a deliberate fleet plan).

Cadence: on demand, when hosted boxes need something.

## Installer contract

`ISOMUX_REF` is a tag name (the installer also accepts branches/commits for
dev use). When unset, it resolves the default from
`GET api.github.com/repos/nmamano/isomux/releases/latest` (public,
unauthenticated) - no moving `stable` branch to maintain.

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
would kill any in-server parent. Who runs it depends on the deployment, and
the config's `SERVICE_KIND` reconciles the two shapes:

- **VPS boxes (as installed by `deploy/install.sh`)**: a SYSTEM-level
  `isomux.service` under user `isomux`. The updater runs as root
  (`SERVICE_KIND=system`; git/bun steps drop to the service user, systemctl
  stays root). This slice: the operator runs `isomux-update <tag>` over
  SSH. Next slice: the in-UI trigger needs a narrow escalation, since the
  server is unprivileged - a root-owned `isomux-update@.service` template
  unit the `isomux` user may start (sudoers or polkit rule scoped to
  exactly that), detached so the restart can't kill its parent.
- **Dev-style boxes** (user-level service, like Nil's): `SERVICE_KIND=user`
  runs everything as the user with `systemctl --user`.

It takes a `flock` so invocations cannot overlap, and writes progress and
result to a status file **outside** `$ISOMUX_HOME`, because rollback may
replace that directory.

**Trust boundary (system deployments).** The service checkout and everything
in it are writable by the unprivileged service user, and agents run shell as
that user - so nothing root executes or installs may come from there.
Tag resolution and the installed-updater refresh go through a root-owned
bare repo (`$STATUS_DIR/trust.git`) that fetches `refs/tags/<target>`
straight from the configured `REPO_URL`: the remote is the only tag
authority (a tag planted in the service checkout is never consulted), the
non-forced tag fetch refuses a moved tag, and the service checkout is then
pinned to the trust-resolved commit hash. The installer sources the initial
updater copy the same way.

1. Record the currently checked-out tag.
2. Resolve the target through the trust repo (above), fetch the objects
   into the service checkout, and check out the trust-resolved commit.
3. `bun install --frozen-lockfile`, `bun run build:ui`. On failure, the
   running server process is untouched, but `node_modules` and the
   live-served `ui/dist` may already be dirty: recover by checking out the
   old tag, reinstalling its lockfile, and rebuilding its UI (and report if
   recovery itself fails).
4. Stop the service, wait until inactive. The update interrupts agents
   anyway; quiescing *before* the snapshot is what makes it a coherent
   rollback image (a live tar can catch related state files on opposite
   sides of a mutation - fine for disaster recovery, not for a rollback
   promise).
5. Snapshot the stopped state: tar `$ISOMUX_HOME` to a uniquely-named file
   outside it and verify the tarball. If this fails, check out the old tag,
   reinstall, rebuild the old UI, and start it - state is untouched, but
   the target's UI was already built in step 3.
6. Start the service; poll `GET /readyz` (unauth; answered only once the
   boot migrations have run, since the listener binds after them;
   rate-limited with loopback exempt so the poll cannot manufacture a
   rollback).
7. On failed readiness, roll back fully: stop and wait inactive (never
   restore under a live or crash-looping process), move the broken state
   root aside for forensics, restore the entire state root from the step-5
   snapshot, check out the previous tag, reinstall, build, start, report in
   the status file.

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

## Status

Shipped (the shell-drivable slice):

- Version identity, derived from git so nothing can drift from the tag:
  `server/version.ts` (exact tag / describe / commit) and authenticated
  `GET /api/version`.
- Unauth `GET /readyz` with the per-IP limiter (`server/ready-limiter.ts`),
  loopback exempt.
- `scripts/release.sh` (CI-green gate via check-runs, tag-reuse refusal,
  annotated CalVer tag, push, GitHub Release) and `scripts/update.sh`
  (everything above, snapshot via tar directly - no `backup.ts` coupling).
  Failure paths are exercised in `scripts/update-sh.test.ts` /
  `scripts/release-sh.test.ts` against sandboxed fixtures.
- Installer integration: `deploy/install.sh` writes
  `/etc/isomux/update.conf`, installs `isomux-update`, pins bun from
  `package.json` `"packageManager"` (CI pins the same via setup-bun's
  `bun-version-file`), and defaults `ISOMUX_REF` to the latest GitHub
  release. The `main` fallback is bootstrap-only: the official repo falls
  back solely on a genuine no-releases 404 and fails closed on
  transport/parse errors (a GitHub hiccup must not silently install
  un-gated main); forks stay lenient.

Remaining:

- The "update available" banner and the in-UI trigger route (owner-only,
  detached execution, the escalation unit on VPS boxes). Note the UI
  already shows a commit-level update indicator fed by
  `server/update-checker.ts` (HEAD vs. GitHub main tip) - a fact the
  original gap list missed; the banner slice should make it release-aware
  (compare `release` from `/api/version` against `releases/latest`)
  instead of adding a second checker.
- `internal-docs/backup-restore.md` (referenced by `backup.ts`) still does
  not exist; the daily-backup restore procedure is undocumented. The
  updater no longer depends on it (it snapshots and restores on its own),
  but operators do.
- First real release: run `scripts/release.sh` once, then flip the
  installer expectation that `releases/latest` 404s.
