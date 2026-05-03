# Backup and Restore

Isomux automatically snapshots `~/.isomux/` daily into a local tarball directory. This doc describes what the backup covers, where it lives, and how to restore from one.

## What gets backed up

The full `~/.isomux/` directory:

- `agents.json`, `agent-history.json`, `agents-summary.json` — agent configs and discovery manifest.
- `tasks.json` — task list.
- `office-config.json`, `office-prompt.md` — office-level prompt and env settings.
- `recent-cwds.json` — recent working directories.
- `cronjobs/` — cronjob configs, run index, and per-run transcripts.
- `logs/` — every agent's session JSONL transcripts, sessions metadata, and uploaded files.
- `tls/` — dev TLS certs (regenerable, but included for completeness).

Backups are taken live; the server keeps running while `tar` works in a subprocess. JSON config writes use an atomic `write-then-rename`, so a snapshot can never capture a half-written config. JSONL transcripts are append-only and line-tolerant — a torn final line in the snapshot is harmless.

## Schedule

A check runs on server startup and every hour. If the newest existing tarball is older than 24 hours (or none exists), a new tarball is written. There's no fixed wall-clock time of day.

## Destination and retention

Default location: `~/isomux-backups/`. Override with the `ISOMUX_BACKUP_DIR` environment variable (set in your isomux service unit or shell environment).

Filename: `isomux-YYYY-MM-DD.tar.gz`.

Retention: the seven newest tarballs are kept; older ones are pruned after each successful run.

## Status

The current backup state is exposed at:

```
GET http://localhost:4000/backup/status
```

Response shape:

```json
{
  "backupDir": "/home/you/isomux-backups",
  "retention": 7,
  "lastBackupAt": 1714723200000,
  "lastBackupOk": true,
  "lastBackupError": null,
  "lastBackupFile": "isomux-2026-05-03.tar.gz",
  "running": false
}
```

`lastBackupAt` is ms-since-epoch. `lastBackupOk` is `null` until the first run finishes after server startup.

## Restore

Restore is a manual operation. There's no automation in v1; the steps are short.

1. Stop the isomux service:

   ```
   systemctl --user stop isomux
   ```

2. Move the current state out of the way (don't delete it — keep it as a fallback):

   ```
   mv ~/.isomux ~/.isomux.before-restore
   ```

3. Extract the tarball into `~`:

   ```
   tar -xzf ~/isomux-backups/isomux-YYYY-MM-DD.tar.gz -C ~
   ```

   This recreates `~/.isomux/`.

4. Start isomux:

   ```
   systemctl --user start isomux
   ```

5. Verify the office looks right in the UI. If anything is off, you can swap back: `rm -rf ~/.isomux && mv ~/.isomux.before-restore ~/.isomux`.

### Limitation: SDK transcripts are not in scope

The Claude Agent SDK keeps its own per-session transcripts under `~/.claude/projects/`. The isomux backup does **not** include those, by design — it's a private directory shared across every Claude session on the machine.

The practical consequence is that **resuming an existing session after a restore can be misleading**. Isomux's restored `sessions.json` references session IDs from the backup point, but the SDK's transcripts on disk reflect whatever the office did up until the restore. If you resume that session, the model replies in the context of the SDK's longer transcript, while your UI only shows the older log.

After a restore, prefer **starting fresh sessions** (new conversations) for any agent rather than resuming. Existing JSONL logs in the restored `~/.isomux/logs/` are still readable for reference.
