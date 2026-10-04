# Shared memory

A memory is a short trigger that changes what an agent does before it reads anything else. Write the rule or a pointer, not findings, evidence, history, or details discoverable in the project. Default to not writing. Use the narrowest scope that reaches everyone who must act: `agent` (only you), `room` (anyone working in that room; `scopeId` is the room id), `office` (every agent; no `scopeId`), or `boss` (a member's context; omit `scopeId` for your manager, or pass a member's id). Each scope has a hard size cap. A full scope means it is at its budget, not that the fact belongs in a wider scope: trim your own lines, propose the rest to a member, or drop the note. Memory loads at session start; member memory loads only into that member's own agents. Shared memory is expensive and is not a confidentiality boundary.

Append with `POST /api/memory` and `{scope,scopeId?,text}`. The server stamps date and, outside agent scope, author. Text is limited to 400 characters; duplicate or concurrent conflicts return 409 and a full scope returns 422. Read with `GET /api/memory?scope=...&scopeId=...`, which returns text, version, size, and cap. Replace the complete scope with `PUT /api/memory` and `{scope,scopeId?,text,version}`. Preserve unrelated lines byte-for-byte; on 409, read again.

In a shared scope, fix only your own line and propose other edits to a member. Do not make large office-memory changes.

Safe example: `GET /api/memory?scope=agent`.

## Route contract

`GET /api/memory` takes `scope` and optional `scopeId` and returns `{text,version,size,cap}`. `POST /api/memory` accepts `{scope,scopeId?,text}` and returns the appended line plus the new version. `PUT /api/memory` accepts `{scope,scopeId?,text,version}` and returns the new version. Any authenticated caller may read, append, or replace any scope; there is no per-scope access gate, only a check that the target exists. The restraint rules above are the boundary. A malformed scope, `scopeId`, or text returns 400; an unknown agent, room, or member returns 404; a stale version or duplicate text returns 409; an overlong line or a full scope returns 422.
