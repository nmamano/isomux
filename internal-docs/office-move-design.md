# Moving an office to another machine

Task 78733adf. The owner moves an office, as it is, from an old machine to a new one: apps, agents with their history, files, and (slice 3) sign-ins and secrets. Only a one-use move code passes through the owner's clipboard. The new office pulls everything else from the old office, box to box. It works without root or SSH, so a Hosted owner can do it too.

The full slice plan and the gaps of the manual move of 2026-11-15 are in the task. This file describes what is built.

## Flow

1. An owner mints a move code on the running old office (`POST /api/office/move/code`, owner browser session only).
2. The new office redeems it (`POST /api/move/redeem`) and gets a move session. That pairs the two offices.
3. The new office runs the preflight on the old office and shows it to the owner. Then it copies the old office while it still runs (the live pass, slice 4a).
4. After the owner's yes, the new office locks the old office for the move (`POST /api/move/lock`).
5. The new office pulls the old office's home into a stage, keeps what the live pass copied and did not change since, and checks it (slices 2b and 4a).
6. The owner finishes: the new office sends `done` (the old office is MOVED), restarts, and swaps the stage in at boot (slice 2c-1).

The owner does steps 1, 2, 4 and 6 in Settings > Move office (slice 2c-2, below).

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
- the packages the office user installed with sudo (apt history), or unknown;
- the members with their own OS user (slice 3): their names (the id when no user has it, sorted), or `broken` when the record cannot be read. Slice 5c-1 adds `members`: per member her OS user, home, units and why her home cannot move now (below).

## The lock

`POST /api/move/lock {preflightId}` refuses unless: the state is `paired`, the preflight is this pairing's, ready, and finished less than 15 min ago, the office unit has `Restart=always`, no member with their own OS user is blocked (read at the lock, not from the preflight: 409 `member_os_users` with `names` and `members`, or `broken`; slice 5c-1, below), the folders outside the home that move are the preflight's (409 `folders_changed`, slice 5b), and no agent works that the preflight did not list (409 `turns_changed`). Then, in order:

1. write `move-member-units.json` (slice 5c-1), `move-units.json` and the state `move` (a failure answers 500, and nothing changed);
2. lock the process and close every socket (as the lockdown route does);
3. audit `office.lockForMove`, answer 202;
4. stop: stop or disable the units of each member with their own OS user, through their runner; end the office's leftover processes, stop the apps (the lock's apps record, members' apps included), disable or stop the units.

There is no credential quarantine and no `LOCKDOWN` marker: the sign-ins move with the office. The service manager starts the process again. The boot gate (`moveBootMode`) sees the state `move` and starts the MOVE-locked server (`server/move-locked-office.ts`), which loads no auth state, like the locked office. It serves `/readyz` (locked), `GET /api/move/status` and the move page with its cancel form, which takes the move code.

## Agent-made user units

The office lock does not stop units that agents or members made, for example a tailscaled or an SSH tunnel. The move lists units (unit files and loaded units, templates left out) whose unit file is under the office user's home, and transient units (`systemd-run --user`), without the office's own units and app units. Only service, timer, socket and path units count.

- At the lock: `move-units.json` (0600) records each unit before any change. Units that are exactly `enabled` are disabled with `--now`: under linger, a stopped unit starts again at boot. The other active units are stopped. A linked unit is only stopped, because `disable` removes its link. Transient units are recorded with their command, folder and environment, read from the unit's fragment (`systemctl cat`): `systemctl show` prints the command without quotes, so `bash -c 'a; b'` would lose its words. A command the move cannot read exactly is recorded as unreadable, and the restore reports it.
- At the first normal boot after a cancel, or after a lockdown that won and was unlocked: `enable` for exactly `enabled`, `start` for what was active, `systemd-run` for transient units. A unit that cannot start again is logged.
- Testing: a live run of the lock (the live pass of slice 4a included) never runs under a user manager that other work shares, such as a development box's office user: the lock stops every transient unit of that manager.

## Cancel and lockdown

- Cancel by code (move page or JSON): writes `move-cancelled.json`, then deletes `office-move.json`, then restarts. At boot a cancel record wins over a state file that a crash left. The normal boot audits `office.cancelMove`, restarts the apps and restores the units.
- A security lockdown wins: every lock effect deletes `office-move.json` (code, key and session). The units record stays for the unlock's normal boot.

## The pull (slice 2a)

Slice 2 is split in four merges: 2a, the old office serves the pull while it is locked for the move, and the MOVED state; 2b, the new office's side (the owner flow, the pull into a staging folder, the check); 2c-1, `done`, the swap at boot, the accounts, the after-move report, the units and the wake; 2c-2, the UI on both offices.

The pull routes are served by the MOVE-locked server (state `move`) and, for the live pass (slice 4a), by the running office in `paired`; `done` needs `move`. Each takes the move session. In another state they answer 409 `not_locked`. One function serves both (`servePull`, `server/move-locked-office.ts`).

### Scope

One predicate (`moveScope`, `server/office-move-scope.ts`) decides for the walk and for each batch path. Paths are relative to the office user's home. Nothing follows a symlink.

- Out, not counted: `.cache`, `.bun`, `.npm/_cacache`, `go/pkg/mod`, `.cargo/registry`; the code folder and the backup folder when they are in the home; the move's own files in the state root and its scratch folder `move-pull/`; sockets, fifos and devices (counted as skipped); the `-wal`, `-shm` and `-journal` of a SQLite file, only when the file without the suffix is a SQLite database (a member's `day-journal` moves). The predicate does not touch the disk, so the walk and the batch apply this last rule.
- Out as a bound unit (slice 3), counted per unit for the after-move report, and kept from the new box by the swap: the files bound to the old office's origin, each with its `.tmp` and `.corrupt-*` siblings in the state root (`sessions.json` browser-sessions, `app-sessions.json`, `invites.json`, `browser-connections.json` extension-pairings, `web-push.json`), and the home's own `.ssh/authorized_keys` and `authorized_keys2` (ssh-authorized-keys: the Hosted control plane writes its own line in the new box's file, and the old box's keys must not open the new box). The bound rules match first.
- Sign-ins and secrets move (slice 3): every id of `BACKUP_EXCLUSIONS` and `BACKEND_CREDENTIAL_PATHS` is in `MOVE_CARRIED_UNITS` or `MOVE_BOUND_UNITS`, and a test fails for an id in neither. An id in neither stays on the old box under its own id. The rest of `.ssh`, `.config/gh` and `api-tokens.json` move. The old box keeps its copies, locked. The final pass fetches the credential files again even when the manifests agree (slice 4a, `moveAlwaysFetch`).
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

`server/office-move-in.ts` runs the move on the new office; `server/office-move-stage.ts` writes the stage.

### Owner routes

- `POST /api/office/move-in {code}` (owner browser session): refuses a code that does not parse (400), an office that is not fresh (409 `office_not_fresh`, a count per rule: one user who is an owner, removed members included; only the seeded agents, the welcome agents in the first front room and the Receptionist in the lobby, killed agents included; no apps; no tasks), and a state root that is not a real folder in the home. Then the redeem. A refusal of the old office passes through with both boxes, and the code stays usable. A redeem answer without the old office's state root, or with another one, is refused ("update the old office"); that pairing expires on the old office by itself. Then the old office's preflight.
- `GET /api/office/move-in`: the phase and what the owner sees (the old office's preflight, progress, the check), never the session, the key or the code.
- `POST /api/office/move-in/preflight`: the preflight again, in `confirm`.
- A cancel while a start or a preflight again waits for the old office wins: that request writes nothing and answers 409 `cancelled`. A cancel while a finish runs answers 409 `move_in_finishing`: the finish may already have sent `done`.
- `POST /api/office/move-in/lock {preflightId}` (owner browser session): the owner's yes. The freshness check again, then the lock. A refusal of the old office (`turns_changed`, `preflight_stale`) passes through, and the phase stays `confirm`.
- `POST /api/office/move-in/finish {acceptMissing?}` (owner browser session, slice 2c-1): below, "Finish and the swap".
- `POST /api/office/move-in/pull`: runs a `failed` move again when it is retryable. It asks the old office first: `move` pulls again (keeping what the last pass copied, slice 4a), `paired` goes back to `confirm` (the lock never arrived), anything else fails for good.
- `POST /api/office/move-in/live` (slice 4a): the live pass again, in `confirm` with no live pass running.
- `DELETE /api/office/move-in`: deletes the state file and the move-in folder. After the lock, the old office stays locked until its owner cancels with the code. Refused while the move ends (`finishing`, `swapping`). In `moved` it deletes the report and the fresh office set aside.

One move-in at a time: an in-process guard set before the first await.

### Phases

`<state>/office-move-in.json` (0600, one union by phase; the backup leaves it out, and moveScope too): `preflight` -> `confirm` -> `locking` -> `waiting` -> `manifest` -> `pulling` -> `checking` -> `staged`, or `incomplete`, or `failed {error, retryable}`; then `finishing` -> `swapping` -> `moved` (slice 2c-1). The redeem in flight is `pairing`, in memory only. The job lives in the process: a boot that finds a job phase sets `failed` (`interrupted`, retryable).

### Requests

Every request goes to the code's origin with `redirect: "error"` (the session must not reach another host), a time limit, and a byte cap on every JSON answer. A request whose answer does not start in the time limit is aborted. A sealed stream fails when no byte comes for the idle limit. Every error of the job ends in `failed`, never an unhandled rejection.

### The pull

1. The manifest data is written, opened, to `<home>/.isomux-move-in/manifest.ndjson`, never held in memory.
2. Free space, before the first batch: every file rounded up to whole blocks, one block per folder, plus 10% or 1 GiB; and free inodes for the entries plus 10%. Short of either: `failed` `no_space`, retryable.
3. Pass 1 (`prepare`) per entry: a path must be relative with plain segments, not twice, and its parent a folder of the manifest. Folders are made 0700 and every file is made empty (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600); links are only listed.
4. Batches of at most 64 MiB and 800 KB of item JSON, 3 at a time. A file over 64 MiB that is not SQLite goes in ranges, one per batch. A batch writes by position into the file pass 1 made (`O_WRONLY|O_NOFOLLOW|O_NONBLOCK`, so a fifo put in the stage cannot block the office; fstat dev/ino checked, the parent's realpath checked), so a retry rewrites its own bytes. The record stream must match the request (order, regular files only, the SQLite flag, the offset, no more bytes than asked); otherwise the whole batch fails and runs again, up to 3 times. An error record of the old office is not asked again.
5. Then modes and mtimes of files by fd (setuid and setgid dropped), then the links (never followed), then folders deepest first.
6. The check comes from the ledger of trailers: each item has one end with the length asked (the manifest size, or for SQLite the trailer's bytes, which the file on disk must have); lstat of the stage comes second. The old office's unreadable paths are missing too. Complete: `staged` and an audit row `office.moveInStaged`; else `incomplete` with the missing paths.

## The live pass (slice 4a)

The same pull twice: a live pass while the old office still runs, then the final pass after the lock fetches only what changed. The manual move of 2026-11-15 took 28.6 min live and 4.6 min after the lock.

### The old office

- The running office serves `manifest`, its status and data, and `batch` in `paired` (`OfficeMoveRouteDeps.pull`, the same scope and scratch folder as the MOVE-locked server).
- In `paired` a batch takes no SQLite snapshot: a file whose first bytes are the SQLite magic gets an error record. The old office decides by the bytes it opens, not by the request.
- `servedAt` is set at the first batch of either pass, and the lock keeps it. `office.movePulled` is audited once. `GET /api/office/move` shows `servedAt`; the MOVE page's warning that the new office may hold a copy follows it.
- An ended pairing (expiry, the owner's cancel, a lockdown) aborts every walk and batch stream of the pairing (`endPull`) and deletes the scratch folder, which lists every path. The backup leaves the scratch folder out.

### The new office

- The live pass starts at the first `confirm` of a pairing, in its own job slot. Its state is `live` in phases `preflight` and `confirm`: `manifest`, `copying`, `ready`, `stopped` (the lock stopped it), `failed`, or `unsupported` (an old office of an older release answers 404). One writer each: `writeLive` for `live`, `writePre` for the phases, which reads `live` from the state at write time.
- It asks for no SQLite file and does not finish or check the stage. When it is `ready`, the preflight runs again, so Lock works at once with a fresh preflight.
- The lock sets the busy flag, stops the live pass and waits for its end, then locks. A cancel in that wait ends both, and the lock answers `cancelled`.

### The ledger and the keep rule

- After its batches, whatever the end except a cancel, a pass writes `<home>/.isomux-move-in/ledger.ndjson` in the order of its manifest: `{p, s, m, ino}` per regular file that came whole and clean (no error, not `changed`, the size of the manifest, and the header's mtime equal to the manifest's). So a row describes the bytes in the stage.
- The next pass moves the stage and the ledger aside (`stage.prev`, `ledger.prev.ndjson`) and makes a new stage. It reads the ledger in step with its manifest (`compareMoveWalkOrder`, the walk's order), so its memory stays flat. A file is kept when the row has the same path, size and mtime as the new manifest, the file is not SQLite in the new manifest, and `moveAlwaysFetch` does not name it (the sign-ins and secrets that move, `.ssh`, `.config/gh`, `api-tokens.json`, and names that end in `-wal`, `-shm` or `-journal`). Then `stage.keep` checks the old stage's file (a regular file with the row's inode under a real folder), renames it into the new stage, and checks it again. Anything else is fetched. A pass that fails or stops still walks the rest of its manifest with no batch, making the folders and keeping what it can, so the next pass does not fetch again what the last one copied. What stays in `stage.prev` is deleted.
- The free-space check counts only what the pass fetches. A crash during a pass leaves no ledger: the next pass fetches everything.
- Accepted gaps: a file rewritten with the same size and the same mtime is kept (the rsync rule; mtimes are compared below the millisecond). A change of mode only is not fetched: the final manifest's mode is applied. An append to a big file (an agent log) fetches the whole file again; ranges of a changed file are a later option.

## Finish and the swap (slice 2c-1)

`server/office-move-swap.ts` swaps; `server/move-swap-failed-office.ts` serves a failed swap.

### Finish

`POST /api/office/move-in/finish {acceptMissing?}` takes `staged`, or `incomplete` with `acceptMissing: true` (409 `copy_incomplete` otherwise). Every refusal comes before `done`: the office unit must have `Restart=always` (409 `restart_policy`, checked at the start too), the office must still be fresh, and the dry run of the swap must pass: the walk of the fresh home (at most 200,000 entries, `home_too_big`), every rename on the home's device (`home_has_mounts`), and no old member with the id of the owner who finishes (`account_clash`). Then:

1. phase `finishing`;
2. `POST /api/move/done {manifestId, newOrigin}` (the public origin, else the origin of the owner's request). No 200: `GET /api/move/status`. `moved` goes on; `move` or no answer goes back to `staged`/`incomplete` with `done_failed` (finish again); any other answer is `failed`, not retryable;
3. `<home>/.isomux-move-in/swap.json` with the swap's inputs only, then phase `swapping`, 202, and a restart (`restartOfficeProcess`, the one self-restart of the office).

A boot that finds `finishing` goes back to `staged`/`incomplete` with the stage; finish again asks the old office. It never pulls again.

### The swap

At boot, first in `runOfficeMain`, before any state module reads the disk. swap.json absent: nothing.

- Keep: every path of the fresh home that this box's move scope leaves out (the code folder, caches, the bound units, the move's own files, the move-in folder, sockets), the office id, and this office's own user unit (its file, its `.d` folder, its links in `*.wants`). `office-move-in.json` is one of the move's own files, so it stays in place across the swap. The walk's SQLite side-file rule does not apply: a fresh `-wal` goes aside with the fresh database.
- Ops, computed at the first swap boot from the home as it is then, and stored in swap.json before the first rename: the old office's own unit (named in its redeem answer) is dropped from the stage to `aside/.from-stage`; then, level by level, an entry with a kept path inside is entered; a kept path stays, and the stage's entry there goes to `aside/.from-stage`; any other entry goes `aside` (the fresh one) and `in` (the old one) whole.
- Each op is one rename and runs again with no effect. An `in` whose place is taken by an entry no op sets aside fails before any rename. A stage entry left after the ops fails too.
- Then: `users.json` is the old office's plus the fresh owner, kept with its id (a name clash, also with a removed member of the old office, renames it "<name> new machine"); `office-config.json` is the old office's with this machine's value of each key in `OFFICE_CONFIG_BOX_KEYS` (persistence.ts); the fresh office's backups are deleted (backup names only); `move-units.json` gets the old office's units record; the state becomes `moved` with the report; swap.json is deleted last. A crash at any step resumes at the next boot with the same result.
- A failed op or step boots the swap-failed server: `/readyz`, a page with the error (the log line also names the step), and `POST /move-in/retry` (at most once per 30 s), which restarts the office so the swap resumes. No state module loads. It listens on loopback unless this office listened beyond it when the owner finished (swap.json keeps that): the state root may hold the old office's network settings by then.

The kept `sessions.json` keeps the owner who finished signed in on the moved office: a session is a token hash keyed by the user id, and that account is kept with its id. This replaces the one-use sign-in link of the plan. `/var/lib/isomux-install/owner-id` still names an owner.

### The first boot after the swap

- The app units came with the old office's home and name its machine: every app's launcher and unit is written again, before the token, address and secrets passes.
- `systemctl --user daemon-reload`, then the units restore from `move-units.json` (as after a cancel); the result goes in the report. A crash between the restore and the report's write leaves the report with no units restored: the restore deleted its record.
- The apps the lock stopped start (`apps-stopped-by-lock.json` came with the copy), and the restart wake wakes the turns the lock cut (`turns-in-flight.json` came with the copy; the lock stops through SIGTERM, which keeps it).
- `office.moveInSwapped` is audited once.

### The report

`GET /api/office/move-in` in `moved`: the old origin, who finished and when, the units left out with counts (the old office's `excluded`; an old office of slice 2 also lists its sign-ins), the secrets to set again (only when the old office left the secret store out), the missing paths the owner accepted, the fresh owner's new name after a clash, the old office's unit set aside, the units put back, and the top-level entries and size of the aside folder.

## Folders outside the home (slice 5b)

`server/office-move-outside.ts`. The move also copies the folders outside the office user's home that the office's records name. 5b-1 is the server; 5b-2 the UI (the Settings pane section).

### The old office

- Candidates: the folder of each agent (killed agents kept for revive included), of each saved session, room, app and app data folder, and schedule. `collectMoveOutsideFolders` applies the rules in this order: resolve each path (a path that is not absolute is dropped); drop a path in the home, a missing path and a path that is not a folder; give the left reasons; then fold.
- Left reasons: `temp` (at or below `/tmp`, `/var/tmp`, `/dev/shm` or `/run`: scratch the box clears), `link` (a link on the path: the realpath is not the path), `office` (it holds or is inside the home, the state root, the code folder or the backup folder), `owner` (another user owns it; this covers a member's own OS user, slice 5c).
- The fold: a candidate inside a folder that moves is listed nowhere (it travels in that folder's walk). A left folder is listed only when no ancestor moves. Only a named folder moves, never its parent.
- The preflight lists `outsideFolders {move: [{path, mode, bytes, timedOut}], left}`. The sizes are a `du -sxb` estimate (it stops at mount points; the walk does not).
- The lock reads the list again and refuses 409 `folders_changed` when the folders that move differ from the preflight's (a change of the left list only does not refuse). It records them in the state `move` (`outside`), and the MOVE-locked server, which loads no records, walks that list.
- A manifest job reads the list once at its start, so a batch never reads a folder the walk did not list. It walks the home, then each folder (a folder that is a link or not a folder then fails the job), each into its own NDJSON. A ready status adds `outside: [{path, mode, mtime, entries, totalBytes, excluded, skipped, unreadable}]`; paths in a folder's manifest are relative to it. `GET .../data?outside=<i>` and a batch's `outside: i` index the job's own list, never the live records. In a folder, the scope is everything but specials and a top-level `.isomux-move-in`; a later pass fetches again only the SQLite side files. At each batch the folder must still be its own realpath, else every item gets an error record.
- The seal context adds the index only for a folder, so the home's context string is the one of an office before slice 5b.

### The new office

- `checkMoveInFolder` (reads only): every existing part of the path from `/` down must be a real folder (`link`, `not_dir`), owned by root or the office user (`owner`), and not writable by others, or by a group other than root's and the office user's, without the sticky bit (`unsafe_parent`). The folder itself, when it exists, must be the office user's (`owner`, with a `sudo chown` command) and hold nothing but `.isomux-move-in` (`not_empty`), and be readable (`no_write`). When it is absent, its deepest existing part must be writable by the office user (`no_write`, with a `sudo install -d` command). A path in the home or holding it is `in_home`.
- `GET /api/office/move-in` in `confirm` carries `outsideChecks`, computed at each request: the old office's path in `path`, this box's paths in `at`, `create` and `command`. The lock refuses 409 `outside_folders_blocked` with the checks and sends nothing. The lock keeps the preflight's folders in the pairing (`outside`). In `failed` with error code `outside_folders_blocked`, the status carries `outsideChecks` again, for the folders the lock kept (slice 5b-2).
- Each pass first compares the manifest's folders with the checked ones (`outside_folders_changed`, retryable), checks each folder again (`outside_folders_blocked`, retryable), removes the stage of a recorded folder that the manifest does not list (a live pass can stage a folder the final list drops), then records and makes the missing folders. Nothing is written in a folder before these checks.
- `<home>/.isomux-move-in/outside.json` records every folder where this box made a `.isomux-move-in`, and every folder it made. A cancel and DELETE remove each recorded stage, then each made folder, deepest first and only when empty; a made folder that is not empty stays recorded.
- The stage of a folder is `<folder>/.isomux-move-in/stage`, on the folder's file system. A pass runs the home, then each folder, with its own manifest, ledger and keep rule. Free space and inodes are checked per device (the home's first, one statfs per device) before the first batch. A missing path of a folder is shown absolute, as on the old office.
- Test seams: `MoveInDeps.outsideRoot` (put in front of every outside path, since both test offices share one disk), `folderFs`, `deviceOf`; `MoveInBox.osUser`.

### The swap

- `swap.json` gets `outside: [{path, mode, mtime}]` at this box's path. The plan adds one `outside` op per top-level entry of each folder's stage (a rename into the folder).
- Before any rename, an entry in a folder that is not its stage and not an entry an earlier run of the swap put there fails the swap with its path. Finish's dry run refuses the same first (409 `outside_folder_not_empty`).
- After the ops: each folder's `.isomux-move-in` and `outside.json` go, then each folder gets its old mode and mtime.
- The report has `outsideMoved` and `outsideLeft` (from the preflight the owner agreed to).

## Members with their own OS user (slice 5c)

`server/office-move-members.ts` (the old office), `server/member-home-send.ts` (her runner's side, in the runner bundle), `server/office-move-member-wiring.ts` (production deps). The office cannot read the home of a member with their own OS user, so her runner lists it and sends its files, as her. 5c-1 is the old office; 5c-2 the new office (her home waits as office data until root runs the enable command there, which places it through her new runner); 5c-3 the UI.

### The check (5c-1)

`checkMoveMembers`, at the preflight and again at the lock. A member is blocked, with a reason, when her record is malformed (`broken`), her enable did not finish (`unfinished`), an enable or disable runs for her (`busy`), she came with a move and the enable command has not run here (`moved_in`), passwd gives no safe home (`bad_home`: absolute, normalised, not `/`, not holding or inside the office home or the state root, a real folder owned by her uid), her runner does not answer (`runner_down`), answers with another uid, user or home (`wrong_runner`), or runs another runtime than this office's bundle (`old_runtime`). The lock refuses while any member is blocked, and records the ready members (uid, home, runtime hash) in the state `move` as `members`: the MOVE-locked server loads no records.

### Her units (5c-1)

Her agent-made user units are listed through her runner as the office's are (her home, her uid's transient folder, the app units left out). The lock writes `move-member-units.json` (0600) before any change, then stops and disables them through her runner; the MOVE-locked boot does it again. After a normal boot (a cancel, an unlock), her units come back at her runner's first connect, and her entry goes. The file is in the move's scope: the new office restores her units after the enable command places her home (5c-2). A known limit: the listing at the preflight and the stop at the lock are synchronous runner calls, and a member who hangs her own user bus can block the office's event loop for up to 5 s per call, only while an owner runs the preflight or the lock.

### The pull (5c-1)

- Her runner's entries: `home-list` (an lstat walk of her home in the manifest's walk order, never into a link; specials as `x`, unreadable paths as `{u}`, then an end line) and `home-files` (the asked files as u32-length frames: a header, exactly `size` bytes, a trailer; or an error frame; a zero length ends; a file that shrinks after its header ends the call). A SQLite file goes as a `VACUUM INTO` snapshot in `.isomux-agent/.move-out/` in the state `move`, and as an error while paired. Each call takes a 32-hex nonce; `home-files` first removes the snapshots a crashed call left. The home must be its own realpath.
- Scope (`memberHomeScope`): out, the home caches of the office's scope and what the office writes again in her agent space (`MEMBER_SPACE_OWN_LOCATIONS` under `.isomux-agent/`); bound, `.ssh/authorized_keys(2)`. Her sign-ins move.
- Every reply is member data. The office checks each line (a plain relative path, strict walk order, its folder listed, in scope, at most 64 KB) and fails her walk, and the pass, naming her, on any other line, a missing end line, more than 10,000 unreadable paths (kept in memory for the status), or less than 1 GiB free where the manifest is written (checked every 10 MB). Only `f`, `d` and `l` lines reach the manifest. In a batch it asks her runner only for items it could have listed, and the first frame that does not match the request (index, path, offset, size, a SQLite flag where none may come) ends the batch with an error record for that item and every later one. It computes the sha256 itself.
- Each stream asks her runner's info first (uid, user, home and runtime hash as recorded) with a time limit, then runs the entry with a 60 s stall limit and a 60 min total limit.
- The manifest job reads the members once at its start (in `paired`, the ready members of the last check; in `move`, the state's), and walks each into its own NDJSON. A ready status adds `members: [{userId, osUser, home, entries, totalBytes, excluded, skipped, unreadable}]`. `GET .../data?member=<i>` and a batch's `member: i` index the job's list (not with `outside`). The seal context adds `member:<i>`.
- Until 5c-2, the new office fails a pass whose manifest lists members (`member_homes_unsupported`).

## The Settings pane (slice 2c-2)

Settings > Office > Move office, owners only, on Hosted too: `ui/components/OfficeMovePane.tsx`, with its logic in `ui/office-move.ts`. The wire types of the move routes are in `shared/office-move.ts`.

- Two cards. The move-out card mints the code and shows it once (in memory only, never stored), with a warning when its origin is loopback, then the code's expiry or the pairing, and a cancel. The move-in card shows the status by phase: the start form (or the blocker), the old office's preflight with Lock and Check again, the copy's progress, the check with Finish (and "finish without these files" on an incomplete copy), a failure with Try again, the restart, and the report with the delete of the aside folder.
- The move-in card comes first on a new office and whenever a move-in runs or is done.
- `GET /api/office/move-in` in phase `none` carries `blocker`: the start's own refusal before the redeem (`startBlocker`: not fresh, the restart policy, the state root), so the owner sees it before minting a code. Every phase from `preflight` on carries `oldOfficeLocked` (the cancel's own expression), and `moved` carries `asidePath`.
- The routes emit nothing, so each card polls while something runs (move-in 2 s, move-out 5 s). An answer with `X-Isomux-Locked` (`ApiError.locked`) reloads the page: the old office after its lock shows the MOVE page, and a failed swap shows its page with Try again. Through the restart after Finish, poll errors are silent; after 5 min with no answer the card says the office has not come back and offers a reload.
- The old office's preflight comes from its release, so the card reads it through a guard (`preflightView`): each part is its shape or unknown. Lock is enabled only when the old office's unit has `Restart=always` and the old office reports no member with their own OS user and can read them (slice 3; an old office of a release without that part reports nothing and does not refuse, so Lock is enabled then).
- Finish, a cancel and the delete of the aside folder ask first, in place. A cancel after the lock says the old office stays locked until its owner enters the move code there.
- The live pass in the pane (slice 4b): the confirm card shows `live` by phase (`LiveView`), with its progress while it copies and Copy again (`POST /api/office/move-in/live`) after a pass that ended (`ready`, `stopped`, `failed`). Lock stays enabled: the lock stops the live pass. The card polls in `confirm` while the live pass lists or copies. Progress counts the bytes kept from the last pass (`copiedBytes`), and the final copy says how many files it kept. A write error the confirm card got goes away when a status brings another preflight id: after the live pass is `ready`, the new office checks again and the old office forgets the earlier id, so a Lock in that window gets `preflight_stale` or `not_confirming`, and the owner presses Lock on the new check. The move-out card in `paired` with `servedAt` says when the copy started, that it holds the sign-ins and secrets, and that a cancel there does not delete it.
- The report's "left behind" list (`leftBehindLines`, slice 3): one sentence per bound unit with entries, in `LEFT_BEHIND_ORDER` (app-sessions gives none: apps sign in again through the office); a unit this release does not name keeps the line with its id and count; the secrets line last.
- The folders outside the home in the pane (slice 5b-2): the confirm card lists `status.outsideChecks` (the list the lock checks and the pass moves) with the preflight's size joined by path (`outsideLines`; the preflight's part is read whole or unknown, a left reason this release does not name keeps its folder). A folder that cannot land shows why and, when the check has one, the root command with a copy button. Lock is off and the card polls while a check is not ok, so the owner's fix shows by itself; the size line adds the folders' bytes. The folders left are listed. A pass that failed with `outside_folders_blocked` carries the checks again in `failed` (the folders the lock kept, checked at each GET): the failed card lists the blocked ones and polls until they clear. A lock refused with `folders_changed` puts Check again first. The report lists `outsideMoved` and `outsideLeft`.
