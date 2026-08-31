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
  outside the state root so a restore never clobbers the backups. It is
  still the same disk as the office it protects, and nothing copies it
  anywhere else - a box that dies takes its backups with it. If the office
  matters, pull the tarballs onto another machine on a schedule.
- **File name:** `isomux-YYYY-MM-DD.tar.gz`, the local date the run happened.
  A second successful run that day uses `-2`, then `-3`, and so on. A matching
  `.verified.json` marker records the final archive size and modification time.
  The archive and its marker are both mode `0600`. The archive is not a backup
  unless that marker matches.
- **Retention:** the 7 newest verified archive-marker pairs are kept. Pruning
  happens only after a new archive is fully verified and published. A failed,
  interrupted or invalid archive cannot take a slot or remove a good copy.
- **Schedule:** hourly check; a new backup is taken once the newest one
  is at least 24h old. Runs land a bit more than 24h apart, so a date in
  the file names occasionally gets skipped - normal, not a missed backup.
- **No quiesce:** the archive is taken live. Config files are written
  atomically and JSONL logs are append-only and line-tolerant, so a
  snapshot cannot catch half-written state. GNU tar's exit 1 ("file
  changed as we read it") is logged as a warning and the archive is kept;
  exit 2 or higher is a real failure and is recorded as one. Every archive is
  then walked independently with `tar -tzf` before publication.

Before it reads the state root, the job checks free space. A later run needs the
newest verified archive size plus the larger of 25% or 256 MiB. The first run
needs 2 GiB because there is no prior size. A refusal deletes nothing and the
hourly retry remains a cheap free-space check. A short write that still occurs
stays under a hidden partial name and is removed after verification fails.

Archives made before the restrictive archive mode was added can still be more
widely readable. On an existing installation, the operator should tighten them:

```sh
chmod 600 ~/isomux-backups/isomux-*.tar.gz
chmod 700 ~/isomux-backups
```

The second command is optional when other local users must traverse the backup
directory. Use the destination reported by `GET /api/backup/status` when it is
not `~/isomux-backups`.

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
  | Personal Claude/Codex homes below `<state-root>/provider-homes` | **Yes**, including provider login state |
  | OpenCode, managed profiles below `<state-root>/opencode/profiles` | **Yes**, including provider login state |
  | Any home redirected out of the state root by a per-user env file (`CLAUDE_CONFIG_DIR=...`, `CODEX_HOME=~/.isomux-users/<name>/.codex`) | No |
  | A `CLAUDE_CONFIG_DIR` pointed *inside* the state root | Yes |

  So Codex threads normally survive a restore and can be resumed; Claude
  sessions normally do not. See "After the restore" below.

Also outside the archive, and worth remembering when a box is rebuilt from
scratch rather than rolled back: the repo checkout the service runs from,
and on updater-managed boxes `/etc/isomux/update.conf` plus
`/var/lib/isomux-update/`.

Hosted TLS keys are also outside this ordinary backup and are never carried
through a provider rebuild. A rebuild always takes fresh issuance. If lego
returns the wiped box's stale chain, the adapter forces one renewal, spends one
duplicate-certificate slot, and accepts only a chain matching the new key.

### Checking backup health

`GET /api/backup/status` (any authenticated caller with `office:read`) returns
the newest disk-verified state. It survives a service restart because it is
derived from archives and their markers, not only process memory:

```json
{
  "lastRunAt": 1753000000000,
  "ok": true,
  "error": null,
  "retention": 7,
  "destDir": "/home/isomux/isomux-backups"
}
```

Read `destDir` from there rather than assuming `~/isomux-backups` - it is the
path the running process actually uses. `ok: false` with a stale error means the
newest verified archive is more than 26 hours old. The two-hour grace prevents
the hourly scheduler from reporting a healthy backup as stale each day. A newer failed attempt also
returns false while keeping `lastBackupFile` pointed at the recoverable copy.

An archive without a matching marker may be from an older release. The next
backup tick walks it once. A valid archive gets a marker and joins retention. An
invalid archive gets an `.invalid.json` marker and remains outside retention;
the job checks it again only if its size or modification time changes.
After confirming the matching `.invalid.json` marker and preserving any incident
evidence you need, remove the invalid archive and marker to reclaim disk space.

## Restoring

Two shapes: onto the box the office already runs on (this section), and
onto a replacement box after the old one is gone (next section). Both were
exercised end to end on the Hetzner test box on 2026-08-01, against release
v2026.7.23; the commands below are the ones that were run.

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

## Restoring onto a new box

The old box is gone and the office has to come back on a machine that has
never run it. Everything above still applies; these are the extra steps
around it.

**0. Have the tarball somewhere other than the dead box.** Self-hosted local
backups live next to the office they protect, so this procedure starts with a
copy pulled off earlier:

```
scp root@office.example.com:/home/isomux/isomux-backups/isomux-2026-08-01.tar.gz .
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
scp isomux-2026-08-01.tar.gz root@office.example.com:/root/
ssh root@office.example.com
systemctl stop isomux
systemctl is-active isomux                                    # inactive, not deactivating
tar -tzf /root/isomux-2026-08-01.tar.gz >/dev/null            # expect: silence
mv /home/isomux/.isomux /home/isomux/.isomux.fresh-install-$(date +%Y%m%d-%H%M%S)
tar -xzf /root/isomux-2026-08-01.tar.gz -C /home/isomux
systemctl start isomux
curl -sf http://127.0.0.1:4000/readyz && echo ready
```

**3. Delete the backup the fresh install already took.** A new office
backs up as it starts, so `/home/isomux/isomux-backups` holds a tarball of
the empty office. Left there it is what a later "restore the newest
tarball" picks, and it holds the schedule off for 24h. The old box's
backups died with it and the archive you restored from is in `/root/`, so
this directory holds exactly that one file - list it and delete it by
name:

```
ls -la /home/isomux/isomux-backups/
rm /home/isomux/isomux-backups/isomux-2026-08-02.tar.gz
```

A few hundred bytes is the tell: an empty office compresses to about 300,
a real one does not. With the directory empty the office takes a real
backup at its next hourly check, or immediately if you restart it.

**4. Sign in.** The installer's invite was minted into the state root you
just replaced, so it is gone. Mint a fresh owner link instead, using the
restored office's own owner name - look it up first, and pick one if the
office has several owners:

```
jq -r '.[] | select(.role=="owner") | .name' /home/isomux/.isomux/users.json
cd /opt/isomux
sudo -u isomux HOME=/home/isomux /usr/local/bin/bun run server/index.ts owner-login --name "<that name>"
```

The link is single-use and expires in 15 minutes. Sessions are in the
archive too, so a browser signed in before the backup was taken stays
signed in until that session would have expired anyway.

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
  schedule picks up where it was. On a new box it is the exception: see
  step 3 there.
- **Agents come back pointing at directories the box may not have.** An
  agent's working directory is not in the archive, only the path to it. On
  a rebuilt box those paths are empty until you clone the repos back.

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
