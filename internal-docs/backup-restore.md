# Backup and restore

The break-glass runbook for the daily office backup: what a copy contains,
and how to put one back. Referenced from `server/backup.ts`.

There is no restore automation and no button in the UI - a restore
replaces the whole office state root, so it runs with the service
stopped. A practical way to run it without doing the steps by hand:
give this runbook to an agent OUTSIDE the office (a plain `claude` in a
terminal on the box, or anything with SSH access), since the office's
own agents die with the service they would be restoring.

## SQLite state

`office.sqlite` holds tasks and the office audit log. The backup child uses
`VACUUM INTO` straight into the copy and checks the snapshot with `PRAGMA
integrity_check`. The live database and its `-wal` and `-shm` files are left
out. A timeout or failed snapshot fails the backup. Startup removes the
snapshot staging folders that older releases left.

Restore with the service stopped into a fresh state root, as below. Do not copy
a live SQLite file or reuse its old WAL/SHM files. The server sets WAL mode each
time it opens the database, including after restore.

An old backup with only `tasks.json` is imported when the database has no tasks.
The server commits the import in one transaction and keeps `tasks.json` on that boot,
so a code rollback to a release without the import still reads the board. A later boot
deletes `tasks.json` when the database knows every task in it, as a task row or
in the audit log. If the file has a task the database does not know (for example,
one made on old code after a rollback), the server keeps the file and logs a warning;
that task does not come back on the board. The import does not backfill audit
rows. A malformed source is preserved as `tasks.json.corrupt-<timestamp>`; the
server logs both paths and opens an empty board. An old `memory/.oplog.jsonl` is kept untouched, with no import.

A malformed `agents.json` is preserved as `agents.json.corrupt-<timestamp>`;
the server logs it and boots with one empty room. To recover, stop the service,
then repair the JSON in that file and move it back over `agents.json`, or
restore `agents.json` from a backup.

## What the daily backup is

`server/backup.ts` copies the office state once a day by default. It omits persisted
credential files and what Isomux or a backend makes again (see "What is in a
copy").

- **Source:** the state root - `~/.isomux` in production, or whatever
  `ISOMUX_HOME` points at.
- **Shape:** each copy is a plain folder, not an archive (older releases
  wrote `.tar.gz` files, see "Older tar.gz copies"):

  ```
  isomux-2026-11-16/        mode 0700
    .isomux/                the copy of the state root
    manifest.jsonl.gz       one line per entry of the copy
    backup.json             the marker, written last
  ```

  A file with the same size, mtime and ctime as in the previous copy is a
  hard link to that copy's file; a changed or new file is copied. The copies
  share the disk space of what did not change, and each copy is still
  whole. Hard links have no direction: deleting any copy by hand, oldest,
  newest or in the middle, leaves the others whole. On a filesystem without
  hard links every file is copied.
- **Settings:** the office owner sets how often (1 to 720 hours, default
  24), how many copies to keep (1 to 100, default 7) and the folder in
  Settings → Housekeeping → Storage (`PUT /api/backup/settings`). They live in
  `office-config.json` as `backupIntervalHours`, `backupRetention` and
  `backupDir`. Each hourly check reads them once and uses that snapshot for
  the whole run, so a change needs no restart and a save during a run does not
  move it.
- **Destination:** `$ISOMUX_BACKUP_DIR`, else the folder setting, else a
  folder next to the state root, named after it: `~/.isomux` backs up to `~/isomux-backups`, and an
  `ISOMUX_HOME` of `/srv/office` to `/srv/office-backups`. `~` there is the
  home directory of the **server process**, so on a VPS install it is
  `/home/isomux/isomux-backups`, not your own home. Two offices with different
  state roots get separate folders, so one office's retention does
  not delete the other's backups. The environment variable wins over the
  setting so a scratch office started from a copied `office-config.json`
  cannot prune the real office's folder. The destination must be
  outside the state root (checked on the real path when it is saved) so a
  restore never clobbers the backups. When the folder changes, the earlier
  backups stay in the old one; status and retention see only the new one. It is
  still the same disk as the office it protects, and nothing copies it
  anywhere else - a box that dies takes its backups with it. If the office
  matters, pull the copies onto another machine on a schedule, with
  `rsync -aH` (`-H` keeps the hard links; without it each copy takes its full
  size) or a `tar` of one copy folder.
- **Folder name:** `isomux-YYYY-MM-DD`, the local date the run started. A
  later run that day uses `-2`, then `-3`, and so on. `backup.json` records
  when the run started and finished, the state root of the office that
  wrote it, and the copy it linked from. Two offices can share a folder:
  each one's retention, status and schedule count only its own copies. A
  folder without a readable `backup.json` is not a backup: not counted and
  never pruned.
- **Privacy:** each copy folder is mode `0700`, whatever the modes inside.
- **Retention:** the newest verified copies, as many as the setting says
  (default 7), are kept; folder copies and older `.tar.gz` copies count in
  one list, oldest first. Pruning happens only after a new copy is verified
  and published, so a lower setting takes effect at the next backup. A
  failed or interrupted run cannot take a slot or remove a good copy. A
  pruned copy is first renamed to a hidden partial name, so a prune that
  stops half-way never leaves a broken copy that still counts.
- **Schedule:** hourly check; a new backup is taken once the run that made
  the newest one started at least one interval ago (`startedAt`; a
  `.tar.gz` marker from an older release has none, and the archive's
  modification time stands in). A save of the settings runs one check at
  once.
- **No quiesce:** the copy is taken live. Config files are written
  atomically and JSONL logs are append-only and line-tolerant, so a copy
  cannot catch half-written state. A file that changes during its copy is
  kept as copied, and the next run copies it again. A file that is gone
  since the run listed it is skipped. A file or folder the server cannot
  read fails the run.
- **Verification:** the run writes into a hidden `.partial` folder, checks
  it against its manifest (every entry there, each file of the size
  written, nothing more), writes `backup.json` and renames the folder. The
  rename publishes it.
- **Not kept:** sockets and FIFOs. Two paths that are one file in the state
  root become two files in the copy.

Before it writes anything, the run lists the state root and checks free
space: what it will copy, its folders and manifest, plus the larger of 25%
or 256 MiB. The first folder copy copies everything (about the raw size of
the state root); a later one copies only what changed. The run checks again
after each 256 MiB it copies and stops below 256 MiB free. A refusal deletes
nothing, and the hourly retry costs one listing of the state root. A failed
run removes its partial folder. On server start, the job deletes the partial
folders that a stopped server left.

A copy keeps the modes of the state root, so a read-only folder in it (a Go
module cache is `0555`) is read-only in the copy too. If `rm -rf` of a copy
says "Permission denied", run `chmod -R u+w <copy>` first. Never edit a file
inside a copy in place: other copies may share it. Copy it out first.

### Older tar.gz copies

Releases before task 1426371a wrote `isomux-YYYY-MM-DD.tar.gz` with a
`.verified.json` marker (the archive's size and mtime). They stay readable,
count in retention and age out; no new one is written. An archive is not a
backup unless its marker matches, and a 0-byte archive never is. To restore
one, see "Restoring an older tar.gz copy".

Archives made before the restrictive archive mode was added can still be more
widely readable. On an existing installation, the operator should tighten them:

```sh
chmod 600 ~/isomux-backups/isomux-*.tar.gz
chmod 700 ~/isomux-backups
```

The second command is optional when other local users must traverse the backup
directory. Use the destination reported by `GET /api/backup/status` when it is
not `~/isomux-backups`.

### What is in a copy

A copy keeps office state and history, including provider sessions,
memories, app registrations and app data. It omits known backend login files,
managed environment files, secrets, app runtime credential files, private legacy TLS
material, and Codex shell snapshots (`server/backup-exclusions.ts`,
`BACKUP_EXCLUSIONS`).
It also omits what Isomux or a backend makes again
(`regenerableBackupPaths`): in each OpenCode profile `cache/`, `tmp/`,
`home/.npm/` and `config/opencode/node_modules/`; in `codex-home/` and each
`provider-homes/<id>/codex/` `cache/`, `.tmp/` and `tmp/`; and the built Codex
safety hook pair in `bin/`. The server builds the hook again at start, and the
backends download their caches and plugins again when they need them. These
paths are listed from the disk at each run and matched as literal paths,
so a folder of the same name elsewhere (a `cache/` in an agent's project)
stays in the copy. If a folder cannot be listed, the run logs it and keeps
its caches in the copy.
The secrets exclusion covers all of `secrets/`, the placeholder key and the
office CA key included. Secrets put back without those keys get new ones at
the next start: every placeholder changes, and agents get the new ones when
their processes start again.
A copy is not free of secrets. Conversation logs
and provider transcripts remain because they are history, even though user text
can incidentally contain sensitive values.

A copy keeps `office-id`, the id in the office's session cookie names
(`isomux_session_<id>`, `server/office-id.ts`), so a restored office keeps its
browsers signed in. An office started from a copy of another office's state
root (a restore next to the original, or a copied `~/.isomux`) has the same id,
and on one host the two read and clear each other's session cookies. Delete
`office-id` in the copy before its first start to give it its own id.

Two things are silently absent:

- **Unix sockets.** `~/.isomux/admin.sock` is skipped. The server
  recreates it at boot.
- **Provider homes that sit outside the state root.** Whether a given
  agent's model-side transcripts are in a copy depends entirely on
  where its provider home points, so it is worth being precise:

  | Provider home                                       | In a copy? |
  | --------------------------------------------------- | --------------- |
  | Claude, default `~/.claude` (transcripts in `projects/`) | No - outside the state root |
  | Codex, default `<state-root>/codex-home` (rollouts in `sessions/`) | **Yes**, except login and shell snapshots |
  | Personal Claude/Codex homes below `<state-root>/provider-homes` | **Yes**, except login and shell snapshots |
  | OpenCode, managed profiles below `<state-root>/opencode/profiles` | **Yes**, except provider and MCP login files, the server record and the profile's `opencode.json` (it holds the headers of the MCP servers Isomux registers). The databases stay: they hold the sessions and, under OpenCode 2, the provider sign-ins |
  | Agent browser profiles below `<state-root>/browser-profiles` | No - login state is omitted |
  | Any home redirected out of the state root by a per-user env file (`CLAUDE_CONFIG_DIR=...`, `CODEX_HOME=~/.isomux-users/<name>/.codex`) | No |
  | A `CLAUDE_CONFIG_DIR` pointed *inside* the state root | Yes |

  So Codex threads normally survive a restore and can be resumed; Claude
  sessions normally do not. See "After the restore" below.

Also outside the backup, and worth remembering when a box is rebuilt from
scratch rather than rolled back: the repo checkout the service runs from,
and on updater-managed boxes `/etc/isomux/update.conf` plus
`/var/lib/isomux-update/`.

Active hosted TLS keys are outside this ordinary backup and are never carried
through a provider rebuild. The installer obtains a certificate before the
state restore (`deploy/install.sh`, `install_hosted_tls_renewal`). A rebuild
always takes fresh issuance. If lego
returns the wiped box's stale chain, the adapter forces one renewal, spends one
duplicate-certificate slot, and accepts only a chain matching the new key.

### Checking backup health

`GET /api/backup/status` (any authenticated caller with `office:read`) returns
the newest disk-verified state. It survives a service restart because it is
derived from the copies and their markers, not only process memory:

```json
{
  "lastRunAt": 1753000000000,
  "ok": true,
  "error": null,
  "retention": 7,
  "intervalHours": 24,
  "destDir": "/home/isomux/isomux-backups",
  "destDirFromEnv": false
}
```

Read `destDir` from there rather than assuming `~/isomux-backups` - it is the
path the running process actually uses. `ok: false` with a stale error means the
newest verified copy finished more than the interval plus two hours ago (26 hours
by default). The two-hour grace prevents
the hourly scheduler from reporting a healthy backup as stale each day. A newer failed attempt also
returns false while keeping `lastBackupFile` pointed at the recoverable copy.

A `.tar.gz` without a matching marker may be from an older release. The next
backup tick walks it once. A valid archive gets a marker and joins retention. An
invalid archive gets an `.invalid.json` marker and remains outside retention;
the job checks it again only if its size or modification time changes.
After confirming the matching `.invalid.json` marker and preserving any incident
evidence you need, remove the invalid archive and marker to reclaim disk space.

## Restoring

Two shapes: onto the box the office already runs on (this section), and
onto a replacement box after the old one is gone (next section). Both were
exercised end to end on the Hetzner test box on 2026-08-01, against release
v2026.7.23, with the tar.gz copies of that time. For folder copies (task
1426371a) steps 2 and 4 changed; the backup tests restore with the same
`cp -a`. For an older `.tar.gz` copy, see "Restoring an older tar.gz copy".

Pick the copy first, and be deliberate about it: the state root you are
about to replace is the only copy of anything that happened since that
backup ran.

**1. Stop the office and confirm it is really down.**

Two deployment shapes, two service managers. Use one set or the other -
never mix them, because `systemctl` and `systemctl --user` answer about
different units and a user-unit operator asking the system manager gets a
confident answer about a unit that isn't there.

User-level service (a self-hosted box, `docs/self-hosted.md`):

```
systemctl --user stop isomux
systemctl --user is-active isomux
```

System service (a VPS install, `docs/self-hosted.md`) - as root:

```
systemctl stop isomux
systemctl is-active isomux
```

Do not skip the `is-active` check, and do not settle for "it printed
something". You are waiting for a state that is neither `active` nor
`deactivating`; `inactive` and `failed` both qualify, `deactivating` means
the process is still shutting down and may still be writing. If it will
not leave `deactivating` after a minute or so, stop and investigate rather
than forcing it - the updater's rollback path treats exactly this as a
hard stop ("service would not stop; NOT rebuilding the old version under a
live process"). Untarring over a state root a live process is still
writing to is how you get a half-restored office.

**2. Check the copy before touching live state.**

```
ls -A ~/isomux-backups/isomux-2026-07-30/        # expect: .isomux  backup.json  manifest.jsonl.gz
cat ~/isomux-backups/isomux-2026-07-30/backup.json
```

The run checked the copy against its manifest before it wrote
`backup.json`. A folder without `backup.json` is not a backup: a run that
stopped, or a copy someone changed.

**3. Move the current state root aside. Do not delete it.**

```
mv ~/.isomux ~/.isomux.broken-$(date +%Y%m%d-%H%M%S)
```

If the restore turns out to be the wrong choice, this directory is the way
back. Delete it later, once the office is confirmed healthy.

**4. Copy the state root out of the copy, into the parent of the state
root.**

```
cp -a ~/isomux-backups/isomux-2026-07-30/.isomux ~/
```

Copy it, never move or hard-link it (`mv`, `cp -l`): the backups share
files, and the office would then write into every backup that holds them.

The copy leaves out the credential files (see "What is in a copy"):
members enter their managed variables, secrets and provider sign-ins again
after the restore.
Copies from older releases may still contain those credentials.

The invariant, which matters if `ISOMUX_HOME` is set and `~` is not the
right answer: the target is **`dirname(<current state root>)`**. The folder
inside the copy has the `basename` the state root had *at backup time*,
which is not necessarily the one it has now. If it differs, copy it into
the correct parent and then rename it to match.

On a VPS install, run this as the `isomux` service account, or as root and
then `chown -R isomux:isomux /home/isomux/.isomux`. Copied by any other
user, everything lands owned by *that* user and the service will not be
able to read it.

**5. Start it and confirm readiness.**

Same split as step 1. User-level service:

```
systemctl --user start isomux
curl -sf http://127.0.0.1:4000/readyz && echo ready
```

System service, as root:

```
systemctl start isomux
curl -sf http://127.0.0.1:4000/readyz && echo ready
```

`/readyz` answering means the server bound its port after running its
startup migrations, which is the same signal the updater polls before it
calls an update good.

### Restoring an older tar.gz copy

Steps 1, 3 and 5 are the same. In step 2, walk the archive:

```
tar -tzf ~/isomux-backups/isomux-2026-07-30.tar.gz >/dev/null   # expect: silence
tar -tzf ~/isomux-backups/isomux-2026-07-30.tar.gz | head -1    # expect: .isomux/
```

The first line decompresses and walks every header: a truncated archive
fails here, before you have moved anything. The second shows the top-level
folder, the state root's name at backup time. In step 4, extract into the
parent of the state root:

```
tar -xzf ~/isomux-backups/isomux-2026-07-30.tar.gz -C ~
```

As root, tar restores the ownership recorded in the archive, so on a VPS
install the files come back owned by `isomux`.

## Restoring onto a new box

The old box is gone and the office has to come back on a machine that has
never run it. Everything above still applies; these are the extra steps
around it.

**0. Have a copy somewhere other than the dead box.** Self-hosted local
backups live next to the office they protect, so this procedure starts with a
copy pulled off earlier:

```
rsync -a root@office.example.com:/home/isomux/isomux-backups/isomux-2026-08-01 .
```

Hosted local backups also stay on the customer VPS. The customer is responsible
for keeping an external copy for recovery after box loss.

**1. Point the domain's DNS records at the new box, then install isomux
normally.**

They have to resolve to the new box before you install, or Caddy cannot
get a certificate - including an AAAA record if the domain has one. Then
the installer steps from `docs/self-hosted.md`:

```
(
  installer=$(mktemp) || exit
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh -o "$installer" &&
    DOMAIN=office.example.com bash "$installer"
)
```

Use v2026.8.22 or newer when restoring a versioned backup. Newer code reading
older state is supported; the other direction is not.

What you get is an empty office with its own owner and its own invite
link. The restore replaces both, so ignore the invite link the installer
prints.

**2. Restore over the fresh state root**, the same steps as above:

```
rsync -a isomux-2026-08-01 root@office.example.com:/root/
ssh root@office.example.com
systemctl stop isomux
systemctl is-active isomux                                    # inactive, not deactivating
cat /root/isomux-2026-08-01/backup.json                       # expect: the marker
mv /home/isomux/.isomux /home/isomux/.isomux.fresh-install-$(date +%Y%m%d-%H%M%S)
cp -a /root/isomux-2026-08-01/.isomux /home/isomux/
chown -R isomux:isomux /home/isomux/.isomux
systemctl start isomux
curl -sf http://127.0.0.1:4000/readyz && echo ready
```

**3. Delete the backup the fresh install already took.** A new office
backs up as it starts, so `/home/isomux/isomux-backups` holds a copy of
the empty office. Left there it is what a later "restore the newest
copy" picks, and it holds the schedule off for one interval. The old box's
backups died with it and the copy you restored from is in `/root/`, so
this directory holds exactly that one copy - list it and delete it by
name:

```
ls -la /home/isomux/isomux-backups/
rm -rf /home/isomux/isomux-backups/isomux-2026-08-02
```

A small `bytes` in its `backup.json` is the tell: an empty office is a few
kilobytes, a real one is not. With the directory empty the office takes a real
backup at its next hourly check, or immediately if you restart it.

**4. Sign in.** The installer's invite was minted into the state root you
just replaced, so it is gone. Mint a fresh owner link instead, using the
restored office's own owner name - look it up first, and pick one if the
office has several owners:

```
jq -r '.[] | select(.role=="owner") | .name' /home/isomux/.isomux/users.json
curl -s --unix-socket /home/isomux/.isomux/admin.sock -X POST http://localhost/admin/owner-login \
  -H 'Content-Type: application/json' --data '{"name":"<that name>"}'
```

The link is single-use and expires in 15 minutes. Sessions are in the
copy too, so a browser signed in before the backup was taken stays
signed in until that session would have expired anyway.

## After the restore

- **Agents all come back; some need a fresh session.** Agent
  definitions, desks, rooms and chat history are all in the copy. But
  each AI provider also keeps its own session files, and only files
  inside the state root were backed up: Codex keeps them there (its
  conversations resume), Claude keeps them in `~/.claude` (its agents
  show their history but need a fresh session to continue). See the
  table above if any agent uses a per-user env file.
- **Apps keep their registrations and data.** At boot, Isomux re-mints missing
  app tokens, regenerates their unit files, and restarts only apps that were
  running. Apps that were stopped remain stopped and use the new token when
  started from the Apps page.
- **Restore the omitted user credentials.** Managed
  environment variables, provider logins and agent browser logins cannot be
  re-minted by Isomux.
- **A restore undoes a lockdown's revocations.** A backup taken before
  `rescue lockdown` still holds the sign-ins, API tokens, invites and
  browser extension pairings the lock moved aside, and a restore brings
  them back. After a restore of such a backup onto a locked office, run
  the lockdown again (docs/hosting-reference.md, "Locking the office
  down").
- **Anything newer than the backup is gone**: messages, tasks, cron
  runs, invites minted since. `startedAt` in the copy's `backup.json` (for
  an older `.tar.gz`, its mtime) tells you the cutoff.
- **Version skew.** Restoring into the same release the backup came from
  is always safe. Newer code reading older state is the supported
  direction: the startup migrations run before the server binds, and each
  state module upgrades its own on-disk shape lazily on first load. Older
  code reading newer state is not supported - if you are also rolling the
  code back, roll it back to the release that was running when the backup
  was taken.
  A current release restoring an old backup keeps credentials that backup
  contains. An older release can run on a current copy, but the omitted
  credentials remain absent and older app reconciliation may not restart an app onto a re-minted token.
  A release before task 1426371a neither counts nor prunes folder copies:
  after a rollback to one, delete them by hand when you no longer need them.
- **The next daily backup is unaffected.** The backup directory lives
  outside the state root, so the restore does not touch it and the
  schedule picks up where it was. On a new box it is the exception: see
  step 3 there.
- **Agents come back pointing at directories the box may not have.** An
  agent's working directory is not in the copy, only the path to it. On
  a rebuilt box those paths are empty until you clone the repos back.

## Other copies you may find

Three different things write copies of state; only the first is the daily backup.

| Location                                            | Written by                    | What it is                                                                  |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `~/isomux-backups/isomux-YYYY-MM-DD/` (older releases: `.tar.gz`) | `server/backup.ts` | The daily backup. This runbook.                                   |
| `/var/lib/isomux-update/snapshots/pre-update-*.tar.gz` | older `scripts/update.sh`   | Full state snapshot an older updater took with the service stopped, before it applied a release. It is not filtered like the daily backup. The current updater takes none. |
| `~/.isomux/backups/`                                 | `server/migrations.ts` etc.  | One-off safety copies taken before a schema migration (e.g. `pre-userid-migration-*`). Individual files and directories, not full-office archives. |

`/var/lib/isomux-update/snapshots/broken-*` is the third kind: a state root
an older updater moved aside after a failed release. It is a directory, not
a tarball.

The current updater leaves the state root in place and, when a release
fails its readiness poll, rolls back the code only. It writes nothing to
`/var/lib/isomux-update/snapshots`, and it deletes nothing there either. The
update to the first release with this updater still runs the old one and
takes one last snapshot. The daily backup above is the copy to restore from.
Delete the leftovers by hand when you no longer need them:

```
sudo rm -f /var/lib/isomux-update/snapshots/pre-update-*.tar.gz
sudo rm -rf /var/lib/isomux-update/snapshots/broken-*
```
