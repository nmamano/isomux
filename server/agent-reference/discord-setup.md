# Discord setup

A privileged agent can connect your manager's Discord bot and route places to their agents. A standard agent gets 403. Only the member links WhatsApp, because the link needs their phone. To have a Discord place or a WhatsApp chat routed to an agent, open an action ask with a `discord-route` or `whatsapp-route` step (page `route-asks`).

First make the bot in your manager's browser (page `browser`): open your own tab at `https://discord.com/developers/applications`, or use a tab they offer. Click New Application, give it a name, accept the terms and click Create. On its Bot page, turn on Message Content Intent and click Save Changes. Read the Application ID on its General Information page. When Discord shows a step you cannot do, such as a captcha, a 2FA code or a password, open an ask that names that one step and says it is in your tab in their browser, and continue after the answer. With no browser, leave out `applicationId` below: the ask tells your manager how to make the bot.

Never click Reset Token, and never copy or keep a token that a page shows. Close your discord.com tab before you open the request, and open no Developer Portal tab while the request is open.

To connect the bot, open a request with `{"kind":"discord-bot","reason","applicationId"}` (page `connections`). It takes no other field but `link`. With `applicationId`, the ask links the bot's page, where your manager resets and copies the token, and a button that adds the bot to a server. Your manager types the token in the ask, so you never see it. The ask stays open while Discord refuses the token. An Isomux notice names the bot when it connects. Errors: 403 `forbidden` for a standard agent, 400 `invalid_request` for an `applicationId` that is not a Discord id, 409 `no_manager`, 409 `request_open` when your manager has an open request for a bot.

The bot sees only the servers it was added to. After the notice, read `GET /api/discord/bots/:botId/guilds`. A 404 means the bot has not connected yet: read again after a few seconds. If `GET /api/discord` shows its status `{state:"dead",reason:"intent_off"}`, turn on Message Content Intent on its Bot page, close the tab, and open a new request with the same `applicationId`: its save connects the bot again. When the read is `[]`, open an ask whose `link` is the bot's `inviteUrl` (`GET /api/discord`): your manager adds the bot to a server with one tap.

A route has `{botId, guildId, scope, targetId, name, agentId}`. `scope` is `channel`, `category` or `server`. `targetId` is the channel or category id, or the server id for `server`. `agentId` is an agent your manager manages. Optional: `trigger` (`mention`, the default, or `all`), `replyMode` (`ask`, the default, `bot` or `read`), `prefix`, `includeBots`, `react`. A route on `bot` sends your replies at once with no Send step: choose it only when your manager asks for it.

Safe example: `GET /api/discord`. The other calls open an ask for the member, send a message, or change your manager's Discord.

## Route contract

| Method and route                      | Request                                                                  | Success                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `GET /api/discord`                    | none                                                                     | `200 [{id, name, status, inviteUrl, addedAt}]`, your manager's bots                   |
| `DELETE /api/discord/bots/:botId`     | none                                                                     | `204`; the bot and its routes go                                                      |
| `GET /api/discord/bots/:botId/guilds` | none                                                                     | `200 [{id, name, channels:[{id, name, kind, parentId}]}]`; 404 until the bot connects |
| `GET /api/discord/routes`             | none                                                                     | `200` your manager's routes                                                           |
| `POST /api/discord/routes`            | a route                                                                  | `200` the route                                                                       |
| `PATCH /api/discord/routes/:routeId`  | `{name?, agentId?, trigger?, replyMode?, prefix?, includeBots?, react?}` | `200` the route                                                                       |
| `DELETE /api/discord/routes/:routeId` | none                                                                     | `204`                                                                                 |

On these routes, a bot or route that is not your manager's is 404, and a route with a bad field, an agent your manager does not manage, or a place the bot does not see is 400. A place that has a route is 409.
