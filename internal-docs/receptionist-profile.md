# Receptionist profile and typed lobby

Nil's ruling, 2026-09-08. The lobby is a canonical room with `type: "lobby"`
and one slot. An absent room type means `office`, with eight slots. Active
agents have no receptionist flag. The lobby scene draws its current occupant;
an agent moved to an ordinary room uses the ordinary desk figure.

## Room consumers

`OfficeState.rooms` / `AgentManager.getRooms()` include the lobby.
`ordinaryRooms` / `getOrdinaryRooms()` exclude it.

| Consumer | Rooms |
| --- | --- |
| Persistence, restore bucket indices, room lookup | All |
| Owner grant seed, grant picker, owner-access migration | Ordinary |
| Initial and updated `all_rooms_list` | Ordinary |
| Projected `full_state`, agent audiences | All; lobby always visible |
| Navigation tabs, selection fallback, order and hide preferences | Ordinary; separate fixed Lobby tab |
| Spawn, move, revive, swap | All; target room determines capacity |
| Manifest room numbers | Ordinary order; lobby occupant keeps `room: null` |
| Usage report | All; no synthetic lobby append |
| Close protection | Lobby and first ordinary room protected |
| Default new-room number and omitted spawn target | Ordinary |
| Task scope validation, materialized task access set | Ordinary; lobby callers default to office-global |
| Room memory scope validation and settings editor | Ordinary; lobby settings omit the memory editor |
| Room settings and presence room validation | All; RoomPane keeps the lobby prompt, hides its fixed translated name |

Lobby visitors and viewers of a lobby occupant retain the lobby presence and
ghosts added on main under Nil's 2026-09-08 ruling. Lobby agents omit the room-memory ref in both
session prompts and the system-prompt command, matching the API scope rule.

The notification-sound exclusion stays keyed to `LOBBY_ROOM_ID`. Any agent
moved into that slot produces no turn-end notification sound.

## Creation and migration

The first-owner claim snapshots whether agents already exist, creates the
receptionist, and then seeds the three welcome agents only for a fresh office.
No receptionist is created before an owner exists. The seed discovers the free
OpenCode model with the same resolver as the Free Welcome Agent, and uses the
preferred default when discovery cannot supply one. Permission mode is
`bypassPermissions`, and cwd is `~`.
An existing office without a lobby gets one at boot. A persisted empty lobby
stays empty after a kill or move. Before the first spawn, the lobby bucket stores
`defaultAgentPending: true`. A null or thrown spawn leaves this marker for the
next boot to retry. A successful spawn clears it. If an agent already occupies
a pending lobby, boot clears the marker without spawning a second agent.

Legacy `receptionist.json` is imported into the lobby bucket. The migration
keeps the agent's id and settings, sets the first owner as boss and cwd to
home, and prepends the rendered profile to the owner's existing instruction
bytes. It deletes the legacy file only after the ordinary agent save succeeds.
An occupied lobby or an already-restored matching id keeps the legacy file and
logs a conflict. The old `~/isomux-receptionist` directory remains untouched.

Older servers read the new lobby bucket in `agents.json` as an ordinary room.

The lobby agent now loads the first owner's boss memory, and its token now reaches every room, board and agent the first owner reaches, for any person who opens its chat, member or not.

With a normal token, any person who opens the lobby agent's chat, member or not, can have it file an office-global task.
`defaultCreateRoomIdForIdentity` is the only implicit task-room default; the other
agent room-id read handles presence focus and stays unchanged.

Both former `receptionist_reach` checks, for immediate and scheduled messages,
are removed. Name, cwd, kill and move use normal agent paths.

## Profile rendering

The template catalog is in `shared/agent-templates.ts`, re-exported by
`ui/agent-templates.ts`. Both server and UI read the base voice and outfit from
`shared/receptionist-profile.ts`. The server validates the selected profile key.
`server/receptionist-profile.ts` renders the selected voice, the exact
`ISOMUX_KNOWLEDGE` export in `api/chat.ts`, and office name, members and origin.
The normal system-prompt builder supplies affordances, office instructions and
memory. It does not inject knowledge.

The spawn textarea shows the editable base voice. The server persists voice,
knowledge and office guidance as custom instructions. Edit Agent therefore
shows a larger block after spawn. Office name and members are a spawn-time
snapshot; later changes do not rewrite an existing agent's instructions.
The owner can create a fresh agent from the profile to get the current text.

## Replaced test assertions

- `receptionist.test.ts`: locked kill/move/name/cwd and the dedicated-directory
  assertions are replaced by editable lifecycle, one-slot, home-cwd, migration
  and restart tests. The no-user token/global-tasks-only assertions are replaced
  by normal first-owner reach and boss-memory assertions. Empty `full_state.rooms`
  becomes a typed Lobby record. No-lobby spawn/close/swap assertions become
  room-capacity and protected-close assertions.
- `system-prompt.test.ts`: the `buildReceptionistSystemPrompt` block is removed,
  including its no-affordances and no-room-visibility assertions. The assertion
  that includes `ISOMUX_KNOWLEDGE` moves to `receptionist-profile.test.ts`, where
  the renderer must include the export byte for byte.
- `ui/agent-templates.test.ts`: the exact 12-template list gains Isomux
  Receptionist. Existing software-workflow and palette assertions remain on
  the original templates; the receptionist's base voice and original outfit
  have separate explicit assertions.
- `usage-scoping.test.ts`: the input now supplies the canonical lobby instead
  of expecting the report to append a synthetic room.
- `ui/demo-server.test.ts`: the room list includes Lobby.
- `onboarding.test.ts` filters lobby occupants by roomId, not agent flag.
- `ReceptionistFigure.test.tsx` drops the removed flag from its agent fixture.

## Integration with main

The rebase onto `0a7e8815` preserves the new-room door and its create-ACK /
broadcast de-duplication, members-chat controls and lobby ghosts. OfficeView
keeps those controls and derives door destinations from ordinary rooms. A door
opened from a canonical lobby with no ordinary rooms creates the protected
first ordinary room. The earlier null-presence assertion is retired in favor
of main's lobby-presence suite.
