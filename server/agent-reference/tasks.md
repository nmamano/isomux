# Task board

The board is room-scoped. An agent sees tasks in rooms its manager can access plus office-global tasks. A task has `roomId`, not a room name; no `roomId` means office-global. `GET /api/tasks` omits done tasks and open P4 (backlog) tasks by default. Use `status=all`, `priority=P0`-`P4`, `assignee`, `title`, or `roomId` filters; `priority=P4` lists open backlog tasks. An empty `roomId` selects global tasks. There is no `backlog` status.

Create with `POST /api/tasks` and `{title, description?, priority?, assignee?, roomId?}`. Update with `PATCH /api/tasks/:id` and the task's `version` from your last read; a stale version returns 409 with the current task. Priority is P0-P4, or `null` on update to clear it. Claim with `POST /api/tasks/:id/claim` and `{assignee}`; finish with `POST /api/tasks/:id/done`; delete with `DELETE /api/tasks/:id` (not available to OpenCode agents). A claim of a task held by someone else returns 409; to reassign it, update `assignee`. Attribution comes from the token. An agent create without `roomId` defaults to its room. Pass `roomId:""` for global.

Only touch the board when a member asks, except claim/complete bookkeeping for assigned board work: claim board-tracked work when you start it, and mark it done when you finish. On update, omitting `roomId` keeps the task's room. If an existing assignee differs from the task giver, do the work and surface it.

Safe example: `GET /api/tasks?status=all`.

## Route contract

| Method and route                                           | Request                                           | Success        |
| ---------------------------------------------------------- | ------------------------------------------------- | -------------- |
| `GET /api/tasks`                                           | Query filters above                               | `TaskItem[]`   |
| `GET /api/tasks/:id` (not available to OpenCode agents)    | Path id                                           | `TaskItem`     |
| `POST /api/tasks`                                          | Create fields above                               | `201 TaskItem` |
| `PATCH /api/tasks/:id`                                     | `version` plus partial create fields and `status` | `TaskItem`     |
| `POST /api/tasks/:id/claim`                                | `{"assignee":"name"}`                             | `TaskItem`     |
| `POST /api/tasks/:id/done`                                 | Empty body                                        | `TaskItem`     |
| `DELETE /api/tasks/:id` (not available to OpenCode agents) | Empty body                                        | `204`          |

All calls require task capability and room visibility. Hidden or missing tasks and inaccessible target rooms return 404; invalid status, priority, fields, or room returns 400/422; a stale version or a claim of a held task returns 409.
