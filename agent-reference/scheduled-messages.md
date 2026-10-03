# Scheduled messages

Schedule an agent message by adding `deliverAt` to `POST /api/agents/:recipientId/messages`. Use RFC3339 with an explicit UTC offset, in the future and at most 30 days ahead. Delivery survives restart and can wake an idle recipient. The create response names the item `scheduledId`.

`GET /api/agents/:senderId/scheduled-messages` lists the sender's outbox as `{scheduled:[...]}`. Entries use `id`, `receiverAgentId`, `deliverAt` in epoch milliseconds, and `text`. `DELETE /api/agents/:senderId/scheduled-messages/:id` cancels an item; use the create response's `scheduledId`. The route id is recipient on create but sender on list/delete.

Safe example: `POST /api/agents/:id/messages` with `{"text":"wake up","deliverAt":"<future RFC3339 time>"}`.

## Route contract

`POST /api/agents/:id/messages` with `deliverAt` returns `{scheduledId}`. `GET /api/agents/:id/scheduled-messages` returns `{scheduled:ScheduledMessageEntry[]}`. `DELETE /api/agents/:id/scheduled-messages/:scheduledId` returns 204. Agent callers can manage only their own outbox; privileged/user callers follow conversation access. Invalid time returns 400/422, another sender's outbox returns 403, an absent/fired id returns 404, and quota returns 429.
