# Agent and member discovery

Use `GET /agents` with office authorization. It returns the live agents visible through the manager's room access, plus the lobby agent. Entries include `id`, `name`, `desk`, `room`, `roomName`, `roomId`, `topic`, `cwd`, model settings (`sandbox` is null for Claude agents), `username`, `logDir`, `pendingPrompt`, and `inFlightTurn`. `room` is a 1-based room number, or null for the lobby agent. A non-null `pendingPrompt` (`permission`, `resume`, `model`, `effort`, or `cronjob`) means the agent waits for someone to answer a prompt in its chat and is not working. `inFlightTurn` is null or `{startedAt,activeTool}` with epoch-ms times and no tool name. Do not treat this scoped list as the whole office.

Use `GET /agents?killed=1` for agents the manager spawned and later killed. These entries keep `id`, `name`, `agentType`, last-room data, `topic`, `killedAt`, and `logDir`. This scope differs from the live roster.

Member profiles are in `~/.isomux/users.json`. Read a profile when another member speaks and their preferences or member prompt matter.

Safe example: `GET /agents`.

## Route contract

`GET /agents` returns the live array above. `GET /agents?killed=1` returns the killed array above. User, API-token, and agent identities are accepted; cron-run and app identities are refused. A caller without identity gets 401, a cross-origin browser request gets 403, and an unsupported query gets 400.
