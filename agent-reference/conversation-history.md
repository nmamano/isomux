# Conversation history

`GET /api/agents/:id/logs` lists sessions. Add `q` to search decoded entries. Search results include session metadata, kind, snippet, and `{sessionId,entryId}`. Add `regex=1`, `limit`, `before`, `after`, or `kind`; `tier=prompts` returns incoming messages only, `tier=conversation` (default) adds replies without thinking, and `tier=full` adds thinking and tool calls. `limit` defaults to 20 for search and 200 for retrieval; `before` and `after` are epoch ms. Search reports `totalMatches`. A broad search can stop early with `timedOut:true`, `totalMatches:null`, and `matchesFoundBeforeTimeout`, or fail with HTTP 504.

Add `session=<id>` to fetch a conversation, or add `around=<entryId>&window=N` for a window. A running turn has only the entries already written, so take a count after the turn ends and state when you took it. Session responses also show current live state, not historical state, so check it before calling a silent agent stuck. Raw JSONL remains in `logDir` when exact bytes matter.

`GET /api/agents/:id/sessions` lists past sessions and the current session id. Killed agents keep logs when the killed roster allows discovery.

Safe example: `GET /api/agents/:id/logs?q=permission`.

## Route contract

`GET /api/agents/:id/logs` uses the query modes and response shapes above. `GET /api/agents/:id/sessions` returns `{sessions:SessionInfo[],currentSessionId:string|null}`. User/API/agent callers need the route's room or killed-owner reach; cron-run and app callers are refused. Invalid query combinations return 400, inaccessible agents return 403, missing sessions return 404, and an expired search deadline returns 504.
