# Action asks

When only a member can make a change, open an ask with an action `step`. The card shows the change and an Apply button that makes it as the member. The ask closes when the change is made, by Apply or by hand, and you get a notice. Send no `link`.

An agent's access level (the access slider, Privileged included): `step` is `{"kind": "agent-access", "agentId": "<id>", "access": "<stop>"}`, with `access` as `PUT /api/agents/:id/access` takes it. A `pack` is refused.

The create refuses with 422 `unknown_agent` for an agent you cannot reach, 403 `member_not_allowed` when the member cannot make the change, 422 with the slider's code when the agent's engine or folder rules out that level, and 409 `step_done` when the change is made.

One room of a member's room access: `step` is `{"kind": "member-room", "username": "<member>", "roomId": "<room id>", "grant": true}`, or `"grant": false` to take the room. The rest of the member's rooms stay as they are. Only an office owner can apply it.

A member's role: `step` is `{"kind": "member-role", "username": "<member>", "role": "owner"}`, or `"role": "member"`. Only an office owner can apply it.

For both, the create refuses with 422 `unknown_member` for no such member, 403 `member_not_allowed` and 409 `step_done` as above. A room step also refuses 422 `unknown_room` for a room you cannot reach, 422 `lobby_open_to_all` for the lobby and 422 `owner_has_all_rooms` for an owner. A role step refuses 409 `last_owner` for the last office owner.

A member's permission pack: `step` is `{"kind": "member-pack", "username": "<member>", "pack": <pack>}`, with `pack` as `PUT /api/users/:username/access` takes it, or `null` for no pack. Only an office owner can apply it. The create refuses 422 `owner_has_no_pack` for an owner.

Your manager's own preferences: `step` is `{"kind": "member-preferences", "set": {...}}`, with the keys `PATCH /api/me/preferences` takes, except `recordingWords`. One room of your manager's room lists: `step` is `{"kind": "member-view", "list": "<list>", "roomId": "<room id>", "on": true}`, with `list` one of `shown`, `tucked`, `notif` (sound) and `push`. Both go only to your manager. A room step refuses 422 `unknown_room` for a room you or your manager cannot reach, and 409 `room_hidden` or `room_tucked` to turn on sound or push for a hidden or tucked room.

The office settings: `step` is `{"kind": "office-settings", "set": {...}}`, with the keys `PUT /api/office/settings` takes, less `version`. The backup settings: `step` is `{"kind": "backup-settings", "set": {...}}`, with the keys `PUT /api/backup/settings` takes. Only an office owner can apply them. A backup step refuses 409 `backup_dir_from_env` for a folder change while `ISOMUX_BACKUP_DIR` sets the folder. Each `set` takes only the keys and values its route takes, else 400.

A sign-in link for a member: `step` is `{"kind": "sign-in-link", "username": "<member>"}`. Signing a member out on every device: `{"kind": "member-sessions", "username": "<member>"}`. Ending one session of a member: `{"kind": "session-revoke", "username": "<member>", "sessionPrefix": "<prefix>"}`, with a prefix from the session list below; the ask closes when the session is gone, by Apply or by hand. Taking back a member's unused sign-in links: `{"kind": "sign-in-links-revoke", "username": "<member>"}`. An office owner can apply these for any member, a member only for themself. A sign-out or a session step refuses 409 `would_strand_office` when it would end the last owner sessions. A session step also refuses 422 `unknown_session` when that member has no live session with that prefix.

A personal API token for the member: `step` is `{"kind": "api-token", "name": "<name>", "expiresInDays": 30}`, with the fields `POST /api/me/api-tokens` takes. Revoking a token: `{"kind": "api-token-revoke", "tokenId": "<id>"}`. It refuses 422 `unknown_token` for a token that is gone or that the member cannot revoke.

The office's external access: `step` is `{"kind": "office-access", "externalAccess": true, "publicOrigin": "https://<host>"}`, as `PUT /api/office/access` takes it. Only an office owner can apply it. It refuses 403 `hosted_access_managed` on a Hosted Isomux office.

A sign-in link or token that Apply makes shows only on the member's card. You never get it.

To name a session, read your manager's live sessions, or any member's when your manager is an office owner: `GET /api/users/:username/sessions` returns `{sessions:[{sessionPrefix,device,userAgent,createdAt,lastSeenAt}]}`, last seen first. `device` is the name the device gave itself, or null; the user agent tells a script's session (such as `curl/8.5.0`) from a browser's. Another member, or an unknown one, returns 403.

Removing a member: `step` is `{"kind": "member-remove", "username": "<member>"}`. They stay in Removed members for 30 days. An office owner can apply it for any member but themself, a member only for themself. It refuses 403 `owner_self_delete` for an owner's own record and 409 `would_strand_office` for the last owner. Restoring a removed member: `{"kind": "member-restore", "username": "<member>", "agents": true}`; `agents` (default true) moves back their agents, schedules and webhooks. Deleting a removed member for good: `{"kind": "member-purge", "username": "<member>"}`. Both refuse 422 `unknown_member` when no removed member has that name. Only an office owner can apply them.

Updating the office to the latest release: `step` is `{"kind": "office-update"}`. It refuses 409 `not_managed` when the office has no updater (it updates as its host deploys it) and 409 `no_release` when no release is known. The ask closes when the office runs that release.

Deleting old files: `step` is `{"kind": "storage-prune", "target": "<target>", "olderThanDays": 90, "keepPerAgent": 2}`, with the fields `POST /api/storage/prune` takes, less `apply`. `target` is `transcripts`, `attachments`, `token-logs` or `terminal-recordings`; a transcripts prune states `keepPerAgent`. Compressing old conversations: `{"kind": "storage-compress", "olderThanDays": 30}`. Only an office owner can apply them. Both refuse 409 `step_done` when nothing matches now, and an apply refuses 409 `storage_busy` while a cleanup runs. The ages of the daily automatic cleanup have no step: send the owner to Settings → Housekeeping → Storage.

One of the member's WhatsApp chats routed to an agent: `step` is `{"kind": "whatsapp-route", "chatName": "<part of the chat's name>", "agentId": "<id>"}`, with the optional fields `trigger`, `sendDirect`, `prefix` and `ownMessages` as `POST /api/whatsapp/routes` takes them. An omitted field is the default: replies wait for the member's Send. You cannot read the member's chats: the card lists their chats whose name holds `chatName`, and the member picks one. A chat that goes to another agent moves to this one. The agent is one the member manages; an office owner may pick any agent. The create refuses 422 `unknown_agent`, 409 `whatsapp_not_linked` when the member has not linked WhatsApp, 403 `member_not_allowed` for an agent the member may not pick, 422 `agent_chat_only` for an agent at Chat stop, and 409 `step_done` when such a chat already goes to that agent with these settings.

One place of the member's Discord bots routed to an agent: `step` is `{"kind": "discord-route", "placeName": "<part of the place's name>", "agentId": "<id>"}`, with the optional fields `scope` (`channel`, `category` or `server`), `trigger`, `replyMode`, `prefix`, `includeBots` and `react` as `POST /api/discord/routes` takes them. An omitted field is the default: replies wait for the member's Send. The card lists the channels, categories and servers of the member's bots whose name holds `placeName` (a leading `#` is dropped), and the member picks one. A place that goes to another agent moves to this one. The same agent rule and refusals as `whatsapp-route` apply, with 409 `discord_not_connected` when the member has no Discord bot.

There is an action step for each setting that no agent can change. For a setting a privileged agent can change, ask for the privileged level with `agent-access` instead.
