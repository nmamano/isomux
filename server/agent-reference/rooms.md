# Rooms

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks, directly or through another agent whose chat history shows the member's request. Closing a room is destructive; resolve the exact room first.

Create with `POST /api/rooms`; rename or restyle with `PATCH /api/rooms/:roomId`; close with `DELETE /api/rooms/:roomId`. Only an empty room other than the lobby closes; any other returns 409 `room_not_closable`. Room updates can set `name`, `pet`, `skin`, `decor`, or `cwd`. `pet` is `{species,coat}`: species cat, dog, rabbit, or tortoise, and coat an index into that species' coats; `pet:null` restores the default cat. `skin` is the preset, office or hospital, and a skin alone keeps decor choices; `skin:null` restores the office preset. `decor` changes single decorations on top of the preset; slots and values are at https://isomux.com/docs/developer-api#update-a-room, and a 422 `invalid_decor` names them. A slot set to null returns to the preset; `decor:null` clears every choice. The lobby takes no skin or decor. `cwd` is the folder new agents in the room start in: an absolute or `~`-rooted path to an existing directory, else 400 `invalid_cwd`; `null` or `""` clears it back to `~`.

Read the room instructions with `GET /api/rooms/:roomId/instructions`, which returns `{instructions,version}`. Write them with `PUT /api/rooms/:roomId/instructions` and `{instructions,version}`, using the version from the preceding read; `instructions:null` clears them. `GET /api/rooms/:roomId/settings` returns the room's skin, pet, decor, and cwd.

Safe example: `GET /api/rooms/:roomId/instructions`.

## Floors

The lobby elevator links to other Isomux offices, its floors. List them with `GET /api/floors`. Add one with `POST /api/floors` and `{url}`, the other office's address; this office reads that office's public card at `/.well-known/isomux-office` and takes the name from it. Remove one with `DELETE /api/floors/:id`. This office's server must reach the other office: an address only your browser reaches, such as a tailnet name from a public office, cannot be added.

## Route contract

`POST /api/rooms`, `DELETE /api/rooms/:roomId`, `PATCH /api/rooms/:roomId`, `GET /api/rooms/:roomId/settings` return room/settings wires. `GET /api/rooms/:roomId/instructions` and `PUT /api/rooms/:roomId/instructions` return `{instructions,version}`; a stale version returns 409.

`GET /api/floors` returns `{floors:[{id,url,name,addedAt}]}` in the order they were added; `name` is null when the other office has none. `POST /api/floors` returns 201 `{floor}`; `url` is stored as its origin. An invalid address returns 400 `invalid_request`; an Isomux office that must update before it can be a floor returns 422 `office_outdated`; an address that does not answer as an Isomux office returns 422 `office_unreachable`; a floor with that origin returns 409 `floor_exists`; more than 100 floors returns 409 `too_many_floors`. `DELETE /api/floors/:id` returns 204, or 404 `floor_not_found`. The floor routes need a privileged agent; they reach every floor of the office.

These routes require a privileged agent plus access to the room. Invalid bodies return 400/422; inaccessible rooms return 403 or a non-disclosing 404; stale state returns 409; backend failures return 500.
