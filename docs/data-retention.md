---
description: What an Isomux office keeps when a member deletes something, where copies of office data are, and how to erase all of it.
navTitle: Data retention
---

# Data retention and deletion

**This page is about the data on your own Isomux server, not data that we keep for you. We keep no copy of your office data, and the Isomux software collects no analytics or metrics.**

Isomux does not delete office data on a schedule. Most deletes in the office remove an item from view and keep its data on the server's disk. To erase data, use the full erase below.

This page makes no compliance claim (HIPAA, GDPR or other). For Hosted Isomux, the [Terms](https://isomux.com/hosted-terms) and the [Privacy Policy](https://isomux.com/hosted-privacy) say what happens to the server at cancellation.

## Erase all office data

This is the complete procedure. The lists on the rest of this page help you find data, but they are not complete: a new release can add a store.

1. Stop the Isomux service.
2. Remove the state directory: `~/.isomux` of the server's OS user, or the `ISOMUX_HOME` directory if you set one. A server set up by the installer uses `/home/isomux/.isomux`, and the container uses `/var/data/home/.isomux`.
3. Remove the backups (see [Backups](#backups)).
4. Remove the other copies (see [Copies outside the state directory](#copies-outside-the-state-directory)).
5. Remove the snapshots that your host made of the disk (see [Disk snapshots](#disk-snapshots)).

In the container, the persistent disk at `/var/data` holds the state directory, the backups, the agents' home directory and their projects. Deleting that disk and its snapshots does steps 2 to 5, except for the logs that your container platform keeps.

## What each delete keeps

| Action                                                           | Removed                                                                                      | Kept                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete an app                                                    | The app's service, credentials, thumbnail and secrets file. In the container, its log files. | Its data directory, moved to `apps/data/.retired/<name>-<time>`. On a systemd host, its output in the journal.                                                                                                                                                                                                          |
| Kill an agent                                                    | Its queued messages, its open asks and its token. The agent leaves the office.               | Its settings (a killed agent can be revived), conversations, attachments, memory, browser profile, apps, schedules and webhooks.                                                                                                                                                                                        |
| Start a new conversation (`/clear`)                              | Nothing.                                                                                     | The previous conversation.                                                                                                                                                                                                                                                                                              |
| Remove a member                                                  | Their variables, secrets, MCP servers, push devices, sign-in sessions and sign-in links.     | Their members chat messages, their memory, their personal provider directory (their Claude and Codex sign-ins stay on disk), and their API token conversations. Their API tokens stop working. Their agents, schedules and webhooks pass to the oldest office owner. Their webhooks pass turned off, with a new secret. |
| Edit or delete a task                                            | The old values, or the task.                                                                 | Each earlier value, and a full copy of a deleted task, in the audit log. For a task imported from GitHub, the copy of its issue in `office.sqlite`.                                                                                                                                                                     |
| Unlink a room from GitHub                                        | The link.                                                                                    | The imported tasks, and the copy of each issue in `office.sqlite`.                                                                                                                                                                                                                                                      |
| Edit or delete a members chat message                            | Nothing.                                                                                     | The original text and its attachments.                                                                                                                                                                                                                                                                                  |
| Delete a schedule                                                | The schedule.                                                                                | Its run transcripts and files.                                                                                                                                                                                                                                                                                          |
| Revoke an API token                                              | The token.                                                                                   | Its conversations.                                                                                                                                                                                                                                                                                                      |
| Delete a webhook                                                 | The webhook, its secret and its list of deliveries.                                          | What each delivery passed on, in the conversation that received it.                                                                                                                                                                                                                                                     |
| Remove a variable, secret or MCP server                          | The value.                                                                                   | Nothing.                                                                                                                                                                                                                                                                                                                |
| Replace a memory or instructions (office, room, agent or member) | The old text.                                                                                | Each earlier version in the audit log.                                                                                                                                                                                                                                                                                  |
| Resolve a page                                                   | Nothing.                                                                                     | The page, in the resolved pages log.                                                                                                                                                                                                                                                                                    |

## Storage pruning

An office owner can delete old conversation transcripts, API token conversations, terminal recordings, and the attachments that no remaining transcript uses, in Settings → Housekeeping → Storage. It never runs by itself, and it keeps live conversations and each live agent's newest ones. It does not delete conversation summaries, schedule runs or other data.

## Where office data is

These directories in the state directory hold the most office data:

- `logs/` - conversations, their summaries (in `sessions.json`), chat attachments, screenshots, and schedule run files.
- `browser-profiles/` - the cookies and signed-in sessions of agent browsers.
- `members-chat/` - members chat messages and attachments.
- `office.sqlite` - tasks, the audit log, the rooms' GitHub links, and a copy of each imported GitHub issue's title, body, labels and author.
- `memory/` - office, room, member and agent memory.
- `cronjobs/` - schedule run transcripts.
- `token-logs/` - API token conversations.
- `terminal-recordings/` - recorded terminal sessions.
- `apps/data/` - app data, and `apps/data/.retired/` for deleted apps.
- `provider-homes/`, `codex-home/` and `opencode/` - provider sign-ins and conversations.
- `container-runtime/` - in the container, the office and app logs.

The credential files are listed in the [security audit, section 8.1](security-audit.md#81-state-files).

## Copies outside the state directory

### Backups

By default, Isomux keeps seven daily backups in a directory next to the state directory (`~/isomux-backups` for `~/.isomux`). An office owner can change how often, how many and the directory in Settings → Housekeeping → Storage. `ISOMUX_BACKUP_DIR`, if you set it, fixes the directory. When the directory changes, the earlier backups stay in the old one. `GET /api/backup/status` gives the directory. The backups hold the conversations and the other office data, but not the credential files ([security audit, section 8.2](security-audit.md#82-backups)).

### Other copies

- Provider conversations: `~/.claude/projects` of the server's OS user for Claude, and any `CLAUDE_CONFIG_DIR` or `CODEX_HOME` that a member set to a directory outside the state directory. Backups include only what is in the state directory.
- Agent working directories: the projects that agents make. An agent starts in the home directory of the server's OS user, and can work in any directory.
- Pre-update snapshots: on a server set up by the installer, updaters before release v2026.10.8 kept copies of the whole state directory, credentials included, in `/var/lib/isomux-update/snapshots`. Newer updates keep none, and do not remove the old ones.
- Logs: the systemd journal (office and app output), the Caddy access logs in `/var/log/caddy/` when the installer set up Caddy, and the log stream of your container platform.

## Disk snapshots

Your host keeps disk snapshots for as long as its settings say. Check them and delete them:

- Render: [persistent disks](https://render.com/docs/disks).
- AWS: [EBS snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html), including those that AWS Backup makes.
- Kubernetes: the guide's storage class keeps the volume after its claim is deleted ([reclaim policy](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reclaiming)). Delete the volume and its snapshots in AWS.
- A VPS: your provider's snapshot and backup settings.

## Erasing one record

To remove one record, such as one conversation or one task, is not a reliable erase:

- The audit log keeps the content of tasks, memory, prompts and agent instructions.
- Isomux stores tasks and the audit log in SQLite. A deleted row stays in the free space of `office.sqlite` and in `office.sqlite-wal` until SQLite writes over it.
- The backups and the other copies keep earlier versions.

To be sure that data is gone, use the full erase.
