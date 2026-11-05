# Action asks

When only a member can make a change, open an ask with an action `step`. The card shows the change and an Apply button that makes it as the member. The ask closes when the change is made, by Apply or by hand, and you get a notice. Send no `link`.

An agent's access level (the access slider, Privileged included): `step` is `{"kind": "agent-access", "agentId": "<id>", "access": "<stop>", "pack": <pack>}`, with `access` and `pack` as `PUT /api/agents/:id/access` takes them.

The create refuses with 422 `unknown_agent` for an agent you cannot reach, 403 `member_not_allowed` when the member cannot make the change, 422 with the slider's code when the agent's engine or folder rules out that level, and 409 `step_done` when the change is made.

One room of a member's room access: `step` is `{"kind": "member-room", "username": "<member>", "roomId": "<room id>", "grant": true}`, or `"grant": false` to take the room. The rest of the member's rooms stay as they are. Only an office owner can apply it.

A member's role: `step` is `{"kind": "member-role", "username": "<member>", "role": "owner"}`, or `"role": "member"`. Only an office owner can apply it.

For both, the create refuses with 422 `unknown_member` for no such member, 403 `member_not_allowed` and 409 `step_done` as above. A room step also refuses 422 `unknown_room` for a room you cannot reach, 422 `lobby_open_to_all` for the lobby and 422 `owner_has_all_rooms` for an owner. A role step refuses 409 `last_owner` for the last office owner.
