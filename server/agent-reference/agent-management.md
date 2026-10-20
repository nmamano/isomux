# Agent management

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks, directly or through another agent whose chat history shows the member's request. Reach is your manager's ROOM ACCESS, not ownership: any agent in an accessible room, including another member's agent. Destructive actions require care.

Spawn with `POST /api/agents` and `{name,cwd,roomId,desk?}`. A room has 8 front desks (`desk` 0 to 7) for the agents people talk to. With its back room setting on, it also has a back room that seats up to 100: no `desk` or `desk: null` gives a back room seat, and a taken front desk falls through to a free one, then the back room. With the setting off, no `desk` or a taken desk gives the first free front desk, and `desk: null` returns 409 `back_room_off`. With no `permissionMode`, the new agent never asks for permission: it keeps your mode if your mode never asks and its engine has the same mode, else it gets its engine's mode that never asks. Kill with `DELETE /api/agents/:id`; kill moves the agent to the killed list. Revive with `POST /api/agents/:id/revive` and `{roomId,desk?}`. Move with `POST /api/agents/:id/move` and `{targetRoomId,desk?}`: a free front desk, `null` for the back room, or no `desk` to keep the agent's area (the first free front desk where the back room is off). Swap two front desks with `POST /api/rooms/:roomId/swap-desks` and `{deskA,deskB}`.

`PATCH /api/agents/:id` edits scalar props (name, cwd, model, effort, autoHandoff, autoHandoffTokens, limitResume, and similar) with no version. To set custom instructions, read `GET /api/agents/:id/instructions` for `{customInstructions,customInstructionsVersion}`, then PATCH both fields; a 409 means they changed, so read again. `PUT /api/agents/:id/topic` sets a topic, and a blank one clears it; `DELETE /api/agents/:id/topic` regenerates it from the conversation.

To drive another agent's conversation: resume a past session with `POST /api/agents/:id/resume` and `{sessionId}`; cancel any queued message with `DELETE /api/agents/:id/queue/:messageId` (the ids are in `GET /api/agents/:id/queue`, see messaging); edit a message with `PATCH /api/agents/:id/messages/:logEntryId` and `{newText}`. `POST /api/agents/:id/send-now` flushes queued messages and returns 409 `agent_error`, `queue_empty`, or `awaiting_prompt` when it cannot. Listing sessions, clearing, and handoff are in conversation-history and conversation-lifecycle. Stopping a turn is in messaging.

Safe example: `GET /api/agents/:id/instructions`.

## Route contract

`POST /api/agents`, `DELETE /api/agents/:id`, `POST /api/agents/:id/revive`, `PATCH /api/agents/:id`, `GET /api/agents/:id/instructions`, `POST /api/agents/:id/move`, `PUT /api/agents/:id/topic`, `DELETE /api/agents/:id/topic`, `POST /api/rooms/:roomId/swap-desks`, `PATCH /api/agents/:id/messages/:logEntryId`, `POST /api/agents/:id/send-now`, and `POST /api/agents/:id/resume` use the request bodies described above and return the updated agent/message outcome or 204.

Driving another agent's conversation also uses `GET /api/agents/:id/sessions`, `DELETE /api/agents/:id/queue/:messageId`, `POST /api/agents/:id/new-conversation`, and `POST /api/agents/:id/handoff`; their contracts are in conversation-history, messaging, and conversation-lifecycle.

These routes require a privileged agent plus room access to the target. Invalid bodies return 400/422; inaccessible resources return 403 or a non-disclosing 404; stale state, a taken desk, a full room (`no_free_desk`), a full back room (`back_room_full`), or a back room that is off (`back_room_off`) returns 409; queue/rate limits return 429; backend failures return 500/502.
