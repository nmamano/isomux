# Members chat

Members chat is the humans' office-wide chat; ordinary agents never see it. A post reaches every member and shows as sent by you, an agent. Post only when a member asks, directly or through another agent whose chat history shows the member's request. Also post when something must reach all the humans in the office.

`GET /api/members-chat?limit=50` returns `{messages,hasMore}`; add `before=<oldest id>` for older pages. Post with `POST /api/members-chat` and `{text}`: Markdown of at most 4000 characters. Thumbs-up with `PUT /api/members-chat/:id/thumbs-up` and `{active}`. Edit with `PATCH /api/members-chat/:id`; it reaches only your manager's own messages. Delete with `DELETE /api/members-chat/:id`; it reaches those, or any message when your manager is an office owner. Follow the route response on a 403, 404, or 409 rather than widening scope.

Safe example: `GET /api/members-chat?limit=50`.

## 1:1 chats

A 1:1 chat is between your manager and one other member. Only those two members see it in the office; office owners can still reach its files through an export or a backup. Post only when your manager asks. `GET /api/member-chats` lists your manager's chats as `{chats:[{peerId,peerName,removed,unread,lastAt}]}`. The same routes as members chat, without pins, live under `/api/users/:username/chat`, where `:username` is the other member's name or id; use the id for a removed member. A removed member's chat is read-only (409 `peer_removed`). Edit and delete reach only your manager's own messages.

## Route contract

`GET /api/members-chat`, `POST /api/members-chat`, `PUT /api/members-chat/:id/pin`, `PUT /api/members-chat/:id/thumbs-up`, `PATCH /api/members-chat/:id`, `DELETE /api/members-chat/:id`, `POST /api/members-chat/read`, `POST /api/members-chat/uploads`, and `GET /api/members-chat/files/:filename` return the page/message/file outcome. For 1:1 chats, `GET /api/member-chats`, `GET /api/users/:username/chat`, `POST /api/users/:username/chat`, `PUT /api/users/:username/chat/:id/thumbs-up`, `PATCH /api/users/:username/chat/:id`, `DELETE /api/users/:username/chat/:id`, `POST /api/users/:username/chat/read`, `POST /api/users/:username/chat/uploads`, and `GET /api/users/:username/chat/files/:filename` do the same.

These routes require a privileged agent. Invalid bodies return 400/422; messages outside your reach return 403 or 404; stale state returns 409; backend failures return 500.
