# Backup and restore

The break-glass runbook for the daily office backup: what the tarballs
contain, and how to put one back. Referenced from `server/backup.ts`.

There is no restore automation and no button in the UI - a restore
replaces the whole office state root, so it runs with the service
stopped. A practical way to run it without doing the steps by hand:
give this runbook to an agent OUTSIDE the office (a plain `claude` in a
terminal on the box, or anything with SSH access), since the office's
own agents die with the service they would be restoring.

## What the daily backup is

`server/backup.ts` archives the entire state root once a day.

- **Source:** the state root - `~/.isomux` in production, or whatever
  `ISOMUX_HOME` points at. The archive is written with
  `tar -C <parent-of-state-root> <basename>`, so it holds exactly one
  top-level directory, normally `.isomux/`.
- **Destination:** `$ISOMUX_BACKUP_DIR`, else `~/isomux-backups`. That is
  the home directory of the **server process**, which on a VPS install is
  `/home/isomux/isomux-backups`, not your own home. The destination sits
  outside the state root so a restore never clobbers the backups.
- **File name:** `isomux-YYYY-MM-DD.tar.gz`, the local date the run
  happened.
- **Retention:** the 7 newest are kept, older ones pruned after each
  successful run.
- **Schedule:** hourly check; a new backup is taken once the newest one
  is at least 24h old. Runs land a bit more than 24h apart, so a date in
  the file names occasionally gets skipped - normal, not a missed backup.
- **No quiesce:** the archive is taken live. Config files are written
  atomically and JSONL logs are append-only and line-tolerant, so a
  snapshot cannot catch half-written state. GNU tar's exit 1 ("file
  changed as we read it") is logged as a warning and the archive is kept;
  exit 2 or higher is a real failure and is recorded as one.

### What is in the archive

Everything under the state root: `agents.json`, `users.json`,
`office-config.json`, live sessions and outstanding invites, the task
board, scheduled messages, cron job definitions and their run history,
every agent's conversation logs and attachments, office/room/agent memory,
the codex home, and the runtime `bin`/`tls` dirs.

Two things are silently absent:

- **Unix sockets.** `~/.isomux/admin.sock` is skipped by tar (verified
  against a real tarball). The server recreates it at boot.
- **Provider homes that sit outside the state root.** Whether a given
  agent's model-side transcripts are in the archive depends entirely on
  where its provider home points, so it is worth being precise:

  | Provider home                                       | In the archive? |
  | --------------------------------------------------- | --------------- |
  | Claude, default `~/.claude` (transcripts in `projects/`) | No - outside the state root |
  | Codex, default `<state-root>/codex-home` (rollouts in `sessions/`) | **Yes** |
  | Any home redirected out of the state root by a per-user env file (`CLAUDE_CONFIG_DIR=...`, `CODEX_HOME=~/.isomux-users/<name>/.codex`) | No |
  | A `CLAUDE_CONFIG_DIR` pointed *inside* the state root | Yes |

  So Codex threads normally survive a restore and can be resumed; Claude
  sessions normally do not. See "After the restore" below.

Also outside the archive, and worth remembering when a box is rebuilt from
scratch rather than rolled back: the repo checkout the service runs from,
and on updater-managed boxes `/etc/isomux/update.conf` plus
`/var/lib/isomux-update/`.

### Checking backup health

`GET /api/backup/status` (any authenticated caller with `office:read`)
returns:

```json
{
  "lastRunAt": 1753000000000,
  "ok": true,
  "error": null,
  "retention": 7,
  "destDir": "/home/isomux/isomux-backups"
}
```

Read `destDir` from there rather than assuming `~/isomux-backups` - it is
the path the running process actually uses.

## Restoring

Pick the tarball first, and be deliberate about it: the state root you are
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

System service (a VPS install, `docs/vps-install.md`) - as root:

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
hard stop ("service would not stop; NOT touching the state root under a
live process"). Untarring over a state root a live process is still
writing to is how you get a half-restored office.

**2. Verify the archive before touching live state.**

```
tar -tzf ~/isomux-backups/isomux-2026-07-30.tar.gz >/dev/null   # expect: silence
tar -tzf ~/isomux-backups/isomux-2026-07-30.tar.gz | head -1    # expect: .isomux/
```

That first line is the whole integrity check: it decompresses and walks
every header. A truncated tarball fails here, before you have moved
anything.

**3. Move the current state root aside. Do not delete it.**

```
mv ~/.isomux ~/.isomux.broken-$(date +%Y%m%d-%H%M%S)
```

If the restore turns out to be the wrong choice, this directory is the way
back. Delete it later, once the office is confirmed healthy.

**4. Extract into the parent of the state root.**

```
tar -xzf ~/isomux-backups/isomux-2026-07-30.tar.gz -C ~
```

The invariant, which matters if `ISOMUX_HOME` is set and `~` is not the
right answer: **`-C` takes `dirname(<current state root>)`**, because the
archive already carries its own top level. That top level is the
`basename` the state root had *at backup time*, which is not necessarily
the one it has now. Check it (`tar -tzf ... | head -1`) before extracting;
if it differs from the current basename, extract into the correct parent
as above and then rename the extracted directory to match.

On a VPS install, run this as root or as the `isomux` service account. As
root, tar restores the ownership recorded in the archive, so the files come
back owned by `isomux`. Extracted by any other non-root user, everything
lands owned by *that* user and the service will not be able to read it.

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

## After the restore

- **Agents all come back; some need a fresh session.** Agent
  definitions, desks, rooms and chat history are all in the archive. But
  each AI provider also keeps its own session files, and only files
  inside the state root were backed up: Codex keeps them there (its
  conversations resume), Claude keeps them in `~/.claude` (its agents
  show their history but need a fresh session to continue). See the
  table above if any agent uses a per-user env file.
- **Anything newer than the backup is gone**: messages, tasks, cron
  runs, invites minted since. The tarball's mtime tells you the cutoff.
- **Version skew.** Restoring into the same release the backup came from
  is always safe. Newer code reading older state is the supported
  direction: the startup migrations run before the server binds, and each
  state module upgrades its own on-disk shape lazily on first load. Older
  code reading newer state is not supported - if you are also rolling the
  code back, roll it back to the release that was running when the backup
  was taken.
- **The next daily backup is unaffected.** The backup directory lives
  outside the state root, so the restore does not touch it and the
  schedule picks up where it was.

## Other tarballs you may find

Three different things write archives; only the first is the daily backup.

| Location                                            | Written by                    | What it is                                                                  |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `~/isomux-backups/isomux-YYYY-MM-DD.tar.gz`         | `server/backup.ts`            | The daily backup. This runbook.                                              |
| `/var/lib/isomux-update/snapshots/pre-update-*.tar.gz` | `scripts/update.sh`         | Taken with the service stopped, immediately before a release is applied. The updater restores it itself if the new version fails its readiness poll. Same shape, so it restores by hand the same way. |
| `~/.isomux/backups/`                                 | `server/migrations.ts` etc.  | One-off safety copies taken before a schema migration (e.g. `pre-userid-migration-*`). Individual files and directories, not full-office archives. |

`/var/lib/isomux-update/snapshots/broken-*` is the third kind: a state root
the updater moved aside after a failed release. It is a directory, not a
tarball, and only the newest one is kept.
