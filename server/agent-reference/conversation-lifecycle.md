# Conversation lifecycle

`POST /api/agents/:id/new-conversation` with `{}` clears the current conversation and starts fresh; messages queued for the agent go to the fresh session. `POST /api/agents/:id/handoff` with `{text}` resets the conversation and immediately delivers a forward-looking brief to the fresh session, followed by the messages queued for the agent.

Use handoff when context is filling during unfinished work. Write the brief and post it in the same turn, without waiting for the member. The brief is forward-looking: the goal, the next concrete steps, working state not obvious from disk (uncommitted files, worktrees, in-flight commands), decisions the fresh session should not relitigate, open questions for the member, and pointers (files, docs, task IDs). Leave out a recap of this session and anything already in your system prompt, instructions or memory. Do not use a scheduled message as a handoff substitute. If the call fails, no handoff happened: show the member the brief and the error.

Isomux also runs the brief turn itself: when a member types `/handoff`, and, for an agent with automatic handoff on, when a message arrives after a turn left its context full. Isomux asks the agent for the brief, resets, and delivers the waiting messages after the brief. While Isomux waits for that brief, a handoff call returns 409 `handoff_in_progress`. A privileged operator can target another accessible agent; an ordinary agent targets itself.

Safe example: `POST /api/agents/:id/new-conversation` with `{}`.

A new conversation does not reload OpenCode plugins or config. Changes load after Isomux restarts, or after the member sends `/reload-plugins` to one of their OpenCode agents or saves a variable, secret or MCP server on the Integrations page, once none of their OpenCode agents is working.

## Route contract

`POST /api/agents/:id/new-conversation` accepts `{}` or `{"agentType":"claude"|"codex"|"opencode"}` and returns 204 No Content. An unknown `agentType` is ignored and the current/default engine is used. `POST /api/agents/:id/handoff` accepts `{"text":"brief"}` and returns `{"ok":true}` after reset and delivery. Ordinary agents target themselves; privileged/user callers need conversation access. Invalid handoff text returns 422, inaccessible targets return 403, and active/prompt/backend conflicts can return 409/429/500.
