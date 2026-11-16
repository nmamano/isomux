# Moving an office to another machine

Task 78733adf. The owner moves an office, as it is, from an old machine to a new one: apps, agents with their history, files, and (slice 3) sign-ins and secrets. Only a one-use move code passes through the owner's clipboard. The new office pulls everything else from the old office, box to box. It works without root or SSH, so a Hosted owner can do it too.

The full slice plan and the gaps of the manual move of 2026-11-15 are in the task. This file describes what is built.

## Flow

1. An owner mints a move code on the running old office (`POST /api/office/move/code`, owner browser session only).
2. The new office redeems it (`POST /api/move/redeem`) and gets a move session. That pairs the two offices.
3. The new office runs the preflight on the old office and shows it to the owner.
4. After the owner's yes, the new office locks the old office for the move (`POST /api/move/lock`).
5. The new office pulls the old office's home into a stage and checks it (slice 2b). Slice 2c: `done` (the old office is MOVED), then the swap at boot.

## Move code and session

- Code: `isomux-move-1.` + base64url JSON `{o, t, k}`: the old office's origin, a 256-bit token and a 256-bit AEAD key (slice 2 seals the batches with the key). The mint answer flags a loopback origin, which another machine cannot reach.
- `<state>/office-move.json` (0600) keeps sha256 of the token and of the session, never the token or the session. It keeps the key. The backup leaves it out, and the rescue export (an allowlist) does not copy it.
- The redeem checks the token first. A wrong, used or expired token gets one 403 for all three. Only then does it compare the boxes: a different home path, an older release (CalVer, compared as numbers), or, when either box is not on a release, a different commit, is a 409 that shows both values and does not use up the code. The redeem is rate-limited for callers off the machine. Every public move route reads at most 64 KB of body (413 above).
- Every other `/api/move/*` route takes the session as a bearer token. A wrong or expired session gets 401 `move_session_invalid`.

## States of the old office

`office-move.json` absent is RUNNING. Then:

- `code`: minted, redeemable for 1 h. A new mint replaces it.
- `paired`: redeemed. The session lives 24 h. The owner (or an owner's agent) can cancel with `DELETE /api/office/move`.
- `move`: locked for the move. Nothing expires. Only the cancel by code on the move page ends it.
- `moved`: the new office confirmed its copy (slice 2a, below). Terminal.

Expiry drops `code` and `paired` only (an audit row `office.moveExpired`), at the next request and from a 1 min timer.

## Preflight

`POST /api/move/preflight`, then `GET /api/move/preflight/:id`. One job at a time, async child processes, a time limit per step:

- the agents with a turn in flight;
- the agent-made user units (below);
- the office unit's `Restart=` value;
- per app folder, the files that name the old host (OAuth redirect URIs too), without `node_modules`, `.git` and files over 1 MB (`find` skips them before `grep` reads them);
- `du` per top-level entry of the office user's home;
- the packages the office user installed with sudo (apt history), or unknown.

## The lock

`POST /api/move/lock {preflightId}` refuses unless: the state is `paired`, the preflight is this pairing's, ready, and finished less than 15 min ago, the office unit has `Restart=always`, and no agent works that the preflight did not list (409 `turns_changed`). Then, in order:

1. write `move-units.json` and the state `move` (a failure answers 500, and nothing changed);
2. lock the process and close every socket (as the lockdown route does);
3. audit `office.lockForMove`, answer 202;
4. stop: end the office's leftover processes, stop the apps (the lock's apps record), disable or stop the units.

There is no credential quarantine and no `LOCKDOWN` marker: the sign-ins move with the office. The service manager starts the process again. The boot gate (`moveBootMode`) sees the state `move` and starts the MOVE-locked server (`server/move-locked-office.ts`), which loads no auth state, like the locked office. It serves `/readyz` (locked), `GET /api/move/status` and the move page with its cancel form, which takes the move code.

## Agent-made user units

The office lock does not stop units that agents or members made, for example a tailscaled or an SSH tunnel. The move lists units (unit files and loaded units, templates left out) whose unit file is under the office user's home, and transient units (`systemd-run --user`), without the office's own units and app units. Only service, timer, socket and path units count.

- At the lock: `move-units.json` (0600) records each unit before any change. Units that are exactly `enabled` are disabled with `--now`: under linger, a stopped unit starts again at boot. The other active units are stopped. A linked unit is only stopped, because `disable` removes its link. Transient units are recorded with their command, folder and environment, read from the unit's fragment (`systemctl cat`): `systemctl show` prints the command without quotes, so `bash -c 'a; b'` would lose its words. A command the move cannot read exactly is recorded as unreadable, and the restore reports it.
- At the first normal boot after a cancel, or after a lockdown that won and was unlocked: `enable` for exactly `enabled`, `start` for what was active, `systemd-run` for transient units. A unit that cannot start again is logged.

## Cancel and lockdown

- Cancel by code (move page or JSON): writes `move-cancelled.json`, then deletes `office-move.json`, then restarts. At boot a cancel record wins over a state file that a crash left. The normal boot audits `office.cancelMove`, restarts the apps and restores the units.
- A security lockdown wins: every lock effect deletes `office-move.json` (code, key and session). The units record stays for the unlock's normal boot.

## The pull (slice 2a)

Slice 2 is split in three merges: 2a, the old office serves the pull while it is locked for the move, and the MOVED state; 2b, the new office's side (the owner flow, the pull into a staging folder, the check, `done`); 2c, the swap at boot, the accounts, the after-move report, the units and the wake.

The pull routes exist only in the MOVE-locked server (state `move`, or `moved` for the status). Each takes the move session. In another state they answer 409 `not_locked`.

### Scope

One predicate (`moveScope`, `server/office-move-scope.ts`) decides for the walk and for each batch path. Paths are relative to the office user's home. Nothing follows a symlink.

- Out, not counted: `.cache`, `.bun`, `.npm/_cacache`, `go/pkg/mod`, `.cargo/registry`; the code folder and the backup folder when they are in the home; the move's own files in the state root and its scratch folder `move-pull/`; sockets, fifos and devices (counted as skipped); the `-wal`, `-shm` and `-journal` of a SQLite file, only when the file without the suffix is a SQLite database (a member's `day-journal` moves). The predicate does not touch the disk, so the walk and the batch apply this last rule.
- Out as a sign-in unit, counted per unit for the after-move report (slice 3 adds them back): each entry of `BACKUP_EXCLUSIONS` (its tar globs as a matcher, `*` matches `/` as in tar), so a new backup exclusion is a move exclusion with no second list; each backend credential path at any depth (for example `~/.claude/.credentials.json`); `.ssh`; `.config/gh`; and the files bound to the old office's origin: `sessions.json`, `invites.json`, `api-tokens.json`, `browser-connections.json` (extension pairings), `app-sessions.json`, `web-push.json`.
- Hard links arrive as separate files (as with an rsync without `-H`).

### Routes

- `POST /api/move/manifest` -> 202 `{id}`. A job, one at a time: the walk of a big home takes minutes. A new job deletes the earlier manifests. The walk and the batch use sync calls for metadata and small reads (an awaited call costs a fraction of a millisecond in Bun) and give the event loop a turn every 10 ms. It writes NDJSON to `<state>/move-pull/<id>.ndjson` (0600). One entry: `{p, t: f|d|l, s, m, mode, l?, q?}` (path, type, size, mtime ms, mode, link target, `q: 1` for SQLite: a regular file that starts with the SQLite magic).
- Totals count regular file bytes only, as the new office's free-space check needs.
- `GET /api/move/manifest/:id` -> `{state: running, entries}`, or `ready` with the entry count, the total bytes, the excluded units `{unit, entries, bytes}`, the skipped count, the unreadable paths, the units record, and the secret count (names only, from the secret store).
- `GET /api/move/manifest/:id/data` -> the NDJSON as a sealed stream.
- `POST /api/move/batch {manifestId, batch, items: [{path, offset?, length?}]}` -> a sealed stream of records. The body cap is 1 MB for this route, read only after the session check. A range is allowed only on a regular file that is not SQLite. Each path is checked again: not absolute, no `..`, in scope, its parent's realpath equals `realpath(home)/<parent>`, and the file is opened with `O_NOFOLLOW` and its `fstat` dev/ino compared with the `lstat`, so a swap between the check and the open fails. A SQLite file goes as a `VACUUM INTO` snapshot on a read-only connection (`snapshotOfficeDatabase`; the backup's snapshot is read-only too), so the member's database keeps its journal mode. The snapshot is named per request in the scratch folder and deleted on every path, also when the reader stops in the middle. The snapshot may take 60 s plus 1 s per 10 MB of the database and its WAL. A database the snapshot cannot read in that time, or at all (a damaged file), gets an error record; the new office lists it. A path that fails gets an error record; the stream goes on.
- `POST /api/move/done {manifestId, newOrigin}` -> state `moved`. Needs a ready manifest whose data was served. `newOrigin` must parse as an http(s) URL; only its origin is kept (400 otherwise).

### Records

The plaintext of a batch is a stream of records, not a tar, so the new office needs no tar parser:

- an entry header `{path, t, mode, mtime, link?, q?, offset?}`, then the content as length-prefixed chunks, then a trailer `{bytes, sha256, changed?}`. `changed` is set when the file's size or mtime moved while it was read. A header never promises a size, so a file that grows or shrinks does not break the stream. The new office checks every file against its trailer; for a SQLite entry it compares with the trailer, never with the manifest size.
- an error record `{path, error}`.

### Sealing

AES-256-GCM. Each response starts with a fresh random 32-byte salt. The response key is HKDF-SHA256(code key, salt, "isomux-move-1 seal" + the route context). The nonce is the chunk counter (96 bits), so no nonce repeats across responses or retries and no counter is kept. Frames: u32 length, ciphertext, 16-byte tag, for chunks of up to 1 MiB of plaintext. The AAD holds the route, the manifest id, the batch number, sha256 of the item list, the chunk index and a final flag; the last chunk has the flag (it may be empty), so a cut stream fails.

### MOVED and audit

- `moved` is terminal. The MOVE-locked server shows the MOVED page with the new origin as text (escaped, not a link). The cancel by code from `moved` also needs `confirmMoved: true` (409 `moved_confirm_required`); the page's form has the checkbox and the hard warning (a tailscale node, a Discord bot, a WhatsApp link, cron jobs, webhooks and Claude sessions would run on two machines). Once a batch was served (`servedAt`), the MOVE page warns that the new office may already hold a full copy.
- The MOVE-locked server opens the audit store only for its two rows: `office.movePulled` at the first batch, `office.moveDone` at done.
- N1: the lock writes a marker `move-locked` before the state `move`; the cancel by code deletes it. An unreadable state file boots the MOVE-locked server when the marker is there (no session works, so the page says to ask the operator, who deletes both files) and boots normal without it. A cancel record wins over both.

## The new office (slice 2b)

`server/office-move-in.ts` runs the move on the new office; `server/office-move-stage.ts` writes the stage. There is no UI yet: slice 2c adds it with the swap, so no release offers a flow that leaves the old office locked with no way to use the copy. Slice 2b ends at `staged` and never sends `done`.

### Owner routes

- `POST /api/office/move-in {code}` (owner browser session): refuses a code that does not parse (400), an office that is not fresh (409 `office_not_fresh`, a count per rule: one user who is an owner, removed members included; only the seeded agents, the welcome agents in the first front room and the Receptionist in the lobby, killed agents included; no apps; no tasks), and a state root that is not a real folder in the home. Then the redeem. A refusal of the old office passes through with both boxes, and the code stays usable. A redeem answer without the old office's state root, or with another one, is refused ("update the old office"); that pairing expires on the old office by itself. Then the old office's preflight.
- `GET /api/office/move-in`: the phase and what the owner sees (the old office's preflight, progress, the check), never the session, the key or the code.
- `POST /api/office/move-in/preflight`: the preflight again, in `confirm`.
- A cancel while a start or a preflight again waits for the old office wins: that request writes nothing and answers 409 `cancelled`.
- `POST /api/office/move-in/lock {preflightId}` (owner browser session): the owner's yes. The freshness check again, then the lock. A refusal of the old office (`turns_changed`, `preflight_stale`) passes through, and the phase stays `confirm`.
- `POST /api/office/move-in/pull`: runs a `failed` move again when it is retryable. It asks the old office first: `move` pulls from the start (the stage is wiped), `paired` goes back to `confirm` (the lock never arrived), anything else fails for good.
- `DELETE /api/office/move-in`: deletes the state file and the move-in folder. After the lock, the old office stays locked until its owner cancels with the code.

One move-in at a time: an in-process guard set before the first await.

### Phases

`<state>/office-move-in.json` (0600, one union by phase; the backup leaves it out, and moveScope too): `preflight` -> `confirm` -> `locking` -> `waiting` -> `manifest` -> `pulling` -> `checking` -> `staged`, or `incomplete`, or `failed {error, retryable}`. The redeem in flight is `pairing`, in memory only. The job lives in the process: a boot that finds a job phase sets `failed` (`interrupted`, retryable).

### Requests

Every request goes to the code's origin with `redirect: "error"` (the session must not reach another host), a time limit, and a byte cap on every JSON answer. A request whose answer does not start in the time limit is aborted. A sealed stream fails when no byte comes for the idle limit. Every error of the job ends in `failed`, never an unhandled rejection.

### The pull

1. The manifest data is written, opened, to `<home>/.isomux-move-in/manifest.ndjson`, never held in memory.
2. Free space, before the first batch: every file rounded up to whole blocks, one block per folder, plus 10% or 1 GiB; and free inodes for the entries plus 10%. Short of either: `failed` `no_space`, retryable.
3. Pass 1 (`prepare`) per entry: a path must be relative with plain segments, not twice, and its parent a folder of the manifest. Folders are made 0700 and every file is made empty (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600); links are only listed.
4. Batches of at most 64 MiB and 800 KB of item JSON, 3 at a time. A file over 64 MiB that is not SQLite goes in ranges, one per batch. A batch writes by position into the file pass 1 made (`O_WRONLY|O_NOFOLLOW|O_NONBLOCK`, so a fifo put in the stage cannot block the office; fstat dev/ino checked, the parent's realpath checked), so a retry rewrites its own bytes. The record stream must match the request (order, regular files only, the SQLite flag, the offset, no more bytes than asked); otherwise the whole batch fails and runs again, up to 3 times. An error record of the old office is not asked again.
5. Then modes and mtimes of files by fd (setuid and setgid dropped), then the links (never followed), then folders deepest first.
6. The check comes from the ledger of trailers: each item has one end with the length asked (the manifest size, or for SQLite the trailer's bytes, which the file on disk must have); lstat of the stage comes second. The old office's unreadable paths are missing too. Complete: `staged` and an audit row `office.moveInStaged`; else `incomplete` with the missing paths.
