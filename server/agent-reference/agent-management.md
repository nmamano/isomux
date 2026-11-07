# Agent management

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks, directly or through another agent whose chat history shows the member's request. Reach is your manager's ROOM ACCESS, not ownership: any agent in an accessible room, including another member's agent. Destructive actions require care.

To spawn an agent, see spawning. Kill any agent with `DELETE /api/agents/:id`; kill moves the agent to the killed list. Revive with `POST /api/agents/:id/revive` and `{roomId,desk?}`. Move with `POST /api/agents/:id/move` and `{targetRoomId,desk?}`: a free front desk, `null` for the back room, or no `desk` to keep the agent's area. A revive or move that breaks the folder rules returns 422 `folder_not_allowed`. Swap two front desks with `POST /api/rooms/:roomId/swap-desks` and `{deskA,deskB}`.

`PATCH /api/agents/:id` edits scalar props (name, cwd, model, effort, autoHandoff, autoHandoffTokens, limitResume, and similar) with no version. To set an agent's instructions, read `GET /api/agents/:id/instructions` for `{instructions,version}`, then send `PUT /api/agents/:id/instructions` with `{instructions,version}`; `instructions:null` clears them. A 409 means they changed, so read again. `PUT /api/agents/:id/topic` sets a topic, and a blank one clears it; `DELETE /api/agents/:id/topic` regenerates it from the conversation.

To drive another agent's conversation: resume a past session with `POST /api/agents/:id/resume` and `{sessionId}`; cancel any queued message with `DELETE /api/agents/:id/queue/:messageId` (the ids are in `GET /api/agents/:id/queue`, see messaging); edit a message with `PATCH /api/agents/:id/messages/:logEntryId` and `{newText}`. `POST /api/agents/:id/send-now` flushes queued messages and returns 409 `agent_error`, `queue_empty`, or `awaiting_prompt` when it cannot. Listing sessions, clearing, and handoff are in conversation-history and conversation-lifecycle. Stopping a turn is in messaging. Resuming an agent's current session restarts it with its current instructions and memory and keeps its chat.

When your manager is an office owner, you can give any agent another manager: `PUT /api/agents/:id/manager` with `{userId}`. The agent then runs on that member's credentials, its conversation restarts, and the apps, schedules and webhooks it made move to that member. An ordinary agent, or a privileged agent whose manager is not an office owner, gets 403; an unknown member returns 422 `unknown_member`.

Safe example: `GET /api/agents/:id/instructions`.

## Route contract

`DELETE /api/agents/:id`, `POST /api/agents/:id/revive`, `PATCH /api/agents/:id`, `PUT /api/agents/:id/instructions`, `POST /api/agents/:id/move`, `PUT /api/agents/:id/manager`, `PUT /api/agents/:id/topic`, `DELETE /api/agents/:id/topic`, `POST /api/rooms/:roomId/swap-desks`, `PATCH /api/agents/:id/messages/:logEntryId`, `POST /api/agents/:id/send-now`, and `POST /api/agents/:id/resume` use the request bodies described above and return the updated agent/message outcome or 204.

Driving another agent's conversation also uses `GET /api/agents/:id/sessions`, `DELETE /api/agents/:id/queue/:messageId`, `POST /api/agents/:id/new-conversation`, and `POST /api/agents/:id/handoff`; their contracts are in conversation-history, messaging, and conversation-lifecycle.

These routes require a privileged agent plus room access to the target. Invalid bodies return 400/422; inaccessible resources return 403 or a non-disclosing 404; stale state, a taken desk, a full room (`no_free_desk`), or a full back room (`back_room_full`) returns 409; queue/rate limits return 429; backend failures return 500/502.
