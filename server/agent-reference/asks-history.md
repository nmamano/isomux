# Ask history

Part of the `asks` page: closed asks, their answers, and what happened to an ask.

Closed asks are kept. `GET /api/agents/:id/asks/history` lists an agent's closed asks, newest first: your own, or those of any agent whose logs you can read (see the conversation-history page). Add `member=<username>` for the asks for one member and `limit` (1 to 200, default 50). For the next page, send the response's `nextBefore` as `before`. `GET /api/asks/:askId` returns any ask by its id, open or closed, when you can read its agent's logs. The id is on the ask card, so a member can give it to you.

A closed ask has `closed: {at, outcome, by, answer?, taskId?, app?}`. `outcome` is `replied`, `dismissed`, `filed`, for a secret request `saved` or `declined`, or for a sudo request `ran` or `declined`, when a member answered; `refused` when sudo refused three passwords for a sudo request; `withdrawn` when the agent, or the app that opened it, deleted the ask; `done` when its step was done; `agent_removed` when the agent was removed. `by` is the member who answered, or null. `answer` is their words as the agent got them, and `taskId` the filed task. `app` names the app that withdrew the ask.

A closed ask also has `events`, what happened before the close, oldest first. `{kind: "created", at, ask}` holds the ask as it was opened. `{kind: "edited", at, before, app?}` holds each field the edit changed with its value before the edit, null when the ask did not have it; `app` names the app that edited; without it, the agent edited. `{kind: "simplify_requested", at, by}` is a request for a simpler ask, with the member who asked, or null. `{kind: "simplify_withdrawn", at, by}` is its withdrawal, with the member who withdrew it, or null. An older ask can lack some or all events.

`GET /api/agents/:id/asks/events` is an agent's ask log: the events of its asks, open or closed, newest first. The same agents and members can read it as the history. Each event also has `seq` and `askId`, and a close is an event: `{kind: "closed", at, outcome, by, answer?, taskId?, app?}`, as `closed` above. Add `askId=<id>` for the events of one ask; `limit` and `before` work as on the history. To follow the log, read the first page and stop at the last `seq` you saw.

## Route contract

| Method and route                   | Request                           | Success                 |
| ---------------------------------- | --------------------------------- | ----------------------- |
| `GET /api/agents/:id/asks/history` | Query `member`, `before`, `limit` | `{asks, nextBefore}`    |
| `GET /api/agents/:id/asks/events`  | Query `askId`, `before`, `limit`  | `{events, nextBefore}`  |
| `GET /api/asks/:askId`             | None                              | The ask, open or closed |

An `:id` whose logs you cannot read returns 403. `GET /api/asks/:askId` returns 404 for an ask whose agent's logs you cannot read, as for an unknown id. On the history route, an unknown `member` returns 422 `unknown_member`. A bad `before` or `limit`, or another query parameter, returns 400 `invalid_query`.
