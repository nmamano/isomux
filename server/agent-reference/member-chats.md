# 1:1 chats

A 1:1 chat is between your manager and one other member. Only those two members see it in the office; office owners can still reach its files through an export or a backup. Post only when your manager asks, and the post shows as sent by you, an agent. `GET /api/member-chats` lists your manager's chats as `{chats:[{peerId,peerName,removed,unread,lastAt}]}`. The routes live under `/api/users/:username/chat`, where `:username` is the other member's name or id; use the id for a removed member. A removed member's chat is read-only (409 `peer_removed`). Edit and delete reach only your manager's own messages.

Safe example: `GET /api/member-chats`.

## Route contract

`GET /api/member-chats`, `GET /api/users/:username/chat`, `POST /api/users/:username/chat`, `PUT /api/users/:username/chat/:id/thumbs-up`, `PATCH /api/users/:username/chat/:id`, `DELETE /api/users/:username/chat/:id`, `POST /api/users/:username/chat/read`, `POST /api/users/:username/chat/uploads`, and `GET /api/users/:username/chat/files/:filename` return the page, message or file outcome, as the room chat routes do (page `room-chat`), without pins.

These routes require a privileged agent. Invalid bodies return 400/422; messages outside your reach return 403 or 404; stale state returns 409; backend failures return 500.
