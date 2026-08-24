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

**Gates.** CI already runs format, lint, tsc, the full test suite, the
UI build, and the control-plane web app's build/typecheck/lint on every
push to main (`.github/workflows/build.yml`). Tagging
adds two manual conditions:

1. The commit has been serving Nil's own office for ~a day (dogfooding is
   the smoke test - it exercises real agents, restarts, and the UI in a way
   no scripted check would).
2. Nil or a delegated agent runs a small `scripts/release.sh` that verifies
   the Build workflow itself is green for the commit (not merely "some
   check"), refuses to reuse an existing tag, refuses a bun-pin change
   since the previous release (see the invariant below), tags (annotated),
   and pushes the tag. The script prints the path of a timestamped log and
   tees its complete release and pre-push output there.

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
  stays root). The operator runs `isomux-update <tag>` over SSH, or the
  owner clicks the in-UI trigger, which needs a narrow escalation since the
  server is unprivileged: a root-owned `isomux-update@.service` template
  unit the `isomux` user may start, granted by a polkit rule scoped to
  exactly that unit pattern and the start verb (polkit, not sudoers:
  sudoers matches arguments with globs where `*` also matches spaces, so a
  tag wildcard would additionally authorize arbitrary extra unit names on
  the same systemctl call). Detached so the restart can't kill its parent.
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
2. Resolve the target through the trust repo (above) and fetch the objects
   into the service checkout. Record the tag there too
   (`update-ref refs/tags/<tag>` at the trust-resolved commit): a bare
   `git fetch <url> refs/tags/<tag>` only moves `FETCH_HEAD`, and
   `server/version.ts` identifies the running release with
   `git tag --points-at HEAD`, so without it an updated box reports a bare sha
   and the banner keeps offering the release it already runs. Written before
   the already-on-target exit, so re-running the updater with the tag a box is
   on repairs a checkout updated before this existed.

   That missing-tag repair restarts the unchanged checkout so the process reads
   the repaired tag. If its first start fails after the stop succeeds, recovery
   restores the provisional tag first and then tries one guarded start. The
   order makes the new process agree with the checkout. Readiness decides
   whether the office recovered. A failed second start or readiness poll reports
   that the office is down and needs manual attention. A readiness failure after
   a successful first start only restores the tag; a retry enters this repair
   arm again and makes the tag and process agree.
2b. Then, still before the checkout, install the system dependencies the
   target needs by
   running THAT release's `deploy/install.sh` with `ISOMUX_DEPS_ONLY=1`
   (packages, the browser, the codex sandbox, and the user-manager setup
   agents' apps run on - not the firewall, SSH hardening, unattended upgrades,
   bun, or anything that decides the box's identity). A checkout-only updater
   cannot deliver a dependency a release
   starts requiring: boxes installed before the Node.js step kept a dead
   terminal panel through every update. The release's own installer is the
   single declaration of what it needs, and the bytes come from the
   root-owned trust repo, like the updater refresh.

   **This widens the trust boundary**, and deliberately: the target commit's
   installer now runs as ROOT before the checkout, where previously only the
   updater did. `trust.git` stops the service user from substituting it, but
   nothing attests the release itself - whoever controls `REPO_URL` and its
   release tags already controls the code the box runs, and now also controls
   root code. Two mitigations: the target must carry the exact
   `ISOMUX_INSTALL_DEPS_MODE_VERSION=1` line (a release that merely mentions
   the flag is skipped, so an older installer can never be run as a full
   install on a live box), and it is invoked under `env -i` with a fixed PATH,
   HOME and the mode flag, so the updater's own environment cannot change what
   it does - an inherited `DRY_RUN` would otherwise make a sync report success
   without installing anything.

   The authority itself is not new, only its timing: `finalize` already
   installs the target's `scripts/update.sh` as root, so the next update runs
   target-tag code as root either way. This brings that forward to the current
   update and to before readiness, where a bad release has not yet had to
   prove it boots.

   It runs before the checkout so a failure leaves nothing of isomux's to
   undo, and skips (with a note) on user-kind boxes, boxes without apt, and
   targets whose installer predates the mode. The no-apt skip is a deliberate
   portability choice with a real cost: the update proceeds without the
   target's system requirements, and readiness cannot detect the resulting
   degradation (a dead terminal panel answers `/readyz` perfectly well). The
   alternative is failing closed there and requiring an explicit override.

   Deps mode restores Caddy's exact active AND enabled state on both the
   success and failure paths, and fails the sync if it cannot: on an
   unverifiable office `install_packages` stops and masks the proxy with no
   `configure_caddy` to follow, and on a verified one apt is free to upgrade
   Caddy and start a proxy the operator had deliberately turned off.

   Installed packages are additive and are NOT undone by a later rollback; a
   failed dependency step can leave host packages partly changed.
3. Check out the trust-resolved commit, then `bun install --frozen-lockfile`
   and `bun run build:ui`. On failure, the
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
- The release-aware update surface (recommendation B). One checker,
  `server/update-checker.ts`, with two modes keyed on the presence of
  `/etc/isomux/update.conf`: absent (source checkouts) gives full context
  across both dimensions - the running tag/commit, the latest release and
  whether it's newer, and main's commit lead - staying quiet when the box
  is ahead of main (copy matrix in `shared/update-notice.test.ts`); present
  (updater-managed boxes) compares the running
  release (`server/version.ts`) against the repo's latest GitHub release
  (owner/repo from the conf's `REPO_URL`), staying quiet while no release
  exists (`releases/latest` 404). The banner and modal follow the mode
  ("new release" instead of commit drift), and owners get the trigger:
  `GET`/`POST /api/office/update` (owner-only, `office:admin`) with a
  busy-agent confirm step, launching the installed updater DETACHED -
  `systemctl start --no-block isomux-update@<tag>.service` on system boxes
  (root-owned template unit + polkit rule, written by the installer as
  described above), `systemd-run --user` running `UPDATER_PATH` on
  user-kind boxes, a clean "not updater-managed" refusal without a conf.
- Security-release designation and sticky detection data. `scripts/release.sh
  --security` writes the exact machine-readable marker into the GitHub Release
  body. Release-mode checks preserve `releases/latest` as the banner target and
  scan published, stable CalVer release history to a complete short page. They
  expose the newest marked release after the running tag on the update-status
  wire. The existing banner and updater do not consume this new field. A
  malformed or incomplete scan publishes nothing. The scan uses 2 GitHub calls
  normally and 3 once history reaches 100 releases. It refuses after 21 in one
  hourly cycle, below the anonymous 60/hour budget. At 2,000 releases it keeps
  the prior whole update status every cycle until the mechanism changes; it
  never converts an incomplete scan into a null security floor. Option C
  remains deferred.

Remaining:

- First real release: run `scripts/release.sh` once, then flip the
  installer expectation that `releases/latest` 404s.

- ~~`internal-docs/backup-restore.md` (referenced by `backup.ts`) still does
  not exist; the daily-backup restore procedure is undocumented.~~ Written
  2026-07-31, exercised 2026-08-01. The updater does not depend on it (it
  snapshots and restores on its own), but operators do; the runbook also
  covers restoring a `pre-update-*` snapshot by hand. Both restore shapes
  were run end to end on the test box against v2026.7.23 - in place, and
  onto a provider-rebuilt blank Ubuntu 24.04 (fresh `deploy/install.sh`,
  then the backup over it): users, rooms, agents, tasks, memory, chat
  history and sign-in all came back, no code changes needed. One gap the
  drill exposed is a policy call, not a bug: the daily tarballs only ever
  exist on the box they protect, so "the VPS died" also loses the backups
  unless someone copies them off.
- The v2026.7.23 bridge needs two updater invocations. Its installed updater
  predates target dependency sync: the first invocation installs the current
  code and refreshes the stable updater copy, but cannot install new system
  dependencies. It also leaves the target tag absent from the service
  checkout. Re-run the same target once. The current updater recognizes that
  untagged, already-on-target shape, runs the target release's narrow
  deps-only installer, records the tag, and restarts so the app user-manager
  drop-in takes effect. A correctly tagged invocation remains a true no-op.
  Existing app hostnames are separate: the updater deliberately never rewrites
  Caddy because the operator must add wildcard DNS and opt into that migration;
  follow `docs/vps-install.md`.
- The in-UI trigger's busy-agent confirm has never been exercised with an
  agent genuinely mid-turn: the count comes from live agent state, and the
  test box has no model credentials, so it is always 0 there.
