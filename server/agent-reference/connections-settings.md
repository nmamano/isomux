# Changing connections

Part of the `connections` page. Privileged agents only; any other agent gets 403. To get a credential from a member, ask for it as a secret (`connections` page), never in a request body.

You have your manager's reach: your manager's connections, and the office's and every member's when your manager is an office owner. Anything else gets 403. `:username` is the member whose connections change.

Variables, one at a time:

- `PUT /api/users/:username/env/:name` with `{value,note?}` sets one; `DELETE /api/users/:username/env/:name` removes it.
- `GET /api/users/:username/env/names` lists another member's names and notes (owner reach).
- For the office: `PUT /api/office/env/:name`, `DELETE /api/office/env/:name` and `GET /api/office/env/names`.

Secrets:

- `GET /api/users/:username/secrets` lists them. `POST /api/users/:username/secrets` with `{name,value,hosts,form,exchange?,note?}` saves one (`exchange`: `connections` page).
- `PUT /api/users/:username/secrets/:name/value` with `{value}` replaces the value. `PATCH /api/users/:username/secrets/:name` with `{hosts?,form?,note?}` edits it. `DELETE /api/users/:username/secrets/:name` removes it.
- `POST /api/users/:username/secrets/:name/reissue` issues a new placeholder; the old one stops working. `POST /api/users/:username/secrets/:name/test` checks the secret with its service.
- For the office: `GET /api/office/secrets`, `POST /api/office/secrets`, `PUT /api/office/secrets/:name/value`, `PATCH /api/office/secrets/:name`, `DELETE /api/office/secrets/:name`, `POST /api/office/secrets/:name/reissue` and `POST /api/office/secrets/:name/test`.

MCP servers:

- `GET /api/users/:username/mcp-servers` lists them. `POST /api/users/:username/mcp-servers` with `{name,url,secret,note?}` adds one; `secret` is the name of a secret in the same scope that lists the server's host, or null.
- `PATCH /api/users/:username/mcp-servers/:name` with `{url?,secret?,note?}`, `DELETE /api/users/:username/mcp-servers/:name` and `POST /api/users/:username/mcp-servers/:name/test`.
- For the office: `GET /api/office/mcp-servers`, `POST /api/office/mcp-servers`, `PATCH /api/office/mcp-servers/:name`, `DELETE /api/office/mcp-servers/:name` and `POST /api/office/mcp-servers/:name/test`.

Voice and pager:

- `GET /api/users/:username/voice` returns `{voiceInput,voiceOutput,voiceName,keySource,keyName}`: what the member's mic and read aloud use, and where their OpenAI key comes from. `PATCH /api/users/:username/voice` with any of `{voiceInput,voiceOutput,voiceName}` changes them; the engines are `browser` or `openai`.
- `GET /api/users/:username/pager-settings` returns where the member's pages go, with the webhook URL masked. `PATCH /api/users/:username/pager-settings` with `{webhookUrl?,discordUserId?,repeatMinutes?}` changes it; `POST /api/users/:username/pager-settings/test` sends a test page.

You never read a value. Variable values and a secret's Show stay with members. An MCP server comes back with its `host` in place of its URL. A member signs in to an MCP server that uses OAuth on the Integrations page.

You cannot add a host to a saved secret: 403 `secret_host_add_refused`. You can remove hosts, and you set them when you save a new secret.

On a saved secret you cannot add, change or remove `exchange`, or move its form to or from `query`: 403 `secret_exchange_change_refused`. The host of the token address stays while `exchange` is set (400 `invalid_secret`, field `exchange`).

A secret with a host cannot use a model sign-in key name such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`: the engine signs in with it and fails. The save or edit gets 400 `invalid_secret` with reason `model_key`; set it as a variable.

A secret can also go to apps: the app gets the value in its environment. Only a member gives a secret to an app, on the Integrations page. A save with `apps`, or an edit that adds one, gets 403 `secret_app_add_refused`. You can remove apps with `PATCH` and `{apps}`, the names that stay. A secret with no host is not in your environment or in `GET /api/agent-connections`.

Safe example: `PUT /api/users/:username/env/TZ` with `{"value":"Europe/Madrid"}`.

## Route contract

The change routes answer 204 for a variable or a removal, `{secret}` or `{server}` for a save or an edit, `{result}` for a test, and the lists `{secrets}`, `{servers}` or the names. A body that is not valid gets 400 (422 for voice and pager), and the error never repeats the input. An unknown name gets 404, and a name that exists gets 409.
