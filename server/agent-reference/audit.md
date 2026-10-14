# Office audit log

Office owners, their API tokens, and privileged agents whose manager is an office owner can read `GET /api/audit-log`. Other callers get 403.

Filters: `actorKind`, `actorId`, `ownerId`, `targetId`, `operation`, `from`, `to`, `before`, `limit`. Times are epoch milliseconds. `before` is a sequence cursor. `limit` defaults to 100 and must be 1–1000. The response is `{items,nextBefore}`; a null cursor means there are no older matches. Invalid filters return 400. Entries contain the actor name at the time of the write. Task entries include changed values and deletion snapshots. Memory and prompt entries include the full text after the write: the office prompt, room prompts, agent custom instructions and member special instructions. Other entries contain identifiers and field names, never request bodies.

`POST /api/tasks/:id/restore` restores a deleted task with its original id and records the restore. It has the same owner gate. It returns 201, or 409 if the id exists, if no deletion was recorded, or if the task's room has closed (`room_unavailable`). The Settings audit list provides the same Restore action.

To restore an earlier memory or prompt text, write the text from its entry back through the normal route for that memory or prompt. The write records its own entry.

Safe example: `GET /api/audit-log?limit=100`.
