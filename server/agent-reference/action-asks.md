# Action asks

When only a member can make a change, open an ask with an action `step`. The card shows the change and a button that makes it as the member. The ask closes when the change is made, from the card or by hand, and you get a notice. Send no `link`.

An agent's access level (the access slider, Privileged included): `step` is `{"kind": "agent-access", "agentId": "<id>", "access": "<stop>"}`, with `access` as `PUT /api/agents/:id/access` takes it. A `pack` is refused.

The create refuses with 422 `unknown_agent` for an agent you cannot reach, 403 `member_not_allowed` when the member cannot make the change, 422 with the slider's code when the agent's engine or folder rules out that level, and 409 `step_done` when the change is made.

One room of a member's room access: `step` is `{"kind": "member-room", "username": "<member>", "roomId": "<room id>", "grant": true}`, or `"grant": false` to take the room. The rest of the member's rooms stay as they are. Only an office owner can apply it.

A member's role: `step` is `{"kind": "member-role", "username": "<member>", "role": "owner"}`, or `"role": "member"`. Only an office owner can apply it.

A member's avatar: `step` is `{"kind": "member-avatar", "username": "<member>", "avatarColor": "#rrggbb", "avatarVariant": "<ghost shape>"}`, with one field or both. An office owner can apply it for any member, a member only for themself.

For both, the create refuses with 422 `unknown_member` for no such member, 403 `member_not_allowed` and 409 `step_done` as above. A room step also refuses 422 `unknown_room` for a room you cannot reach, 422 `lobby_open_to_all` for the lobby and 422 `owner_has_all_rooms` for an owner. A role step refuses 409 `last_owner` for the last office owner.

A member's permission pack: `step` is `{"kind": "member-pack", "username": "<member>", "pack": <pack>}`, with `pack` as `PUT /api/users/:username/access` takes it, or `null` for no pack. Only an office owner can apply it. The create refuses 422 `owner_has_no_pack` for an owner.

Your manager's own preferences: `step` is `{"kind": "member-preferences", "set": {...}}`, with the keys `PATCH /api/me/preferences` takes, except `recordingWords`. One room of your manager's room lists: `step` is `{"kind": "member-view", "list": "<list>", "roomId": "<room id>", "on": true}`, with `list` one of `shown`, `tucked`, `notif` (sound) and `push`. Both go only to your manager. A room step refuses 422 `unknown_room` for a room you or your manager cannot reach, and 409 `room_hidden` or `room_tucked` to turn on sound or push for a hidden or tucked room.

The office settings: `step` is `{"kind": "office-settings", "set": {...}}`, with the keys `PUT /api/office/settings` takes, less `version`. The backup settings: `step` is `{"kind": "backup-settings", "set": {...}}`, with the keys `PUT /api/backup/settings` takes. Only an office owner can apply them. A backup step refuses 409 `backup_dir_from_env` for a folder change while `ISOMUX_BACKUP_DIR` sets the folder. Each `set` takes only the keys and values its route takes, else 400.

A member's sign-in links and sessions (a new link, 3 more days for a link, links taken back, a sign-out) and reading them: fetch the `sign-in-asks` page.

A personal API token for the member: `step` is `{"kind": "api-token", "name": "<name>", "expiresInDays": 30}`, with the fields `POST /api/me/api-tokens` takes. Revoking a token: `{"kind": "api-token-revoke", "tokenId": "<id>"}`. It refuses 422 `unknown_token` for a token that is gone or that the member cannot revoke.

The office's external access: `step` is `{"kind": "office-access", "externalAccess": true, "publicOrigin": "https://<host>"}`, as `PUT /api/office/access` takes it. Only an office owner can apply it. It refuses 403 `hosted_access_managed` on a Hosted Isomux office.

A token made from the card shows only on the member's card. You never get it.

Removing a member: `step` is `{"kind": "member-remove", "username": "<member>"}`. They stay in Removed members for 30 days. An office owner can apply it for any member but themself, a member only for themself. It refuses 403 `owner_self_delete` for an owner's own record and 409 `would_strand_office` for the last owner. Restoring a removed member: `{"kind": "member-restore", "username": "<member>", "agents": true}`; `agents` (default true) moves back their agents, schedules and webhooks. Deleting a removed member for good: `{"kind": "member-purge", "username": "<member>"}`. Both refuse 422 `unknown_member` when no removed member has that name. Only an office owner can apply them.

Updating the office to the latest release: `step` is `{"kind": "office-update"}`. It refuses 409 `not_managed` when the office has no updater (it updates as its host deploys it) and 409 `no_release` when no release is known. The ask closes when the office runs that release.

Deleting old files: `step` is `{"kind": "storage-prune", "target": "<target>", "olderThanDays": 90, "keepPerAgent": 2}`, with the fields `POST /api/storage/prune` takes, less `apply`. `target` is `transcripts`, `attachments`, `token-logs` or `terminal-recordings`; a transcripts prune states `keepPerAgent`. Compressing old conversations: `{"kind": "storage-compress", "olderThanDays": 30}`. Only an office owner can apply them. Both refuse 409 `step_done` when nothing matches now, and an apply refuses 409 `storage_busy` while a cleanup runs. The ages of the daily automatic cleanup: `{"kind": "storage-retention", "set": {...}}`, with the keys `PUT /api/storage/retention` takes. Only an office owner can apply it.

Adding one line to your instructions, your room's or your manager's: the `instructions-line` step, on the `ask-replies` page.

Routing one of the member's WhatsApp chats or Discord places to an agent, or changing the settings of one of their routes: fetch the `route-asks` page.

There is an action step for each setting that no agent can change. For a setting a privileged agent can change, ask for the privileged level with `agent-access` instead.
