# Rooms

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks, directly or through another agent whose chat history shows the member's request. Closing a room is destructive; resolve the exact room first.

Create with `POST /api/rooms`; rename or restyle with `PATCH /api/rooms/:roomId`; close with `DELETE /api/rooms/:roomId`. Room updates can set `name`, `pet`, `skin`, `decor`, `backRoom`, or `cwd`. `pet` is `{species,coat}`: species cat, dog, rabbit, or tortoise, and coat an index into that species' coats; `pet:null` restores the default cat. `skin` is the preset, office or hospital, and a skin alone keeps decor choices; `skin:null` restores the office preset. `decor` changes single decorations on top of the preset; slots and values are at https://isomux.com/docs/developer-api#update-a-room, and a 422 `invalid_decor` names them. A slot set to null returns to the preset; `decor:null` clears every choice. `backRoom: true` gives the room a back room for more than 8 agents; a new room has it off. Turning it off while agents sit there returns 409 `back_room_in_use`: move them out first. The lobby takes no skin, decor, or back room. `cwd` is the folder new agents in the room start in: an absolute or `~`-rooted path to an existing directory, else 400 `invalid_cwd`; `null` or `""` clears it back to `~`.

Read the room instructions with `GET /api/rooms/:roomId/instructions`, which returns `{instructions,version}`. Write them with `PUT /api/rooms/:roomId/instructions` and `{instructions,version}`, using the version from the preceding read; `instructions:null` clears them. `GET /api/rooms/:roomId/settings` returns the room's skin, pet, decor, backRoom, and cwd.

Safe example: `GET /api/rooms/:roomId/instructions`.

## Route contract

`POST /api/rooms`, `DELETE /api/rooms/:roomId`, `PATCH /api/rooms/:roomId`, `GET /api/rooms/:roomId/settings` return room/settings wires. `GET /api/rooms/:roomId/instructions` and `PUT /api/rooms/:roomId/instructions` return `{instructions,version}`; a stale version returns 409.

These routes require a privileged agent plus access to the room. Invalid bodies return 400/422; inaccessible rooms return 403 or a non-disclosing 404; stale state returns 409; backend failures return 500.
