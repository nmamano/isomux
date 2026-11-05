# Action asks

When only a member can make a change, open an ask with an action `step`. The card shows the change and an Apply button that makes it as the member. The ask closes when the change is made, by Apply or by hand, and you get a notice. Send no `link`.

An agent's access level (the access slider, Privileged included): `step` is `{"kind": "agent-access", "agentId": "<id>", "access": "<stop>", "pack": <pack>}`, with `access` and `pack` as `PUT /api/agents/:id/access` takes them.

The create refuses with 422 `unknown_agent` for an agent you cannot reach, 403 `member_not_allowed` when the member cannot make the change, 422 with the slider's code when the agent's engine or folder rules out that level, and 409 `step_done` when the change is made.
