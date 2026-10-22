# Agent and member discovery

Use `GET /agents` with office authorization. It returns the live agents visible through the manager's room access, plus the lobby agent. Entries include `id`, `name`, `desk`, `room`, `roomName`, `roomId`, `topic`, `cwd`, model settings (`sandbox` is null for Claude agents; `model` is the model the agent runs, as a canonical Anthropic id such as `claude-sonnet-4-5`, or a Bedrock or Vertex pin as set), `manager`, `logDir`, `pendingPrompt`, and `inFlightTurn`. `room` is a 1-based room number, or null for the lobby agent. A non-null `pendingPrompt` (`permission`, `resume`, `model`, `effort`, or `cronjob`) means the agent waits for someone to answer a prompt in its chat and is not working. `inFlightTurn` is null or `{startedAt,activeTool}` with epoch-ms times and no tool name. Do not treat this scoped list as the whole office. A room's back room (up to 100 agents, `desk` 8 to 107) shows as one entry: `{name: "34 in the back room", backRoom: true, roomId, roomName, room, agents, busy, pendingPrompt}`. That entry has no `id` and is not a message target. Add `?back=1` to list back room agents one by one, each with `backRoom: true`; use it to find an agent by name.

Use `GET /agents?killed=1` for agents the manager spawned and later killed. These entries keep `id`, `name`, `agentType`, last-room data, `topic`, `killedAt`, and `logDir`. This scope differs from the live roster. The list is newest kill first and pages: `limit` (default 100, max 500) and `before=<killedAt>`. For the next page, pass the last entry's `killedAt` as `before`. A page shorter than `limit` is the last one.

Member profiles are in `~/.isomux/users.json`. Read a profile when another member speaks and their preferences or member prompt matter.

Safe example: `GET /agents`.

## Route contract

`GET /agents` returns the live array above; `GET /agents?back=1` returns it with every back room agent listed. `back` takes only `1` and never goes with `killed`. `GET /agents?killed=1` returns the killed array above. User, API-token, agent, and cron-run identities are accepted, and an app identity while its owner agent is live; cron-run gets 403 on `?killed=1`. A caller without identity gets 401, a cross-origin browser request gets 403, and an unsupported `killed` or `back` value or a bad `limit` or `before` gets 400.
