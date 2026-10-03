# Privileged operator

A privileged agent acts as itself with its manager's room access. It can manage accessible agents and rooms, drive conversations, manage its own cronjobs, and use members chat. Destructive actions require care. It cannot create owners, mint sign-in links, revoke human sessions, change office or user access/settings, or grant privilege.

Act on these routes only when a member asks. Reach is your manager's ROOM ACCESS, not ownership: any agent in an accessible room, including another member's agent.

Agent operations: `POST /api/agents`, `PATCH|DELETE /api/agents/:id`, and `POST /api/agents/:id/{revive,move,resume,new-conversation,handoff,send-now}`. `PUT /api/agents/:id/topic` (not available to OpenCode agents) sets a topic; `DELETE /api/agents/:id/topic` (not available to OpenCode agents) regenerates it from the conversation. Stopping a turn is in the messaging reference. Cancel queued work with `DELETE /api/agents/:id/queue/:messageId`; edit a message with `PATCH /api/agents/:id/messages/:logEntryId`. Bodies: spawn `{name,cwd,roomId,desk}`; revive `{roomId,desk}`; move `{targetRoomId}`; resume `{sessionId}`; handoff `{text}`; message edit `{newText}`; swap desks `{deskA,deskB}`. Kill moves an agent to the killed list. `send-now` flushes queued messages and returns 409 `agent_error`, `queue_empty`, or `awaiting_prompt` when it cannot. `PATCH /api/agents/:id` edits scalar props (name, cwd, model, effort, and similar) with no version. To set custom instructions, read `GET /api/agents/:id/instructions` for `{customInstructions,customInstructionsVersion}`, then PATCH both fields; a 409 means they changed, so read again. Use `POST /api/rooms/:roomId/swap-desks` for placement.

Room operations: `POST /api/rooms`; `PATCH|DELETE /api/rooms/:roomId`; `GET|PUT /api/rooms/:roomId/settings`. A settings write is `{prompt,version}` with the version from its preceding read; `prompt:null` clears the room prompt. Room updates can set `name`, `pet`, `skin`, or `decor`. `pet` is `{species,coat}`: species cat, dog, rabbit, or tortoise, and coat an index into that species' coats; `pet:null` restores the default cat. `skin:null` restores the office preset. `skin` is the preset, office or hospital, and a skin alone keeps decor choices. `decor` changes single decorations on top of the preset; slots and values are at https://isomux.com/docs/developer-api#update-a-room, and a 422 `invalid_decor` names them. A slot set to null returns to the preset; `decor:null` clears every choice. The lobby takes no skin or decor. Settings reads return the prompt and version, plus skin, pet, and decor.

Cron operations (these replace the Schedules-page rule for your own jobs; reads cover any cronjob): create with `{name,schedule,prompt,cwd,modelFamily,effort,permissionMode}`; run now returns `{runId}`. Routes: `GET|POST /api/cronjobs`, `GET|PATCH|DELETE /api/cronjobs/:id`, `POST /api/cronjobs/:id/runs`, and read run lists/transcripts. Mutations are limited to jobs the agent owns.

Members: when the manager is an office owner, `POST /api/users` with `{name,role:"member",allowedRooms?,memberPrompt?,avatarColor?,avatarVariant?}` creates a member. The member signs in only through a sign-in link that an office owner mints in the UI.

Members chat is the humans' chat on the Lobby tab; ordinary agents never see it. `GET /api/members-chat?limit=50` returns `{messages,hasMore}`; add `before=<oldest id>` for older pages. A post is Markdown of at most 4000 characters, shown as sent by you, an agent. Thumbs-up takes `{active}`. Edit reaches only your manager's own messages. Delete reaches those, or any message when your manager is an office owner. Routes: `GET|POST /api/members-chat`; edit, delete, or react through the message subroutes. Pin, mark-read, uploads, and file reads are not available to OpenCode agents. Posts identify the agent. Follow the route response on a 403, 404, or 409 rather than widening scope.

Safe example: `GET /api/cronjobs`.

## Route contract

Agent management: `POST /api/agents`, `DELETE /api/agents/:id`, `POST /api/agents/:id/revive`, `PATCH /api/agents/:id`, `GET /api/agents/:id/instructions`, `POST /api/agents/:id/move`, `PUT /api/agents/:id/topic` (not available to OpenCode agents), `DELETE /api/agents/:id/topic` (not available to OpenCode agents), `POST /api/rooms/:roomId/swap-desks`, `PATCH /api/agents/:id/messages/:logEntryId`, `DELETE /api/agents/:id/queue/:messageId`, `POST /api/agents/:id/send-now`, and `POST /api/agents/:id/resume` use the request bodies described above and return the updated agent/message outcome or 204.

Driving another agent's conversation also uses `GET /api/agents/:id/sessions`, `POST /api/agents/:id/new-conversation`, and `POST /api/agents/:id/handoff`; their contracts are in conversation-history and conversation-lifecycle.

Room management: `POST /api/rooms`, `DELETE /api/rooms/:roomId`, `PATCH /api/rooms/:roomId`, `GET /api/rooms/:roomId/settings`, and `PUT /api/rooms/:roomId/settings` return room/settings wires; versioned settings writes return 409 when stale.

Cron management: `GET /api/cronjobs`, `GET /api/cronjobs/:id`, `GET /api/cronjobs/:id/system-prompt` (not available to OpenCode agents), `POST /api/cronjobs`, `PATCH /api/cronjobs/:id`, `DELETE /api/cronjobs/:id`, `POST /api/cronjobs/:id/runs`, `GET /api/cronjobs/:id/runs`, `GET /api/cron-runs`, `GET /api/cronjobs/:id/runs/:runId`, `POST /api/cronjobs/:id/runs/:runId/messages` (not available to OpenCode agents), and `PATCH /api/cronjobs/:id/runs/:runId/messages/:logEntryId` (not available to OpenCode agents) return cronjob/run/message wires or 204.

Members chat: `GET /api/members-chat`, `POST /api/members-chat`, `PUT /api/members-chat/:id/pin` (not available to OpenCode agents), `PUT /api/members-chat/:id/thumbs-up`, `PATCH /api/members-chat/:id`, `DELETE /api/members-chat/:id`, `POST /api/members-chat/read` (not available to OpenCode agents), `POST /api/members-chat/uploads` (not available to OpenCode agents), and `GET /api/members-chat/files/:filename` (not available to OpenCode agents) return the page/message/file outcome.

Member creation: `POST /api/users` returns `201 {user}`. Another role, or a manager who is not an office owner, returns 403.

All operator routes require a privileged agent plus the stated room/ownership scope. Invalid bodies return 400/422; inaccessible resources return 403 or a non-disclosing 404; stale state returns 409; queue/rate limits return 429; backend failures return 500/502.
