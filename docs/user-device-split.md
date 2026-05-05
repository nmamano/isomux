# User / Device Split

Separating "user" (the boss/human; same person across logins) from "device" (a connection point; one user has many) throughout the isomux model. Today the two concepts are conflated in a single `username` string ("Nil Phone"), which makes agents see "Nil Phone" and "Nil Laptop" as different bosses and forces user-level preferences to live per-browser in localStorage. This refactor also moves env files (git/gh credentials) from being room-scoped to user-scoped, since "credentials" is fundamentally a property of a person, not a workspace.

> Status: designed, not implemented.

## Problem

The `username` field carries two distinct concepts mashed into one string:

- **Who the boss is** (the human identity) — should be the same across all of one person's devices.
- **Which connection point they're using** (phone vs laptop) — useful context for agents (e.g. "be brief on phone") but not an identity-bearing distinction.

Concretely:

- Agents reading chat see `[Nil Phone]` and `[Nil Laptop]` as two different prefixes and may treat them as different bosses.
- The task system has a `device` field that's actually used to store the boss name (`server/index.ts:198`, system prompt: `Set "device" to the boss name in brackets`). The field is misnamed.
- User-level preferences (default room, room notifications) are stored in localStorage per-browser. Switching from laptop to phone means re-configuring everything.
- There's no way for agents to inspect "who has used this office" because there's no user registry.
- Env files (git/gh credentials, etc.) are scoped to rooms. A room is a workspace organization unit, not an identity — using rooms as a credentials container conflates "where the work happens" with "whose account it gets pushed to." When two users share a room, only one user's credentials apply.

## New model

Four changes, taken together:

1. **`username` and `device` become structurally separate fields** wherever an identity is recorded (chat metadata, WebSocket commands, localStorage). Old combined values like `"Nil Phone"` keep working as-is — no in-place splitting — but new identities are written as a clean pair `{username: "Nil", device: "Phone"}`.

2. **Users become server-side state.** A new `~/.isomux/users.json` file holds per-user preferences (default room, notification rooms, env file path). User records are inspectable by agents as a regular file. localStorage shrinks to two keys: which user am I on this browser, and what's this device's label.

3. **The Device Settings modal splits into User Settings and Device Settings.** User Settings holds name + room defaults + notifications + env file path (data lives on the server). Device Settings holds just the device label (data lives in localStorage).

4. **Env scope moves from room to user.** Rooms keep their per-room prompt but lose their env file. Each user has their own env file path on their record. Agents are stamped with their spawner as `username` and inherit that user's env at spawn time. The agent is told its owner in the system prompt and instructed to warn non-owner bosses before performing credential-using actions (commits, pushes, `gh` API calls). No UI badge — the owner is invisible in the chrome; only the agent knows, and only surfaces it when it's about to matter.

### Data flow at a glance

```
┌────────────┐    cmd: {username, device, ...}     ┌────────────┐
│  browser   │ ──────────────────────────────────▶ │   server   │
│            │                                     │            │
│ localStorage:                                    │ users.json:
│  isomux-username = "Nil"                         │   nil: {
│  isomux-device   = "Phone"                       │     name: "Nil",
└────────────┘ ◀──────────────────────────────────│     defaultRoomId,
                  ws: user_updated event          │     notifRooms,
                                                  │     envFile,
                                                  │     createdAt
                                                  │   }
                                                  │ + on agent spawn:
                                                  │   agent.username = cmd.username
                                                  │   buildSessionEnv reads the
                                                  │   owner's user.envFile
                                                  └────────────┘
```

## Detailed decisions

### Conceptual model

| Decision | Choice |
|---|---|
| Structured pair vs combined string | Separate `username` and `device` fields everywhere |
| User registry | Server-side, one JSON file, agents can read it |
| Device-browser binding | One device per browser (localStorage-bound) |
| Optional device | Yes — single-device users can leave it blank |
| Auth | None — trust the tailnet (consistent with rest of isomux) |
| Identity case-sensitivity | Case-insensitive lookup, preserve display case |

### Field naming

We **keep `username`** as the field name wherever it already exists, to minimize churn:

- `LogEntry.metadata.username` — keeps the name; semantics shifts from "combined" to "just the user". Old log entries with combined values render unchanged because the helper just uses the field as-is (no parsing). New log entries also get `metadata.device` when set.
- WebSocket commands — keep `cmd.username`; add `cmd.device` to the commands that don't already have it (`send_message`, `edit_message`, `send_cronjob_run_message`, `edit_cronjob_run_message`).
- `TaskItem.device` and `Cronjob.device` — both **renamed to `username`**, since the field's actual semantics has always been "the boss's name". No new device field added; tasks and cronjobs only need to record who created them, not what device they were on.
- localStorage — keeps `isomux-username` (semantics shifts); adds `isomux-device`.

### Task / cronjob field semantics post-rename

Today both records carry `createdBy` and `device`. After the rename, both records carry `createdBy` and `username`. Their meanings:

- `createdBy: string` — the actor that performed the create. Agent name (e.g. `"Isomuxer1"`) when an agent created the record via curl/WS, or the user's name when a human created it directly via the UI.
- `username?: string` — the human boss this record is on behalf of. Always set when an agent creates the record (it's the boss who told the agent to). Equal to `createdBy` when a human creates directly via the UI.

Wire/HTTP semantics:

- WS `add_task` / `add_cronjob` already carry both `cmd.username` and `cmd.device`. After this refactor, `cmd.device` is dropped from these commands and the record is built with `createdBy: cmd.username` and `username: cmd.username` for human-direct creates. (Agents creating via HTTP keep their explicit `createdBy` and pass `username` separately.)
- The current line `device: cmd.device ?? cmd.username` (`server/index.ts:198`) becomes just `username: cmd.username` for the server-side WS path.

### UI display of `createdBy` + `username`

The detail-panel subtitle (`TaskView.tsx:248` and parallel cronjob site) renders the pair as:

- If `createdBy === username` (or `username` is unset) → `Nil` (just the boss)
- If they differ (agent created on behalf of a boss) → `Nil · via Isomuxer1` (boss is primary, agent is supporting context)

The third task table column at `TaskView.tsx:624` (today labeled `DEVICE`) is **dropped entirely**. Its info is folded into the `BY` column (today: `createdBy` only):

- `BY` cell when `createdBy === username`: just `Nil`
- `BY` cell when they differ: `Isomuxer1 · for Nil`

Same rule for the cronjob list. Single column carries both the actor and the boss; the third column was redundant in a one-boss office and derivable from a smarter `BY` rendering in a many-boss office.

### Chat-prefix format (what the agent sees)

The server constructs the SDK input string using a single helper:

```ts
function formatPrefix({ username, device }) {
  if (!username) return "";
  if (!device) return `[${username}] `;
  return `[${username} (${device})] `;
}
```

- New chat: `[Nil (Phone)] add task X` when device is set, `[Nil] add task X` otherwise.
- Old log entries (with `username = "Nil Phone"`, no `device`): produce `[Nil Phone] X` — exactly what was originally sent to the SDK, so edit-message matching still works.

The system prompt updates one line:

> Messages are prefixed with the boss's name in brackets, optionally followed by a device in parentheses (e.g. `[Nil]` or `[Nil (Phone)]`).

The system prompt's task-creation curl example currently has:

```
-d '{"title":"...","createdBy":"<agentName>","device":"<boss-name>"}'
```

It becomes:

```
-d '{"title":"...","createdBy":"<agentName>","username":"<boss-name>"}'
```

And the explanatory line `Set "device" to the boss name in brackets...` becomes `Set "username" to the boss name in brackets (e.g. "[Nil (Phone)] add task X" → username:"Nil"). Omit if you can't tell.`

### Display-case handling

The server does **not** canonicalize casing. Whatever the client sends as `cmd.username` reaches the SDK verbatim in the `[Nil]` prefix. If a tab uses weird casing, the user can fix it via User Settings. Lowercase normalization happens only at the lookup-key level (so `Nil` and `nil` resolve to the same record); display case is whatever the client supplied at send time.

Rationale: case is the user's choice on every connection, not server-enforced.

### Server-side user state

A new file `~/.isomux/users.json` keyed by lowercase name:

```ts
interface UserRecord {
  name: string;            // display case, e.g. "Nil"
  defaultRoomId: string | null;
  notifRooms: "all" | string[];
  envFile: string | null;  // absolute path to dotenv file (same shape as room/office today)
  createdAt: number;
}

// File contents: { [lowercaseName: string]: UserRecord }
```

No `lastSeenAt` or `devices[]` — both were considered and rejected. `lastSeenAt` would force a file write on every command for marginal value. `devices[]` adds bookkeeping (when does a device get added/removed?) for marginal agent benefit; agents already see device on each chat message.

`envFile` is an absolute path to a dotenv file the user owns; the server reads and parses it the same way it reads room/office env files today (`readEnvFile` + `validateEnvPath`). Contents stay outside `users.json` to keep secrets out of the inspectable JSON and to let users keep env files in standard locations (e.g. under `~/.config`).

### Agent discoverability

Agents need to know `users.json` exists. The system prompt's discovery section adds a sibling line to the `agents-summary.json` mention:

> How to discover the office's users (boss profiles): read `~/.isomux/users.json`. Keys are lowercase names; each record has display name and per-user preferences (default room, notification rooms, env file path).

### Unified User Management modal

There is no separate picker modal. A single modal — `UserManagementModal` — handles user selection, creation, and per-user setting edits. It opens from a top-bar button and also auto-opens (and stays modal-locked) on first connect when the browser has no `isomux-username` in localStorage.

What the modal shows:

- A list of all known users (server's `users_list`), sorted by display name. Currently-selected user (matching localStorage's `isomux-username`) is highlighted.
- Each row shows the user's name and a compact view of their settings (default room, notif rooms summary).
- Each row has inline editing affordances (or expands to an edit form) so the current viewer can modify any user's settings — name, default room, notif rooms.
- A "Create new user" entry at the bottom opens an inline form for name + initial settings.
- Clicking a different user row triggers a "switch to this user" action — rewrites `isomux-username` in localStorage, closes the modal, and the next command (and subsequent re-fetched per-user settings) reflect the switch.

Anti-duplication: when typing in "Create new user," if the typed name collides case-insensitively with an existing user, show inline error ("User 'Nil' already exists — pick them above instead") rather than auto-merging.

Auth posture (no auth) means any browser can edit any user's record. Documented in the Authorization section.

### Settings sync

When user changes a preference on browser A:

1. Browser sends `update_user` command with the modified field(s).
2. Server writes `users.json`.
3. Server emits a `user_updated` WebSocket event with the new record.
4. All browsers whose self-reported `username` matches the updated user's lowercase key update their local user record.

Field-by-field semantics on receive:

- `notifRooms` — applies immediately (next agent-finish event).
- `defaultRoomId` — sits in state until next page load. (No live re-routing of the open tab.)
- `name` (case change via re-edit) — display updates in chat surfaces.
- `envFile` — applies only to **newly-spawned** agents owned by this user. Already-running agents keep the env they were spawned with; the SDK process won't pick up a new path mid-session. Changing envFile and expecting existing agents to re-credential is a footgun and the User Settings UI should warn ("This applies to new agents only — existing agents keep their current env.").

### Multi-tab and reconnect

- **Two tabs open as same user**: tab A saves → server writes → server broadcasts `user_updated` → tab B's store updates. If tab B has the User Settings modal open with edits, those edits stay in the modal (uncommitted local form state). When tab B saves, last-writer-wins — tab B's values overwrite. There's no merge, no warning. Acceptable because (a) one user is rarely racing themselves, (b) the affected fields are low-stakes (defaults and notif preferences).
- **Reconnect**: on each WS open, server emits `users_list` so the picker (if shown) sees fresh data, and emits the matching `user_updated` for the currently-claimed user so the browser's store is fresh. This covers "left phone open, came back hours later, server has been edited from laptop in between."

### Per-user env files

#### Layering

Today: `process.env → office → room` (later overrides earlier), all merged at agent spawn time in `buildSessionEnv` (`server/agent-manager.ts:978-996`).

After: `process.env → office → user`. Rooms keep their per-room prompt but lose their env file entirely. The user-level env layer reads from the spawning agent's owner's `UserRecord.envFile` (if set).

#### Spawner-owns binding

Every agent gains an owner field:

```ts
// AgentInfo (shared/types.ts) and PersistedAgent (server/persistence.ts)
username: string | null;   // the user who spawned this agent; null only for legacy unowned agents
```

Set at `spawn_agent` time from the spawning command's `cmd.username`. Persisted alongside room/cwd/outfit. Survives restart. Cannot be reassigned (no `change_owner` command — if you want a different owner, spawn a new agent).

`buildSessionEnv` reads the agent's owner, looks up the user record, and merges that user's envFile contents into the merged map. If the owner is null (legacy agent, see migration), the user layer is skipped.

#### Cross-user chat is allowed but not silent

Anyone in the office can chat with any agent. The agent's env stays the owner's regardless of who's typing. To mitigate the "Bob commits as Nil" gotcha without UI nags, the agent's system prompt includes:

> You are owned by the user `<ownerName>`. Your environment (including any git/gh credentials) is `<ownerName>`'s. Bosses other than `<ownerName>` may also send you messages — chat with them normally, but **before performing any action that uses credentials** (commits, pushes, GitHub API calls, gh CLI, npm publish, anything authenticated), pause and confirm with the sending boss that they understand the action will run as `<ownerName>`. If they're fine with it, proceed; if not, stop.

This is system-prompt-driven and probabilistic — the model is being asked to behave responsibly, not blocked by code. Acceptable because: (a) the alternative (per-user partitioning) kills the multi-boss collab story, (b) the office runs on a small trusted tailnet, (c) the worst case is a wrongly-attributed commit that's recoverable.

The owner field is **not surfaced as a UI badge** anywhere — no chrome label on the agent's desk, no header decoration, nothing in the agent list. The agent itself raises the warning only when it's about to matter. Rationale: a persistent badge becomes noise that users scan past; the contextual model-driven warning fires precisely when it's relevant and nowhere else.

#### Office-shared agents (legacy / null owner)

After migration, agents that existed before this refactor have `username: null` (unowned). They run with `process.env → office` only, no user layer. The boss can re-spawn an agent under their own ownership if they want their env applied; there's no in-place "claim" command. Going forward, all newly-spawned agents have an owner.

### Authorization

None. Anyone connected to the tailnet who claims `username: "Nil"` can edit Nil's user record. This matches the rest of isomux's trust model (no auth on the WS, no auth on the task board, no auth on agent commands).

Blast radius after this refactor includes the user's `envFile` path. A malicious tailnet member could rewrite a user's envFile to point at a file containing different credentials, then spawn an agent under that user and have it commit/push as the original user. This is a real escalation over today's "they can edit room defaults" — but the threat model still assumes mutual trust on the tailnet. If at some future point isomux grows multi-tenant or public exposure, a per-user secret guarding `update_user` becomes essential. Out of scope here.

## Wire schema changes (breaking)

This refactor changes the on-the-wire shape of several existing commands and HTTP routes. There is **no compat alias period** — the change ships in one PR, the running server restarts once, and old clients (if any existed) would break. Acceptable because all clients are checked into this repo.

### WebSocket ClientCommand changes

| Command | Today | After |
|---|---|---|
| `send_message` | `{username?}` | `{username?, device?}` |
| `edit_message` | `{username?}` | `{username?, device?}` |
| `send_cronjob_run_message` | `{username?}` | `{username?, device?}` |
| `edit_cronjob_run_message` | `{username?}` | `{username?, device?}` |
| `add_task` | `{username, device?}` | `{username}` (device dropped) |
| `add_cronjob` | `{username, device?}` | `{username}` (device dropped) |
| `run_cronjob_now` | `{id, username, device?}` | `{id, username}` (device dropped — see below) |

The `username` semantics shifts in all cases from "combined Nil Phone" to "just user Nil". The `device` semantics shifts from "boss name" to "actual device label."

New ClientCommand variants:

- `claim_user` — `{username, defaultRoomId?, notifRooms?}` — sent by browser on first connect after migration to seed a user record from localStorage prefs (or to register the user as known). Server creates record with the supplied initial values if absent; ignores them if record already exists.
- `update_user` — `{username, changes: Partial<UserRecord>}` — modifies an existing user record. Broadcasts `user_updated`.

(`select_user` was considered but dropped: there's no server-side session, so "select" is a pure client-side localStorage write. The next command's `cmd.username` reflects the choice.)

### WebSocket ServerMessage additions

- `users_list` — `{users: UserRecord[]}` — pushed on WS open and after any user create/update.
- `user_updated` — `{user: UserRecord}` — pushed when a user record changes (delta-style; client merges into its store).

### HTTP `POST /tasks` body

Today: `{title, createdBy, device?, description?, priority?, assignee?}`.
After: `{title, createdBy, username?, description?, priority?, assignee?}`.

The body field rename mirrors the storage rename. This is a hard break for any external caller posting to `/tasks` — including the curl example in the system prompt, which gets updated as part of this refactor (see "Chat-prefix format" above).

### Room settings lose `envFile`

The `update_room_settings` WS command and the `RoomWire` / `InternalRoom` shapes today carry `envFile: string | null`. After the refactor, `envFile` is dropped from all room shapes and from the command. Rooms still carry `prompt`. Office settings keep `envFile` (the office is not an identity, it's the deployment fallback).

Migration on load (see Migration section) drops any persisted `room.envFile` value with a warning.

### `run_cronjob_now` records `triggeredBy`

Today `runCronjobNow(id, _username, _device)` accepts and ignores the trailing args. The refactor drops `device` from the WS command (above), simplifies the signature to `runCronjobNow(id, username)`, and **wires `username` through to a new `CronjobRun.triggeredBy?: string` field** populated only on manual triggers. Scheduled fires leave `triggeredBy` undefined.

Run history UI shows "Manually triggered by Nil" for runs where `triggeredBy` is set, distinguishing them from scheduled fires. The cronjob scheduled fire path (`cronjob-manager.ts:647` sending `job.prompt` raw) remains unprefixed: there's no boss at fire time, so `formatPrefix` doesn't apply.

## Migration

Six things to migrate, all automatic on first server start / first reload after the change ships (with one being explicitly no-op):

### 1. `~/.isomux/tasks.json` and `cronjobs.json` (server-side, on load)

Walk each record. If `device` field exists and `username` doesn't, copy `device` → `username` and delete `device`. Idempotent. Log a one-line message if any records were migrated.

```ts
if (record.device !== undefined && record.username === undefined) {
  record.username = record.device;
  delete record.device;
}
```

### 2. Existing browsers' localStorage (client-side, on first reload)

Browser detects existing `isomux-username` and the absence of an `isomux-device` key. It sends a `claim_user` WebSocket command with `{username, defaultRoomId, notifRooms}` from current localStorage.

Server behavior:

- If users.json has no record for that lowercase key: create the record with the supplied prefs as initial values.
- If users.json has a record: ignore the supplied prefs (server wins).

After the server acks via `user_updated`, the browser deletes `isomux-default-room` and `isomux-notif-rooms` from localStorage. `isomux-username` stays. `isomux-device` is left empty (the existing combined value like `"Nil Phone"` is treated as the literal username — no auto-splitting).

### 3. Existing log entries (no migration)

Old `LogEntry.metadata.username = "Nil Phone"` stays untouched on disk. The display helper renders them as `[Nil Phone]` (no parens). No data rewrite, no fallback parsing, no special cases beyond "if device is missing, just use username alone."

### 4. Existing agents (legacy unowned)

On server start, every persisted agent without a `username` field gets `username: null`. They run with no per-user env layer (process → office only). The startup log emits a one-line notice: `migrated N agents to unowned (username:null); spawn new agents to apply per-user env`. The boss decides per-agent whether to re-spawn.

### 5. Existing room env files

On server start, walk persisted rooms. Any room with a non-null `envFile` is logged: `room <name> had envFile=<path> (now removed; copy to your User Settings if you still want it applied)`. The field is then deleted from each room and the rooms file is rewritten. One-time, transparent, idempotent (a second restart finds no envFiles to warn about). The boss copies the path into User Settings → env file at their leisure.

### 6. Combined-value manual cleanup

A user whose pre-migration `isomux-username` was `"Nil Phone"` ends up post-migration with:
- User record: `{name: "Nil Phone", ...}` on the server
- Device label: empty in localStorage

Splitting is a two-step manual cleanup the user does once:

1. Open **User Settings**, change name from `"Nil Phone"` to `"Nil"`. This **creates a new user record** under key `nil` with default settings. The old `"nil phone"` record stays as a stale ghost (no auto-merge — agents may have already linked tasks to it).
2. Open **Device Settings**, set device label to `"Phone"`.

The stale `"nil phone"` record can be ignored or deleted manually by editing `users.json`. This is a one-time fix per existing user; future users go through the picker on first connect and never have a combined name.

(An automated split affordance was considered — server detects spaces in `name` on `claim_user` and offers a UI prompt to split — but rejected as scope creep for an issue that affects ~1 person on this codebase.)

## UI: top-bar layout

Today's `DeviceSettingsModal` becomes two modals with two distinct top-bar buttons (flat structure, no nesting).

**User Management** (`UserManagementModal.tsx`, new)
- Unified list/picker/editor — see "Unified User Management modal" above.
- Server-state-backed (`users.json`); reads from store, writes via `update_user`.

**Device Settings** (`DeviceSettingsModal.tsx`, slimmed)
- Device label (text input, optional, placeholder "Phone, Laptop, ...").
- localStorage-backed only.

### Top-bar entry placement

The existing top-bar menu entries (rendered from item lists in `AgentListView.tsx:47`, `OfficeView.tsx:68`, `OfficeView.tsx:76`) replace the single `DeviceIcon` entry with two adjacent entries:

```
{ id: "user",   icon: UserIcon,   label: "User settings",   onClick: onOpenUserSettings },
{ id: "device", icon: DeviceIcon, label: "Device settings", onClick: onOpenDeviceSettings },
```

`App.tsx` gains a parallel `editingUserSettings` state and renders both modals conditionally. The two `onOpen*` callbacks are threaded through `OfficeView` and `AgentListView` props.

Tension acknowledged: on a single device, "User Settings" data is now server-stored but only matters when a browser is connected; no live multi-device synthesis happens. Conceptually it's now a server resource visible across devices and across sessions, which is what matters for the framing.

## Out of scope

- Cross-device live sync of arbitrary state beyond user settings.
- Devices registry per user (`devices: [{label, lastSeenAt}]`).
- Authentication / per-user secrets.
- Username changes after creation that re-key the record (rename a user record from `nil` to `bob`). Today: edit name in User Settings updates display case only or creates a new record if the lowercase key changes.
- Automated split affordance for pre-migration combined values.
- Server-side display-case canonicalization. Client decides casing on every send.
- Multi-tab race protection beyond last-writer-wins.
- Visible owner badge on agents. Owner identity is invisible in the UI; agents raise it via warning only when credential-using actions are imminent.
- Per-user env partitioning at the OS level (e.g. cgroups, separate uids). Out of scope; isomux's process-isolation story belongs to `docs/isolation-design.md`.
- In-place agent ownership reassignment (`change_agent_owner` command). To re-own, spawn a new agent.
- Per-message dynamic env (re-spawning the SDK on user switch). Loses session state; not feasible.

## Implementation surface

For when it's time to code, this touches:

### Shared

- `shared/types.ts` — rename `TaskItem.device` → `TaskItem.username`; rename `Cronjob.device` → `Cronjob.username`. Drop `device` from WS commands `add_task`, `add_cronjob`, `run_cronjob_now`. Add `device?` to `send_message`, `edit_message`, `send_cronjob_run_message`, `edit_cronjob_run_message`. Add `triggeredBy?: string` to `CronjobRun`. Add new `UserRecord` interface (with `envFile: string | null`). Add new ClientCommand variants `claim_user`, `update_user`. Add new ServerMessage variants `users_list`, `user_updated`. Drop `envFile` from `RoomWire`, from the `update_room_settings` command, and from `room_settings_updated` / `request_settings_validation` (room scope). Add `username: string | null` to `AgentInfo`.
- `shared/office-state.ts` — drop `envFile` from `RoomWire` defaults, from `setRoomSettings`, and from related events.
- `shared/identity.ts` (new) — `formatPrefix({username, device})`, `formatIdentity({username, device})`, `lowercaseKey(name)`.

### Server

- `server/users.ts` (new) — load/save `~/.isomux/users.json`, `getUser(name)`, `claimUser(...)`, `updateUser(...)`, `listUsers()`, `getUserEnvFile(name)`. Migration for first-creation case.
- `server/index.ts` — handle new commands `claim_user`, `update_user`. Push `users_list` on WS open. Drop `device` references in `add_task` / `add_cronjob` / `run_cronjob_now` handlers (lines 197-198, ~260, ~290). Update `POST /tasks` body field from `device` to `username`. Add `device` plumbing to `send_message`, `edit_message`, run-message commands. Drop `envFile` from `update_room_settings` handler (lines 142-152) and from the room scope of `request_settings_validation` (lines 170-185); office scope keeps validation.
- `server/agent-manager.ts` — replace inline `[${username}]` construction (lines 1393, 1588, 1596, 1621, 1723) with `formatPrefix(...)`. Update `sendMessage`/`editMessage` signatures to thread `device` through. No display-case normalization on the server side — `cmd.username` reaches the SDK verbatim. Rewrite `buildSessionEnv` (lines 978-996): replace `roomEnvFile` lookup with the agent owner's `users.json[lowercase(agent.username)].envFile`. Drop `room.envFile` field from `InternalRoom` and `setRoomSettings`. Stamp `username` on agent records at spawn from `cmd.username`. Update agents-summary builder to include the agent's `username`.
- `server/cronjob-manager.ts` — same prefix-helper substitution at lines 868, 948, 954, 1058. Update `sendRunMessage`/`editRunMessage` signatures. Simplify `runCronjobNow(id, username)`; populate `CronjobRun.triggeredBy` with that username on manual fires.
- `server/command-handlers.ts` — every slash-command and skill execution builds `{username}` metadata (lines 38, 61, 120, 181, 220, 237, 254, 303, 326, 374, 403, 427-428, 446). Each one needs `device` threaded the same way `sendMessage` does, so slash-command-triggered messages render consistently and edit-matching on them works.
- `server/system-prompt.ts` — update chat-prefix line (line 14), task-creation curl example (lines 22-23), task-creation explanation (line 28), add `users.json` discovery line. Add an "Owner" section that takes the agent's owner from `AgentInfo.username`: when present, inject the credential-warning paragraph from the Per-user env section (referencing the owner by name); when null, omit the section entirely (legacy unowned agents have no per-user env to warn about).
- `server/persistence.ts` — task and cronjob load-time migration (`device` → `username`); add `username: null` to existing persisted agents at load; strip `envFile` from persisted rooms at load with a warning log.

### UI

Display sites:
- `ui/components/LogEntryCard.tsx` — render via `formatIdentity` helper (line 197 area).
- `ui/components/TaskView.tsx` — drop the third column (was `DEVICE` at line 624) entirely. Update `BY` column to render `Nil` when `createdBy === username`, `Isomuxer1 · for Nil` when they differ. Update sort options accordingly. Update detail-panel subtitle (line 248) to render `Nil` or `Nil · via Isomuxer1`.
- `ui/components/CronjobsView.tsx` — same column drop + `BY` rendering update + subtitle update (line 437 area).

Send sites that need `device` threaded:
- `ui/log-view/LogView.tsx:438, 638` — `send_message`, `edit_message`.
- `ui/components/CronjobRunView.tsx` — `send_cronjob_run_message`, `edit_cronjob_run_message`.
- `ui/components/TaskView.tsx:104-112` — `add_task`; today sends `device: username` literally, becomes `username: username`.
- `ui/components/CronjobsView.tsx:271` — `run_cronjob_now`; drop `device`.
- `ui/components/CronjobDialog.tsx:152` — `add_cronjob`; drop `device`.

Settings/onboarding:
- `ui/device-settings.ts` — add `getDevice/setDevice`; remove `getDefaultRoomId/setDefaultRoomId/getNotifRooms/setNotifRooms` (now server-state, accessed via store).
- `ui/components/UserManagementModal.tsx` (new) — unified picker + multi-user editor. Lists all users, lets the viewer switch user, create new, or edit any user's name/default-room/notifs/envFile. The envFile field is a path input mirroring today's room/office env input (with the same validation flow via `request_settings_validation`). Auto-opens (modal-locked) on first connect when localStorage is empty.
- `ui/components/DeviceSettingsModal.tsx` — slimmed to just device label.
- `ui/components/RoomSettingsModal.tsx` — drop the env file field and its validation UI; only the per-room prompt input remains.
- `ui/components/AgentListView.tsx`, `ui/office/OfficeView.tsx`, `ui/App.tsx` — add `onOpenUserSettings` top-bar entry alongside `onOpenDeviceSettings`; render both modals from `App.tsx`.
- `ui/store.tsx` — connect-time logic: if localStorage has `isomux-username` but server has no record, send `claim_user`. If localStorage is empty, the modal opens on receipt of `users_list`. Handle `users_list` and `user_updated` events. Keep all user records in store (so the modal can list them), plus the current user reference. Drop room-envFile fields from the office state.

### Docs and copy

- `docs/backup-restore.md` — add `users.json` to the enumeration at lines 9-15. (The tarball already covers it because it captures all of `~/.isomux/`; this is a doc-completeness fix.)
- `api/chat.ts` (chatbot system prompt) — add a single bullet to the **Full Feature List** (not the highlights / Office View top section) along the lines of: `Per-user profiles — your default room, notification preferences, and credentials follow you wherever you log in from.` Per the marketing-copy-no-impl-details rule, the line describes user capability, not the underlying `users.json`. Not framed as a marquee feature — it's a quality-of-life detail.
- `docs/isolation-design.md` — the room layer table at the top mentions "Per-room prompt + env file (Git/GH identity)". Update to "Per-room prompt" only and note env now lives at the user layer; consider whether the user layer deserves its own row.

## PR sequencing

Decided during implementation. The change is decomposable into a non-breaking server-side prep step (new `users.json` infra, `formatPrefix` helper, optional `device` field on log entries and on existing run-message commands) followed by a breaking step (rename `TaskItem.device` → `username`, HTTP body rename, full UI overhaul, migration). Splitting at that seam is feasible if the implementer prefers staged landing; one combined PR on a worktree is also fine. Not pinned in the doc — pick at coding time based on what's actually convenient.
