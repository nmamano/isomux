# Moving an office to another machine

Task 78733adf. The owner moves an office, as it is, from an old machine to a new one: apps, agents with their history, files, and (slice 3) sign-ins and secrets. Only a one-use move code passes through the owner's clipboard. The new office pulls everything else from the old office, box to box. It works without root or SSH, so a Hosted owner can do it too.

The full slice plan and the gaps of the manual move of 2026-11-15 are in the task. This file describes what is built.

## Flow

1. An owner mints a move code on the running old office (`POST /api/office/move/code`, owner browser session only).
2. The new office redeems it (`POST /api/move/redeem`) and gets a move session. That pairs the two offices.
3. The new office runs the preflight on the old office and shows it to the owner (slice 2 has the new office's side).
4. After the owner's yes, the new office locks the old office for the move (`POST /api/move/lock`).
5. Slice 2: the final pull, then the old office is MOVED.

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
