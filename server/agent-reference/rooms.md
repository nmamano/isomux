# Rooms

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks, directly or through another agent whose chat history shows the member's request. Closing a room is destructive; resolve the exact room first.

Create with `POST /api/rooms`; rename or restyle with `PATCH /api/rooms/:roomId`; close with `DELETE /api/rooms/:roomId`. Room updates can set `name`, `pet`, `skin`, `decor`, or `backRoom`. `pet` is `{species,coat}`: species cat, dog, rabbit, or tortoise, and coat an index into that species' coats; `pet:null` restores the default cat. `skin` is the preset, office or hospital, and a skin alone keeps decor choices; `skin:null` restores the office preset. `decor` changes single decorations on top of the preset; slots and values are at https://isomux.com/docs/developer-api#update-a-room, and a 422 `invalid_decor` names them. A slot set to null returns to the preset; `decor:null` clears every choice. `backRoom: true` gives the room a back room for more than 8 agents; a new room has it off. Turning it off while agents sit there returns 409 `back_room_in_use`: move them out first. The lobby takes no skin, decor, or back room.

Read the room prompt with `GET /api/rooms/:roomId/settings`, which returns the prompt and version, plus skin, pet, decor, and backRoom. Write it with `PUT /api/rooms/:roomId/settings` and `{prompt,version}`, using the version from the preceding read; `prompt:null` clears it.

Safe example: `GET /api/rooms/:roomId/settings`.

## Route contract

`POST /api/rooms`, `DELETE /api/rooms/:roomId`, `PATCH /api/rooms/:roomId`, `GET /api/rooms/:roomId/settings`, and `PUT /api/rooms/:roomId/settings` return room/settings wires; versioned settings writes return 409 when stale.

These routes require a privileged agent plus access to the room. Invalid bodies return 400/422; inaccessible rooms return 403 or a non-disclosing 404; stale state returns 409; backend failures return 500.
