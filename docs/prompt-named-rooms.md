# Implementation Prompt: Named Rooms

## Goal

Add custom names to rooms. Currently rooms are displayed as "Room 1", "Room 2", etc. After this change, rooms have user-editable names.

## Data Model Change

### `agents.json` — persistence format

**Current:** `PersistedAgent[][]` — a 2D array where index = room number.

**New:** Add a wrapper so room metadata can be stored:

```typescript
interface PersistedRoom {
  name: string;
  agents: PersistedAgent[];
}
```

The file becomes `PersistedRoom[]`. Migration: on load, if the array contains raw agent arrays (old format, detected by checking if the first element is an array), wrap each as `{ name: "Room 1", agents: [...] }`.

### Server state

In `server/agent-manager.ts`, add a `roomNames: string[]` array alongside the existing `roomCount: number` (line 263). Keep both in sync — `roomNames.length === roomCount` is an invariant.

### Frontend state

In `ui/store.tsx`, add `roomNames: string[]` to `AppState` (line 22 area). Initialize to `["Room 1"]`.

## Wire Protocol Changes

### Server → Browser (`ServerMessage` in `shared/types.ts`)

1. `full_state` — add `roomNames: string[]` field
2. `room_created` — add `roomName: string` field (the name of the new room)
3. New message: `{ type: "room_renamed"; room: number; name: string }`

### Browser → Server (`ClientCommand` in `shared/types.ts`)

1. `create_room` — add optional `name?: string` field. Default name: `"Room N"` where N is the new room count.
2. New command: `{ type: "rename_room"; room: number; name: string }`

## Server Changes (`server/agent-manager.ts`)

### State

Add `let roomNames: string[] = ["Room 1"];` next to `roomCount` (line 263).

### `createRoom(name?: string)`

```typescript
export function createRoom(name?: string): number {
  roomCount++;
  roomNames.push(name || `Room ${roomCount}`);
  persistAll();
  eventHandler({
    type: "room_created",
    roomCount,
    roomName: roomNames[roomCount - 1],
  });
  return roomCount;
}
```

### `closeRoom(room: number)`

After the existing `roomCount--` (line 386), splice the name out:

```typescript
roomNames.splice(room, 1);
```

### New: `renameRoom(room: number, name: string)`

```typescript
export function renameRoom(room: number, name: string): boolean {
  if (room < 0 || room >= roomCount) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  roomNames[room] = trimmed;
  persistAll();
  eventHandler({ type: "room_renamed", room, name: trimmed });
  return true;
}
```

### `getRoomNames(): string[]`

New export, used by `index.ts` for `full_state`.

### `persistAll()`

Currently builds `PersistedAgent[][]`. Change to build `PersistedRoom[]`:

```typescript
const rooms: PersistedRoom[] = Array.from({ length: roomCount }, (_, i) => ({
  name: roomNames[i],
  agents: [],
}));
// ... existing agent-filling loop, push to rooms[room].agents instead of rooms[room]
saveAgents(rooms);
```

### `restoreAgents()`

Currently does `const rooms = loadAgents(); roomCount = rooms.length;`. After the change, `loadAgents()` returns `PersistedRoom[]`, so:

```typescript
const rooms = loadAgents();
roomCount = rooms.length;
roomNames = rooms.map((r) => r.name);
// iterate rooms[i].agents instead of rooms[i]
```

### Agent manifest (`writeManifest` in `persistence.ts`)

Add room name to the manifest so agents can see it. The function already receives room index — also pass `roomNames` and include `roomName` in the output.

### System prompt / agent discovery

In the agent manifest (`agents-summary.json`), include `roomName` alongside the existing `room` field. Agents already read this file to discover each other.

## Persistence Changes (`server/persistence.ts`)

### `loadAgents()` return type

Change from `PersistedAgent[][]` to `PersistedRoom[]`.

Migration logic (3 formats):

1. **Flat array** (`PersistedAgent[]`, oldest): wrap as `[{ name: "Room 1", agents: [...] }]`
2. **Nested array** (`PersistedAgent[][]`, current): wrap each as `{ name: "Room N", agents: [...] }`
3. **Room objects** (`PersistedRoom[]`, new): use as-is

Detection: if first element has a `name` property and `agents` property, it's format 3. If first element is an array, it's format 2. Otherwise format 1.

### `saveAgents()` parameter type

Change from `PersistedAgent[][]` to `PersistedRoom[]`.

## Frontend Changes

### `ui/store.tsx`

1. Add `roomNames: string[]` to `AppState`, initialize to `["Room 1"]`
2. Handle in reducer:
   - `full_state` → set `roomNames` from action
   - `room_created` → append new room name
   - `room_closed` → splice out the closed room's name
   - New action `room_renamed` → update name at index

### `ui/office/RoomTabBar.tsx`

1. Read `roomNames` from `useAppState()`
2. Replace `Room {i + 1}` (line 64) with `{roomNames[i]}`
3. Add rename capability: double-click on tab text shows an inline input. On blur or Enter, send `{ type: "rename_room", room: i, name: newValue }`. On Escape, cancel. Keep it simple — no modal.

### `ui/office/OfficeView.tsx`

Door labels (lines 245-246) currently show `Room ${currentRoom}` and `Room ${currentRoom + 2}`. Change to use `roomNames[currentRoom - 1]` and `roomNames[currentRoom + 1]`.

### `ui/components/EditAgentDialog.tsx`

Line 140: Replace `Room ${agent!.room + 1}` with room name from state.
Line 357: Replace `Room {i + 1}` with room name from state.

### `ui/components/AgentListView.tsx`

Line 83: Replace `Room ${currentRoom + 1} is empty` with room name.

### `ui/log-view/LogView.tsx`

Line 662: The room indicator `R${agent.room + 1}:` — consider replacing with a short form of the room name or keeping the number. Up to you, but keep it short since this is in a compact header.

## Server Command Handling (`server/index.ts`)

In the `handleCommand` switch:

1. `create_room` case: pass `cmd.name` to `AgentManager.createRoom(cmd.name)`
2. Add `rename_room` case: call `AgentManager.renameRoom(cmd.room, cmd.name)`
3. `full_state` construction: include `roomNames: AgentManager.getRoomNames()`

## Files to Modify

1. `shared/types.ts` — ServerMessage, ClientCommand types
2. `server/persistence.ts` — PersistedRoom type, loadAgents, saveAgents
3. `server/agent-manager.ts` — roomNames state, createRoom, closeRoom, renameRoom, persistAll, restoreAgents, getRoomNames export
4. `server/index.ts` — handleCommand for rename_room, full_state roomNames
5. `ui/store.tsx` — AppState.roomNames, reducer cases
6. `ui/office/RoomTabBar.tsx` — display names, inline rename
7. `ui/office/OfficeView.tsx` — door labels
8. `ui/components/EditAgentDialog.tsx` — room display
9. `ui/components/AgentListView.tsx` — empty room message
10. `ui/log-view/LogView.tsx` — room indicator (optional)

## What NOT to Do

- Don't add room name validation beyond trimming whitespace. Any non-empty string is fine.
- Don't add a rename modal or dialog. Inline editing on the tab is sufficient.
- Don't change room indexing. Rooms are still identified by 0-based index everywhere. The name is purely display.
- Don't modify CLAUDE.md.
- Don't add features beyond what's described here.

## Build & Test

After changes, run `bun run build:ui` to rebuild the frontend. The server picks up the new static files without restart. Test:

1. Fresh start — existing agents.json (old format) migrates correctly, rooms show "Room 1" etc.
2. Create a new room — gets default name "Room N"
3. Double-click tab to rename — inline edit works
4. Close a room — name array stays in sync
5. Reload page — names persist
6. Check agents-summary.json includes room names
