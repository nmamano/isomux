# Per-Room Environment Variables and Prompt Hierarchy

Design doc for per-room env vars and a layered prompt system.

## Problem

Three users share one isomux office (same Linux user). Each user's agents live in their own room. Agents need to commit and push using different GitHub identities, but there's no mechanism for per-room environment variables. The prompt system is also flat — office-wide prompt plus per-agent custom instructions, with no room layer.

## Decisions

### Prompt hierarchy: office → room → agent

Three layers, concatenated in order with clear headers. No layer overrides another; they accumulate. The agent sees all three.

- **Office prompt** — already exists, now stored in `~/.isomux/office-config.json` (see Storage below)
- **Room prompt** — new, stored inline on `Room`
- **Agent prompt** — already exists (`customInstructions` field on agent)

### Env hierarchy: office → room

Two layers. Shallow merge — room env overrides matching keys from office env. Unset keys fall through.

- **Office env** — new, loaded from a user-specified file path
- **Room env** — new, loaded from a user-specified file path

No per-agent env. Identity is per-room (all agents in a room act as the same user). Adding per-agent env later is trivial (new `envFile` field on the agent type).

### Env files are user-managed, paths are absolute

Isomux does not own or manage an env directory. The user creates env files wherever they want and provides absolute paths. Isomux reads from those paths at spawn time. Standard dotenv format.

Example:

```
# /home/nil/.secrets/marc.env
GH_TOKEN=ghp_...
GIT_AUTHOR_NAME=Marc
GIT_AUTHOR_EMAIL=marc@example.com
GIT_COMMITTER_NAME=Marc
GIT_COMMITTER_EMAIL=marc@example.com
```

### Env merge semantics

At spawn time:

```
merged = { ...process.env, ...officeEnv, ...roomEnv }
```

- Room env beats office env beats `process.env`.
- An explicit empty-string value overrides (does not fall through). To inherit, omit the key.
- No blocklist. Office/room env can override any key, including `PATH`, `HOME`, `SHELL`, etc. Users are responsible for the contents of their own env files.

### Env injection via SDK, not launcher scripts

The Claude Agent SDK accepts an `env` option on session creation:

```typescript
env?: { [envVar: string]: string | undefined };
```

> "Environment variables to pass to the Claude Code process. Defaults to `process.env`."

At spawn time, isomux reads the office and room env files, merges them, and passes the result via the SDK session options. Credentials never appear in launcher scripts or any isomux-managed file.

Spawn path:
1. Read office env file (if configured) → parse dotenv → `officeEnv`
2. Read room env file (if configured) → parse dotenv → `roomEnv`
3. Merge: `{ ...process.env, ...officeEnv, ...roomEnv }`
4. Pass to `unstable_v2_createSession({ env: mergedEnv, ... })`

### Spawn-time failure mode

If `envFile` is set but the file is missing, unreadable, or fails to parse, **the spawn fails loudly** with the error surfaced in the agent log. Silent fallback is the wrong default for a credentials feature — spawning without the expected identity would risk commits under the wrong user.

### Effect timing

Changes to prompts and env file paths take effect on the next agent conversation, not mid-session. This matches the existing office prompt behavior.

### Rooms get stable IDs

Rooms are currently identified by array index, which shifts on reorder/delete. Room names are mutable display strings. Neither is suitable for anchoring configuration.

Each room gets an `id` field: 8-character random hex string, generated at creation time. Internal only, never shown in UI. Existing rooms get IDs assigned on first load (migration).

All room-targeting wire messages key by `id`. Index remains a client-side rendering concern (tab order). See **Wire protocol** below.

### Data model

Rename `PersistedRoom` to `Room`:

```typescript
interface Room {
  id: string;                  // stable 8-char hex, e.g. "a3f8b2e1"
  name: string;                // display name, user-editable
  prompt: string | null;       // room-level prompt
  envFile: string | null;      // absolute path to dotenv file
  agents: PersistedAgent[];
}
```

### Storage

**Office-level settings** live in `~/.isomux/office-config.json`:

```json
{
  "prompt": "...",
  "envFile": "/home/nil/.secrets/office.env"
}
```

The existing standalone `~/.isomux/office-prompt.md` is folded into this JSON. Migration on first load: if `office-config.json` does not exist but `office-prompt.md` does, read the prompt, write the config, and leave the old `.md` file in place as a one-time backup the user can delete.

**Rooms** continue to live in `~/.isomux/agents.json`, now including `id`, `prompt`, and `envFile` per room. Migration on first load: any room without an `id` gets one generated and the file is rewritten.

The office prompt is no longer hand-edited as a file — the UI is the edit surface.

### Wire protocol

All room-targeting messages key by `roomId: string`, never index. Existing rename/close/reorder commands flip from `room: number` to `roomId: string` as part of this change.

Updates always carry the full tuple (no partial updates). Empty strings are normalized to `null` on the server for `prompt` and `envFile`.

**Client → server commands:**

```typescript
{ type: "update_office_settings"; prompt: string; envFile: string | null }
{ type: "update_room_settings"; roomId: string; prompt: string | null; envFile: string | null }
```

`set_office_prompt` is removed (consolidated into `update_office_settings`).

**Server → client broadcasts:**

```typescript
{ type: "office_settings_updated"; prompt: string; envFile: string | null }
{ type: "room_settings_updated"; roomId: string; prompt: string | null; envFile: string | null }
```

**`full_state` shape change:**

```typescript
{
  office: { prompt: string; envFile: string | null };
  rooms: { id: string; name: string; prompt: string | null; envFile: string | null }[];
  // agents still transmitted separately
}
```

`officePrompt` at the top level is removed.

### Validation

When an `update_*_settings` command includes a non-null `envFile`, the server reads and parses the file before persisting.

- **Valid:** persist, broadcast the update, respond with `{ ok: true, keyCount: N }` to the requesting client for inline feedback.
- **Invalid:** reject the save. Nothing is persisted, nothing is broadcast. Respond with `{ ok: false, error: "..." }` (e.g. "file not found", "parse error at line 3"). The UI keeps the modal open and shows the error.

Validation also runs on modal open: the server re-checks the saved `envFile` path so stale paths (file moved or renamed since last save) surface a warning without requiring a spawn attempt.

The server never returns key names to the client — only a count. Avoids shoulder-surfing disclosure.

## UI

### Office settings

- **Entry point (unchanged):** the existing "Office settings" button in the top HUD (desktop) and the three-dots dropdown menu (mobile).
- **Modal (extended `OfficePromptModal`):** Boss Title → Env File Path *(optional)* → Rules (prompt textarea). Short inputs first, long textarea last, so layout stays stable during typing.
- **Validation feedback** inline under the Env File Path input. Success: "Loaded N variables." Failure: the server error message (missing path, parse error).
- "Changes take effect on next conversation" copy remains.

### Room settings

- **Entry point:**
  - Desktop: right-click a room tab → context menu → "Room settings…"
  - Mobile: long-press a tab opens the same context menu; the three-dots dropdown menu also includes "Room settings" scoped to the currently active room.
- **Context menu contents:** `Rename`, `Room settings…`, `Close room`. Inline double-click-to-rename and inline `×` remain as shortcuts.
- Right-clicking / long-pressing a non-active tab **does not switch rooms** — the menu (and the modal it opens) operates on the clicked tab's `roomId` while the current view stays put.
- **Modal (new `RoomSettingsModal`, same visual style as `OfficePromptModal` — ~440px overlay, blurred backdrop):** Env File Path *(optional)* → Room Prompt *(optional)* textarea. Same validation feedback and "changes take effect" copy as the office modal. No Name field — inline double-click-rename stays the canonical rename affordance.

### Env file path input

- Plain text input, absolute path. No file picker, no autocomplete.
- "(optional)" label on the field.
- Validation shown inline under the input, updated on open and on save.

### Prompt hierarchy visualization

Not included in this feature. Each layer is edited in one place and the user can cross-reference by opening the other modal. A read-only "full stack" inspector that shows Office + Room + Agent concatenated as the agent actually receives it is tracked as a separate task (`9a1f8190`).

## Client store

Refactor `AppState` from parallel arrays to a unified rooms list:

```typescript
rooms: { id: string; name: string; prompt: string | null; envFile: string | null }[]
```

Replaces `roomCount`, `roomNames`. `currentRoom` remains an index for UI selection.

## Files to modify

1. `shared/types.ts` — `Room` type (renamed from `PersistedRoom`), wire protocol additions.
2. `server/persistence.ts` — `Room` type, migrations (room ID assignment, `office-prompt.md` → `office-config.json` fold), read/write of `office-config.json`, env file reading.
3. `server/agent-manager.ts` — room/office settings state, env merging at spawn time, pass `env` to SDK session, office prompt lookup moves from the `.md` file to the config.
4. `server/index.ts` — handle `update_office_settings` / `update_room_settings`, validate env files on save and on settings fetch, include `office` + full room shape in `full_state`, remove `set_office_prompt`.
5. `ui/store.tsx` — unified `rooms` array, reducer cases for the new broadcasts, `office` object replacing `officePrompt`.
6. `ui/components/OfficePromptModal.tsx` — add Env File Path input and validation feedback.
7. `ui/components/RoomSettingsModal.tsx` — new modal in the `OfficePromptModal` style.
8. `ui/office/RoomTabBar.tsx` — context menu (desktop right-click, mobile long-press), Rename / Room settings / Close room entries, roomId-keyed updates.
9. `ui/office/MobileHeader.tsx` — add "Room settings" entry (scoped to active room) to the dropdown menu.
10. `ui/components/EditAgentDialog.tsx` — flip "Move to Room" to `roomId` keying (not index).

## Out of scope

- Per-agent env vars.
- Prompt stack inspector (tracked as task `9a1f8190`).
- Env file creation/editing UI (users manage files externally).
- Encryption at rest (inherent limitation of single Linux user; real isolation needs the hub).
- Validating env file contents beyond basic dotenv parsing (key names, value shapes, duplicate detection).
