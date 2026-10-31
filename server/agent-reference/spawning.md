# Spawning agents

For work you delegate, spawn a worker in the back room instead of using your engine's subagents. Spawn it with no `desk`, which seats it in the back room. Give it a name that says its job and, when it works on your files, your working folder as `cwd`. Send it the brief in a message and ask it to message you its result. Then end your turn, and schedule a wake-up message in case its reply does not come (see scheduled-messages).

Spawn an agent with `POST /api/agents` and `{name,roomId,cwd?,desk?,agentType?,permissionMode?,codexSandbox?,modelFamily?,effort?,instructions?}`, in a room your manager can access. The new agent has your manager and is never privileged. Tell it its work in a message (see messaging). With no `cwd`, the agent starts in the room's folder, or in `~` where the room has none. A room has 8 front desks (`desk` 0 to 7) for the agents people talk to, and a back room that seats up to 100: no `desk` or `desk: null` gives a back room seat, and a taken front desk falls through to a free one, then the back room. The lobby has one desk and no back room.

With no `permissionMode`, the new agent gets its engine's mode that never asks: `bypassPermissions` for Claude and OpenCode, `never` for Codex. A Codex agent in `never` passes its sandbox to a Codex child.

If you are not privileged and do not have full permissions (`bypassPermissions`, or Codex `never` with `danger-full-access`), the agent you spawn cannot have more permissions than you. Of your engine, it takes your mode and sandbox or stricter ones, and no `permissionMode` gives it yours. Another engine takes only its strictest mode, and you must name it: `default` for Claude and OpenCode, `untrusted` with `codexSandbox: "read-only"` for Codex. Its `cwd` must be your working folder or a folder inside it. Otherwise you get 403 `spawn_exceeds_agent`.

One spawn tree, the agents you spawn, the agents they spawn and so on, holds at most 50 live agents. The next spawn returns 429 `spawn_limit`.

You can keep a worker you spawned for later work. Kill an agent you spawned with `DELETE /api/agents/:id`. Kill moves it to the killed list. Only a privileged agent kills other agents.

Safe example: `GET /agents`, to see that the name you pick is free.

## Route contract

`POST /api/agents` returns 201 `{agent}`. `DELETE /api/agents/:id` returns 204. A room your manager cannot access, an agent you did not spawn, or `spawn_exceeds_agent` returns 403; a full spawn tree returns 429 `spawn_limit`. An invalid body returns 400/422; a taken name, a full room (`no_free_desk`) or a full back room (`back_room_full`) returns 409.
