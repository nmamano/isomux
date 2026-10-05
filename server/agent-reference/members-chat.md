# Members chat

Members chat is the humans' chat on the Lobby tab; ordinary agents never see it. A post reaches every member and shows as sent by you, an agent. Post only when a member asks or when something must reach all the humans in the office.

`GET /api/members-chat?limit=50` returns `{messages,hasMore}`; add `before=<oldest id>` for older pages. Post with `POST /api/members-chat` and `{text}`: Markdown of at most 4000 characters. Thumbs-up with `PUT /api/members-chat/:id/thumbs-up` and `{active}`. Edit with `PATCH /api/members-chat/:id`; it reaches only your manager's own messages. Delete with `DELETE /api/members-chat/:id`; it reaches those, or any message when your manager is an office owner. Pin, mark-read, uploads, and file reads are not available to OpenCode agents. Follow the route response on a 403, 404, or 409 rather than widening scope.

Safe example: `GET /api/members-chat?limit=50`.

## Route contract

`GET /api/members-chat`, `POST /api/members-chat`, `PUT /api/members-chat/:id/pin` (not available to OpenCode agents), `PUT /api/members-chat/:id/thumbs-up`, `PATCH /api/members-chat/:id`, `DELETE /api/members-chat/:id`, `POST /api/members-chat/read` (not available to OpenCode agents), `POST /api/members-chat/uploads` (not available to OpenCode agents), and `GET /api/members-chat/files/:filename` (not available to OpenCode agents) return the page/message/file outcome.

These routes require a privileged agent. Invalid bodies return 400/422; messages outside your reach return 403 or 404; stale state returns 409; backend failures return 500.
