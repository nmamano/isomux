# Agent management

A privileged agent acts as itself with its manager's room access. Act on these routes only when a member asks. Reach is your manager's ROOM ACCESS, not ownership: any agent in an accessible room, including another member's agent. Destructive actions require care.

Spawn with `POST /api/agents` and `{name,cwd,roomId,desk}`. Kill with `DELETE /api/agents/:id`; kill moves the agent to the killed list. Revive with `POST /api/agents/:id/revive` and `{roomId,desk}`. Move with `POST /api/agents/:id/move` and `{targetRoomId}`. Swap two desks with `POST /api/rooms/:roomId/swap-desks` and `{deskA,deskB}`.

`PATCH /api/agents/:id` edits scalar props (name, cwd, model, effort, and similar) with no version. To set custom instructions, read `GET /api/agents/:id/instructions` for `{customInstructions,customInstructionsVersion}`, then PATCH both fields; a 409 means they changed, so read again. `PUT /api/agents/:id/topic` (not available to OpenCode agents) sets a topic; `DELETE /api/agents/:id/topic` (not available to OpenCode agents) regenerates it from the conversation.

To drive another agent's conversation: resume a past session with `POST /api/agents/:id/resume` and `{sessionId}`; cancel queued work with `DELETE /api/agents/:id/queue/:messageId`; edit a message with `PATCH /api/agents/:id/messages/:logEntryId` and `{newText}`. `POST /api/agents/:id/send-now` flushes queued messages and returns 409 `agent_error`, `queue_empty`, or `awaiting_prompt` when it cannot. Listing sessions, clearing, and handoff are in conversation-history and conversation-lifecycle. Stopping a turn is in messaging.

Safe example: `GET /api/agents/:id/instructions`.

## Route contract

`POST /api/agents`, `DELETE /api/agents/:id`, `POST /api/agents/:id/revive`, `PATCH /api/agents/:id`, `GET /api/agents/:id/instructions`, `POST /api/agents/:id/move`, `PUT /api/agents/:id/topic` (not available to OpenCode agents), `DELETE /api/agents/:id/topic` (not available to OpenCode agents), `POST /api/rooms/:roomId/swap-desks`, `PATCH /api/agents/:id/messages/:logEntryId`, `DELETE /api/agents/:id/queue/:messageId`, `POST /api/agents/:id/send-now`, and `POST /api/agents/:id/resume` use the request bodies described above and return the updated agent/message outcome or 204.

Driving another agent's conversation also uses `GET /api/agents/:id/sessions`, `POST /api/agents/:id/new-conversation`, and `POST /api/agents/:id/handoff`; their contracts are in conversation-history and conversation-lifecycle.

These routes require a privileged agent plus room access to the target. Invalid bodies return 400/422; inaccessible resources return 403 or a non-disclosing 404; stale state returns 409; queue/rate limits return 429; backend failures return 500/502.
