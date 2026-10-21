# Conversation history

`GET /api/agents/:id/logs` lists sessions, newest first. A session can carry `summary`, a paragraph about its threads that can miss the latest messages. Add `limit` for a page, and `before=<lastModified>` of the last session listed for the next one; `truncated:true` means older sessions remain.

Add `q` to search decoded entries. Search results include session metadata, kind, snippet, and `{sessionId,entryId}`. Add `regex=1`, `limit`, `before`, `after`, or `kind`; `tier=prompts` returns incoming messages only, `tier=conversation` (default) adds replies without thinking and the messages you sent, and `tier=full` adds thinking and tool calls. `limit` defaults to 20 for search and 200 for retrieval; `before` and `after` are epoch ms. Search reports `totalMatches`. A broad search can stop early with `timedOut:true`, `totalMatches:null`, and `matchesFoundBeforeTimeout`, or fail with HTTP 504. Search also matches each session's summary and topic, and returns those sessions in `summaryHits` as `{sessionId,topic,lastModified,snippet}`.

Add `session=<id>` to fetch a conversation with its `summary`, or add `around=<entryId>&window=N` for a window. A running turn has only the entries already written, so take a count after the turn ends and state when you took it. Session responses also show current live state, not historical state, so check it before calling a silent agent stuck. Raw JSONL remains in `logDir` when exact bytes matter; an older session may be gzipped as `<id>.jsonl.gz`.

`GET /api/agents/:id/sessions` lists past sessions and the current session id. Killed agents keep logs when the killed roster allows discovery.

Safe example: `GET /api/agents/:id/logs?q=permission`.

## Terminal

`GET /api/agents/:id/terminal` returns the output of your own terminal, or of the terminal of any agent in a room your manager can access. The server keeps only the last 100,000 characters of an open terminal, in memory: a closed terminal or a server restart loses them. Escape codes are removed and secrets are masked as in the logs. Full-screen programs such as vim or less read as jumbled text. Add `lines=N` (1 to 10000) for the last N lines.

## Route contract

`GET /api/agents/:id/logs` uses the query modes and response shapes above. `GET /api/agents/:id/sessions` returns `{sessions:SessionInfo[],currentSessionId:string|null}`. User/API/agent callers need the route's room or killed-owner reach; cron-run callers and apps without an owner agent are refused. `GET /api/agents/:id/terminal` returns `{open,output,truncated}`: `open:false` with empty output when the agent has no terminal open, and `truncated:true` when older output was dropped. It has the reach of `/sessions`, and a bad `lines` returns 400 `invalid_lines`. Invalid query combinations return 400, inaccessible agents return 403, missing sessions return 404, and an expired search deadline returns 504.
