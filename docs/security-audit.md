---
navTitle: Security audit
---

# Isomux security audit

**Date:** 2026-10-03, last updated 2026-10-14. This audit replaces the audit of 2026-05-17.

**Method:** Static review of the Isomux source. No live attack tests were done.

**Authors:** Claude agents in the Isomux office, under the direction of Nil Mamano, the primary author of Isomux. A second agent reviewed each statement against the source.

**Scope:** Who can get access to an office, and what each identity can do after it gets access. Out of scope: denial of service, the supply chain, and the security of the model providers.

---

## 1. Summary

Each office API request and each office WebSocket connection needs a valid credential. Each credential that Isomux mints is a 256-bit random value. The credential files keep SHA-256 hashes, not raw values. Section 4.1 tells where raw values exist. The browser surface rejects cross-site requests and cross-site WebSocket connections. Webhook deliveries (`POST /hooks/:id`) need no credential, only a valid signature (section 4.7).

Inside the office, the boundary is the operating-system user. On every hosting setup, the server, its agents, the terminal panels, the apps and the scheduled runs all run as the same OS user. Thus a member or an agent that runs a shell command can read and change everything that the server can: the office state and the credentials of other members. On an installer-managed box and on a self-hosted office, it can also change the server code. Room access and the safety hooks do not change this. This is a design choice: one shared OS user lets members and agents work on the same files and with each other. Separate OS users would make that collaboration harder, and agents that talk to each other could still pass data across.

Thus, give office access only to persons you trust with a shell on the server. A personal API token gives the same access as its owner, from any network.

---

## 2. Identities

| Identity           | How it signs in                               | What it can do                                                                                                                                                                              |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner              | Browser session cookie                        | Everything a member can do. Also: create members, mint sign-in links, change room access, change office settings, revoke the sessions of any member, manage the integrations of any member. |
| Member             | Browser session cookie                        | Use the rooms the owner gives them: agents, terminal panels, tasks, files, apps, schedules. Mint their own device links and API tokens.                                                     |
| Personal API token | `Authorization: Bearer isomux_pat_…`          | The reach of the member who minted it, with some exclusions. See section 5.                                                                                                                 |
| Agent              | `ISOMUX_AGENT_TOKEN` in the agent environment | Its own chat affordances, messages to other agents, the task board, memory, logs, apps, webhooks, and pages to its manager.                                                                 |
| Privileged agent   | The same agent token, with more capabilities  | Also: drive other agents, manage rooms and schedules, all inside the reach of the member who spawned it. See section 6.2.                                                                   |
| Scheduled run      | A run token in the run environment            | Its own run affordances, messages that show the schedule as sender, and office-wide tasks.                                                                                                  |
| App                | `ISOMUX_APP_TOKEN` in the app environment     | Send messages to the agent that built it, and raise and resolve its own pages to its owner. Nothing else.                                                                                   |

Isomux reads the role and the room access of a member from the live state on each request. A change to a role, to room access or to a member record has an effect on the next request.

---

## 3. The OS user boundary

### 3.1 One OS user per office

| Hosting setup                                                     | OS user of the server and of everything it starts |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| Installer (Hosted Isomux, or a VPS set up with deploy/install.sh) | The `isomux` service user                         |
| Self-hosted office that its owner runs                            | The owner's own login user                        |
| Container (Docker, Render, AWS, Kubernetes)                       | The container user `node` (uid 1000)              |

No code in Isomux starts an agent, a terminal, an app or a scheduled run as a different user.

### 3.2 What follows

- **Members have shell access.** A member can open a terminal panel on each agent in their rooms. The terminal runs as the server's OS user. An agent can also run shell commands for the member.
- **Shell access is access to all office state.** The state directory (`~/.isomux`) holds the user records, the session and invite hashes, the API token hashes, the managed environment files of all members (`user-env/`, `office-env/`), the secrets of all members and the office (`secrets/`), the remote MCP servers that members and owners register (`mcp-servers/`), the webhook secrets, the Discord webhook URLs of the pager, the pager's Web Push key and device endpoints (`web-push.json`), and the provider sign-ins of all members (`provider-homes/`). File modes such as 0600 do not stop a process that runs as the owner of the file.
- **A process with that user can change what the server does.** It can write state that the server reads at start. After the next restart, it can have a sign-in that it made itself. On an installer-managed box and on a self-hosted office, that user also owns the server code and can change it. In the container image, root owns the code.
- **Room access is not a boundary against a member.** Room access controls what the office UI and API show. A shell in one room can read the files of all rooms.
- **The safety hooks are a guardrail, not a boundary.** See section 6.3.
- **If the OS user can become root, nothing in this document is a boundary.** The installer stops when its service user can log in as root or use `sudo` (see [Root access](hosting-reference.md#root-access)). On a self-hosted office, the owner's login user often has `sudo`. If it needs no password, an agent can use it.

This is a tradeoff between isolation and collaboration, not a defect with one correct fix. One shared OS user lets members and agents work on the same files and with each other.

A narrower change is planned: the server process gets its own OS user. Members and agents keep sharing one user with each other, but they can no longer read or change the server's state directory and its credentials.

---

## 4. Access from outside the office

This section is about an attacker who has no credential.

### 4.1 Credentials

| Credential                                   | Format                            | Lifetime                                                      | Stored as                                                                           |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Session cookie                               | 32 random bytes                   | 30 days after last use, 1 year at most                        | SHA-256 hash in `sessions.json`                                                     |
| Sign-in link from an owner                   | 32 random bytes in the URL        | 24 hours, one use                                             | SHA-256 hash in `invites.json`                                                      |
| Device link (a member, for their own device) | 32 random bytes in the URL        | 1 hour, one use                                               | SHA-256 hash in `invites.json`                                                      |
| Owner recovery link                          | 32 random bytes in the URL        | 15 minutes, one use                                           | SHA-256 hash in `invites.json`                                                      |
| Personal API token                           | `isomux_pat_` and 32 random bytes | 30 days, 365 days or no expiry                                | SHA-256 hash in `api-tokens.json`                                                   |
| Agent and run tokens                         | 32 random bytes                   | Until the agent stops or the run ends, or the server restarts | Process memory only                                                                 |
| App token                                    | 32 random bytes                   | Until the app is deleted                                      | SHA-256 hash in `apps/app-tokens.json`; the raw value in the app's environment file |
| Webhook secret                               | 32 random bytes                   | Until the owner rotates it or deletes the hook                | Plain text in `webhooks/secrets.json`, because the HMAC check needs it              |

Isomux compares hashes in constant time. Isomux does not write the credentials that it mints to its logs. A secret that a person or an agent types into a message is a different case (section 8.3).

### 4.2 Browser surface

- **Cookie.** `HttpOnly; Path=/; SameSite=Lax`, with no `Domain`. On HTTPS the cookie is `Secure` and has the `__Host-` prefix, so a subdomain cannot set it.
- **Origin.** The operator sets the public origin in the office configuration. The server never takes it from the `Host` or `X-Forwarded-Host` header. This stops DNS rebinding and Host-header attacks.
- **WebSocket.** A browser connection needs a valid cookie and an exact Origin match. A WebSocket request with an `Authorization` header never falls back to the cookie. It opens only with an API token, and that socket only receives (section 5.4).
- **Cross-site requests.** The server rejects a POST, PUT, PATCH or DELETE with a wrong Origin. `SameSite=Lax` also keeps the cookie off cross-site subrequests.
- **Sign-in forms.** The accept and sign-out forms need the office Origin. When the browser sends no Origin or `null`, they need `Sec-Fetch-Site: same-origin`, which page script cannot set. The first-owner form needs the setup key instead (section 4.3).
- **Headers.** Each office page has a Content Security Policy with `frame-ancestors 'none'`, and `X-Content-Type-Options: nosniff`. Pages that can have a token in the URL send `Referrer-Policy: no-referrer`. On HTTPS, the server sends HSTS for one year, without `includeSubDomains`.
- **Files that agents and members show.** Each file route sends a `sandbox` Content Security Policy. A file opened in the browser, such as HTML or SVG, runs in an opaque origin. It gets no session cookie, and the office WebSocket refuses it. The file routes check room access, and they send `Cache-Control: private, no-cache`.

### 4.3 First owner

Before the first owner exists, the server listens only on `127.0.0.1`. The first-owner form is only available on the server, through an SSH tunnel, or through a proxy on the server, and the claim needs the setup key. A key set in `ISOMUX_SETUP_KEY` is used; without one, the server makes a 256-bit key at its first boot without an owner and keeps it in `~/.isomux/setup-key`, mode 0600. At each boot without an owner, the server prints a setup link with the key in the URL fragment, which browsers do not send, so no request line or proxy log has it. The server compares keys in constant time, and it refuses a client after 20 wrong keys in one minute. When an owner exists, the server deletes the key file, and the form closes and does not open again.

### 4.4 Proxies

By default, the server trusts no forwarding header. The `trustedProxy` setting declares a proxy:

- `none` (default): no proxy.
- `same-host`: a proxy on the same machine, for example Caddy. The installer sets this value.
- `load-balancer`: a load balancer in front of the container. The container image sets this value.

A request is **on-box** when it comes from loopback and has no `X-Forwarded-For`, `Forwarded` or `X-Real-IP` header. Agent, run and app tokens work only on-box. Thus a leaked agent token does not work through the public URL. The first-owner form also needs an on-box request. Personal API tokens work from any network, because they are for remote use.

The limit: a same-host proxy that sends no forwarding header (for example `socat` or `ssh -R`) looks like the box itself.

### 4.5 Rate limits

Rate limits use the client address: the rightmost `X-Forwarded-For` entry from the declared proxy, or else the peer address:

- `/readyz`: 30 requests per minute for each client. On-box requests have no limit.
- App sign-in: a limit for each app and client.
- The container setup form: a limit for each client.
- Webhook deliveries (`POST /hooks/:id`, which needs only a valid signature): for each hook, 300 requests per minute with a burst of 60, before the body read and the signature check. An unknown hook id gets 404 before this limit. A delivery rejected before the signature check only raises a counter; it writes no log row. Signed deliveries start at most 10 dispatches per minute and 500 accepted dispatches per day for each hook.

Limits of this design:

- In `load-balancer` mode, a caller inside the cluster can reach the pod directly and set its own `X-Forwarded-For`. Thus it can select its rate-limit key. It cannot use an agent token, because its peer is not loopback.
- If a platform puts more than one proxy in front of the office, the limit applies to each proxy node, not to each client. This is not checked on Render.

The sign-in link page (`/i/<token>`) and the accept form have no rate limit. With 256-bit tokens, a guess attack is not possible.

### 4.6 App hosts

Each app has its own host name (`<label>.<app domain>`), which is a different origin from the office. The relay removes the office cookies before it sends a request to the app. An app session lasts 12 hours at most. A host name that has no live app gets the same answer as a live app, so an attacker cannot list app names. A `preview-url` capture of an app the agent's manager may open signs in to that one app with a single-use code; the session ends with the capture and does not open WebSockets.

Every app-host response permits framing only by the app itself and the configured office origin. Isomux replaces upstream frame-ancestors and removes X-Frame-Options; it preserves other CSP directives and report-only policies. A framed request with no live app session sends a fixed, origin-bound sign-in signal. The signal reveals no app or member data.

### 4.7 Webhooks

A webhook lets an outside service, such as GitHub, send a message to an agent or start a schedule run. Each hook has a public URL, `<office origin>/hooks/<id>`, with 64 random bits in the id.

- **The signature is the only check.** A delivery needs no session or token, and Isomux reads no forwarding header for it. Isomux computes the HMAC-SHA256 of the raw body with the hook's secret, and compares it with the signature header in constant time. A header with a wrong form fails before any decode. The route answers only on the office host, not on an app host.
- **Before the signature check**, Isomux finds the hook, checks the method and the rate limit (section 4.5), and reads at most 5 MiB of body. A disabled hook gets the same 404 as an unknown id.
- **Replays.** The signature covers the body only. It has no time stamp, and it does not cover the event and delivery-id headers. While the body's SHA-256 hash is in the hook's delivery log of the last 24 hours (500 rows at most), a copy of the body is a duplicate, and Isomux does not dispatch it. One exception: when the earlier delivery hit the dispatch limit or found no target, the copy is a retry with the stored event, and it can dispatch. After that window, a person who has a signed body can send it again with any event header, and Isomux can dispatch it again. The secret, the rules, the limits and the target checks still apply.
- **What reaches the target.** Isomux does not send the payload. It sends only the args that the hook's rule takes from the payload, in a data block. Isomux writes each line outside the JSON. In the JSON line, `<`, `>` and `&` are `\u` escapes and there is no newline, so a value cannot close the block. The block tells the model that the JSON comes from an outside sender and is data, not instructions. An agent message starts with `[Webhook "<name>"]`, and a hook name has only lowercase letters, digits and hyphens. The system prompt of a run that a webhook starts has the same statement.
- **Prompt injection.** The block keeps the layout. It does not stop a model from following text in a value as an instruction. The signature proves the sender, not the author of the content: a GitHub hook on a public repository carries issue and comment text from any GitHub user. The target agent runs shell commands with its manager's environment, and a schedule run uses the environment of its maker (section 7).
- **Targets.** A hook targets an agent in a room that the hook owner can access, or a schedule. To point a hook at a schedule, the caller must be able to manage that schedule: its maker, an office owner, or the maker's API token or privileged agent. Also, the hook owner must have made it or be an office owner. Isomux checks the target again on each delivery. A webhook starts a run also when the schedule is turned off, as Run now does.
- **Who sees a hook.** A hook belongs to the member who created it, also when their agent created it, and to its target's room: the room of the target agent or of the target schedule. The hook owner, office owners and the members of that room, with their agents and API tokens, see the hook, its rules and its delivery log, and can dry-run it. The delivery log shows the event names, the delivery ids, the outcomes, the matched rule, the args and the target. Only the hook owner and office owners can change or delete it. A hook whose target is gone, has no room or is in a closed room is only for its owner and office owners. A hook that the caller cannot see gets the same 403 as an unknown id. An agent needs no privileged flag for this.
- **The secret.** Only a browser session of the hook owner or of an office owner can read or rotate the secret. An agent, a scheduled run, an app and an API token get 403. This is a guardrail, not a boundary: an agent with a shell can read `webhooks/secrets.json` (section 3.2).

---

## 5. Personal API tokens

### 5.1 Reach

A personal API token acts as the member who minted it. It has that member's live role and room access. It can drive agents, rooms, tasks, apps, schedules, memory and files, and read logs. It can read and replace its member's managed environment variables, and show its member's saved secrets. An owner's token can also manage the integrations of any member and show the office secrets (section 7). It can replace its member's pager settings, which hold the Discord webhook URL, but it reads only the masked URL. It can add and remove its member's notification devices. It can manage its member's webhooks. An owner's token can also create a member and give that member room access. The new member cannot sign in until a human owner mints a sign-in link. An owner's token can change the office prompt, the office name and the member usage cap. A token can read and edit its member's special instructions, and an owner's token any member's.

A token cannot:

- mint, list or revoke API tokens, including itself,
- mint sign-in links,
- list or revoke browser sessions,
- change other member record fields or room access,
- change other office settings,
- make an agent privileged,
- read or rotate a webhook secret,
- open a terminal panel.

These exclusions do not make a boundary. A token can spawn an agent, and the agent runs shell commands as the server's OS user (section 3). Thus a token has shell-equivalent access. Treat it like a password for a shell account on the server.

### 5.2 Mint and storage

Each member can mint tokens in **Settings → You → API tokens**. Only a browser session can mint a token. An agent, an app or another token cannot.

Isomux shows the raw token one time. It stores the SHA-256 hash, the name, the dates, and a display prefix: `isomux_pat_` and the first 8 characters of the secret. The file is `api-tokens.json` (mode 0600).

### 5.3 Expiry and revocation

- The member selects 30 days, 365 days or no expiry.
- The member revokes a token in the same pane. The revocation has an effect on the next request, and it closes the token's open WebSocket.
- An owner can list and revoke the tokens of each member, on the member's profile in **Settings**. The effect is the same.
- Isomux records the last use of each token.

### 5.4 Remote inbox

An agent can send a reply to a token holder (`POST /api/api-token-inboxes/<token-id>/messages`). The token must belong to the member who manages that agent. A reply has 4000 characters at most.

The token holder reads replies over HTTP (`POST /api/me/api-token-inbox/drain`) or over a WebSocket that only receives. Reading does not delete entries. The messages to and from a token are stored in `token-logs/<token-id>.jsonl`, with secrets masked as in agent logs (section 8.3). Entries that older versions wrote stay as plain text. The inbox has no size limit. An owner can remove old entries with storage pruning. Revocation does not delete the log.

---

## 6. Agents

### 6.1 Agent tokens

Isomux puts a new token in the environment of each agent and each scheduled run. The token lives only in memory, and it stops when the agent stops, when the run ends, or when the server restarts. Isomux takes the sender of a message from the token, not from the request body. An agent can use its chat affordances only on its own chat.

A terminal panel does not get an agent token.

### 6.2 Privileged agents

An owner can make any agent privileged. A member can make privileged only the agents that they spawned. No agent can set the flag.

A privileged agent gets a part of its member's capabilities: it can drive other agents, create rooms, manage the rooms that its member can access, manage its member's schedules, and read and upload files. If its member is an owner, it can also create a member, as an owner's API token can (section 5.1), and change the office prompt, the office name and the member usage cap. It cannot mint sign-in links, revoke sessions, change room access or other office settings, or open a terminal panel.

A privileged agent can read and edit its manager's special instructions, or any member's when its manager is an office owner. This does not grant other user-record edits. Prompt writes from agents and humans require the version from the read; stale writes return 409.

A privileged agent can add, change, remove and test its manager's variables, secrets and MCP servers, and the office's and every member's when its manager is an owner. It never reads a value: no variable values, no Show, no MCP sign-in, and the MCP server routes give it the host in place of the URL. It cannot add a host to a saved secret: it holds the secret's placeholder and could send it to a host it controls. An ordinary agent only reads its connections and asks for a secret.

A privileged agent has the destructive reach of its member. For example, it can close a shared room. Give the flag as you give your own seat.

### 6.3 Safety hooks

Isomux checks each recognized tool call of Claude, Codex and OpenCode agents before it runs. No setting turns the check off. The check blocks:

- destructive git commands, such as `git reset --hard`, `git push --force` and `git clean -f`,
- `rm -rf` outside one entry in `/tmp` or `/var/tmp`,
- writes into the state directory,
- reads of files that usually hold secrets, such as `.env`, private keys, backend sign-in files, and the secrets and managed environment files in the state directory,
- recursive searches (`grep -r`, `rg`, the Grep tool) rooted at the secret store or above it, unless they exclude `secrets/`,
- recognized process-kill commands, such as `pkill`, `killall` and kills of processes found by name,
- recognized commands that open outbound tunnels,
- recognized uses of the owner recovery socket.

The check reads each command of a shell line, also the commands inside `bash -c`, `eval` and command substitutions. One blocked command blocks the line.

The safety hooks are a guardrail against mistakes by honest agents. They are not a security boundary:

- They recognize known command forms. A script, a renamed program or an interpreter can do the same thing.
- They see only the tools that they map. For example, an MCP server with file access goes around them.
- For Codex and OpenCode, if the checker cannot run, the call runs. Isomux then shows a warning in the chat.
- Reads in the state directory are allowed, because agents need logs and discovery.

### 6.4 Owner recovery

An operator who loses the last owner session can mint a 15-minute owner sign-in link through a Unix socket (`admin.sock`). By default the socket is in the state directory. On Kubernetes, it is on a volume that the office and a recovery container share. The socket reads the OS user of the caller from the kernel. It answers only root. On Kubernetes, it also answers a separate recovery container that runs as a different user. It always refuses the server's own OS user, so an agent cannot mint a sign-in link through it.

This closes the one-call route. It does not close the class in section 3.2: a process with the server's OS user can still change state that the server reads at start.

### 6.5 Agent affordances that reach outside the chat

- **Show a file** (`read-file`) copies any file that the server's OS user can read, up to 20 MiB, into the chat. It does not check for secrets. The members of the room can then open the file. The agent does not read the content, so this is also a way to give a member a secret without passing it through the model.
- **Preview a page** (`preview-url`) opens any HTTP or HTTPS URL in a browser on the server. This includes loopback and internal addresses. The only control is the agent system prompt.
- **Browser control** acts only on a tab that the agent's manager offers in the paired Chrome extension.

### 6.6 The secret proxy

An agent, terminal or scheduled run with a secret in scope gets a placeholder in place of each value, and the proxy and trust variables (`HTTPS_PROXY`, `SSL_CERT_FILE` and similar). A child process of the server, on a loopback port, puts the value into requests to the hosts that the secret lists, only in the header that the secret names. For those hosts it ends TLS with a certificate from the office CA, which agents with a secret trust. Every other host, and the model and package registry hosts on the fixed never-list, pass as plain tunnels. The proxy removes the value from responses as a backstop; a host that returns it in another encoding (hex, for example) defeats that. Each use of a secret is an audit entry. A placeholder is a bearer credential inside the office: any process on the box that has it can use the secret for its listed hosts. A member can reissue a placeholder: the old one stops working at once, and the agents in scope get the new one at their next start.

An agent can ask for a secret (`POST /api/agents/:id/secret-requests`). The request waits as an ask (`~/.isomux/asks.json`, which holds the request and never a value); the value goes from the member's browser to the store, never into the transcript. A reply or dismiss on that ask is refused, so a value typed there cannot reach the chat. Only the agent's manager can save a personal secret, and only an owner an office secret. The agent gets the placeholder.

---

## 7. Members inside the office

Section 3.2 applies first: a member with a terminal panel or an agent has shell access. The items below describe the office API.

- **Rooms.** A member sees only the agents, files and tasks of their rooms, plus the lobby and office-wide tasks. Any member can create a room. A member with access to a room can rename it or close it.
- **Files.** Upload and file routes check room access. A denial gets the same 404 as a missing file. The files of a stopped agent follow its last room. When that room is gone, only owners can read them.
- **Schedules.** A schedule belongs to a room, or to no room. The members of its room see the schedule, its runs and their transcripts. A run uses the environment of the maker, so a transcript can show their secrets. Only the maker and owners can change, delete or run it. A schedule with no room, or whose room was closed, is visible only to the maker and owners.
- **Integrations.** An owner manages the variables, secrets and MCP servers of every member, but never reads the value of a member's variable or secret: an owner sets or removes one variable at a time, and replaces or removes a secret. A member reads the names, hosts and notes of the office's variables, secrets and MCP servers, never a value, an MCP server's URL path or the name of its credential. Show returns a saved secret's value to the member who owns it, or an office secret's value to an owner. No agent token, privileged or not, can call Show, and each Show writes an audit row with the secret's name. A privileged agent changes integrations with its manager's reach (section 6.2); the audit row names the agent. An agent with a shell can still read the secret files (section 3.2). An audit row of an owner's change to a member's integration names that member. Removing a member deletes their variables, secrets and MCP servers.
- **Shared devices.** A session cookie lasts up to one year. A member who does not sign out on a shared computer leaves access open. Revoke it in Settings → You → Sign-in links, or an owner revokes it in Settings → Office → Sessions: an open tab closes in about one second.

---

## 8. Data at rest and outbound data

### 8.1 State files

All office state is in the state directory: `~/.isomux` of the server's OS user, or `/var/data/home/.isomux` in the container. The credential files (`api-tokens.json`, `token-logs/`, `user-env/`, `office-env/`, `secrets/`, `mcp-servers/`, `apps/app-tokens.json`, `webhooks/secrets.json`, `pager-settings.json`, `provider-homes/`, each OpenCode profile `opencode/profiles/<key>/`) have mode 0600 or 0700. The managed environment files and the secrets hold their values as plain text. `secrets/` also holds the placeholder key and the office CA key. A registered MCP server's header holds its secret's placeholder, never the value, so the config file of each OpenCode profile (`opencode/profiles/<key>/opencode.json`, mode 0600) holds no value.

### 8.2 Backups

Daily backups do not include the managed environment files, the secrets, the registered MCP servers, the OpenCode profile configs, the app environment files, the container app tokens, the webhook secrets, the pager's Discord webhook URLs, the pager's Web Push key and devices, the TLS key or the backend sign-in files. They include `api-tokens.json` (hashes only), the token logs, and the agent logs. Logs can hold sensitive text that a member typed or that a tool printed.

### 8.3 Secret redaction in logs

Before Isomux stores a new agent, scheduled-run or token log entry, it masks values that look like provider keys or `API_KEY=…` assignments. It keeps the first 8 characters. It also masks the value of every secret of 8 characters or more, whatever its shape, raw, URL-encoded and base64. A new secret value must have at least 8 characters. This is a backstop: it can miss secrets. If the scan fails, Isomux stores the original entry. Attachments, terminal output and backend transcripts are not scanned.

### 8.4 Telemetry

Isomux itself has no telemetry. It sends no usage data to Isomux LLC or to anyone else.

The agent programs that Isomux runs have their own telemetry, which goes to their vendors.

Isomux turns off Claude Code usage metrics and error reports for each agent session, scheduled run, one-shot prompt, usage probe and sign-in client. One exception: on macOS, the Claude sign-in check runs `claude auth status` without these settings, so Claude Code's own telemetry to Anthropic can run for that one command. Isomux turns off Codex analytics and OpenCode sharing.

Model requests, sign-in, updates and operator-configured OpenTelemetry still go to their services. The data policy of each provider applies to model requests.

### 8.5 Pager

An agent can page its manager, and an app can page its owner. Isomux takes the source and the target from the token, not from the request body. A member, an API token and a scheduled run cannot raise a page. A source has at most 50 open or acknowledged pages. A title has 200 characters at most, and a body 2000.

- **Who sees a page.** A page follows the room of its source, as tasks do. The members with access to that room, and their agents, can read, acknowledge and resolve it. An app page is also open to the app owner and office owners. Thus a member or an agent in the room can acknowledge or resolve a page to another member, and that stops its Discord repeats.
- **The Discord webhook URL.** Each member can save one Discord webhook URL. Anyone who has the URL can post to that channel. Isomux keeps it in `pager-settings.json` (mode 0600), not in the managed environment, so agents do not get it in their environment. Only the member's browser session and the member's API tokens reach the settings routes. The responses show only the host and the last 4 characters of the URL. An agent with a shell can read the file (section 3.2).
- **Outbound requests.** Isomux accepts only an `https` URL on `discord.com` or `discordapp.com` with a Discord webhook path, and with no port, user, query or fragment. It does not follow redirects, and it stops a request after 10 seconds. It reads the response body only to get the wait of a 429 answer. Its log lines do not include the URL.
- **Mentions.** Each message sets `allowed_mentions` with no `parse` types. Thus `@everyone`, `@here` and role mentions in a title or body ping nobody. Only the Discord user ID saved in the member's settings, if there is one, gets a ping. The "resolved" message pings nobody.
- **What leaves the office.** The title, the body, the source name, the room name and a link to the page go to Discord. The source writes the title and the body, so they can hold text that an agent read in a file or in a webhook delivery.
- **Device notifications (Web Push).** A member turns on notifications on a device, and the browser gives Isomux an endpoint at its push service. Isomux keeps the endpoints and its own VAPID key pair in `web-push.json` (mode 0600). It makes the key pair on first use. Only the member's browser session and the member's API tokens reach the device routes, and the responses do not include an endpoint. Isomux accepts only an `https` endpoint on the push service of Chrome, Firefox, Safari or Edge, with no port or user. It does not follow redirects, and it stops a request after 10 seconds. It encrypts each message for the device (RFC 8291), so the push service cannot read it. The same text as for Discord goes out, for every page aimed at the member. When the push service answers 401, 403, 404 or 410, Isomux removes the device. When a member is deleted, Isomux removes their devices. When a member signs out, the browser removes its own device and unsubscribes before the session ends; a session revoked from another device does not reach it, so the member removes that device from the list. A member also gets the agent's name and the room name when an agent ends a turn that a person started, in a room where they ticked Push. The lobby sends none.

### 8.6 Connection tests

The Test button of the Integrations page makes the server itself send a secret. A member's browser session or API token can start a test of their own connections, and an owner's can start a test of any member's. Only an owner can test an office secret or an office MCP server. Each test writes an audit row.

- **Where the secret goes.** For a secret of the GitHub, Stripe or Fly preset, the server sends it to one fixed identity endpoint (`api.github.com/user`, `api.stripe.com/v1/account`, or Fly's GraphQL `viewer` query). For a registered MCP server, it sends the server's secret to the registered URL. The secret goes only to a host that it lists. A secret on any other host gets no test.
- **Outbound requests.** Isomux does not follow redirects. A test stops after 10 seconds, and Isomux reads at most 1 MiB of each answer. The request goes out from the server process, not through the agents' secret proxy.
- **What comes back.** The answer holds only the host, a reason code, and an account or server name. Isomux drops a name that contains the secret or a part of the URL path or query. No log line holds the URL or the secret.

### 8.7 OAuth MCP servers

For a registered MCP server that needs the MCP authorization flow, Isomux is the OAuth client. The member, or an owner for an office server or a member's server, starts the sign-in; the authorization server sends the browser back to `/api/mcp-oauth/callback` on the office's public origin.

- **Checks.** Every endpoint is `https`. The protected-resource metadata must name the registered URL, and the authorization-server metadata must name the issuer it was fetched for. The flow uses PKCE (S256) and a random state that expires after 10 minutes. Only the person who started the flow can finish it, with a browser session, and only while they still have access to the server: their own, or any as an owner. Isomux does not follow redirects, stops each step after 10 seconds, and reads at most 1 MiB of each answer.
- **Where the tokens are.** The refresh token, and a client secret if there is one, are secrets of the server's scope (`MCP_<NAME>_OAUTH` and `MCP_<NAME>_OAUTH_CLIENT`). They go only to the authorization server's token endpoint: agents get no placeholder for them, and the secret proxy does not hold them. The access token is in the server's memory only. Agents get it as the value of the server's header, through the same channels as a static credential's placeholder (never argv or the environment). A change of the server's URL, a switch away from OAuth, or a delete removes the tokens.
- **What is recorded.** A finished sign-in writes an audit row with the server's name and its scope: the office, or the member. No log line, response or audit row holds a token, a code or the state.

### 8.8 Usage notes for agents

A member can write a note for agents on a variable, a secret or an MCP server. An agent reads, through `GET /api/agent-connections`, the kind, name, hosts and note of each connection it gets: the office's and its member's, never another member's. The answer holds no value, URL path or query. The agent reference tells agents that a note never overrides a chat message or the system prompt.

---

## 9. Findings

| #   | Severity | Finding                                                                                                                                                                                                                            | Status                                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | All office processes run as one OS user. A member or agent with a shell can read the credentials of other members and change office state. Outside the container image, it can also change the server code (section 3).            | By design: a tradeoff for collaboration. Planned: a separate OS user for the server, so agents cannot read its state.     |
| 2   | Medium   | A personal API token has shell-equivalent access from any network, and can have no expiry (section 5).                                                                                                                             | Token reach by design. Owners can revoke the token of any member (section 5.3).                                           |
| 3   | Low      | `read-file` puts any readable file into the chat, with no secret check (section 6.5).                                                                                                                                              | By design: it shows a file to the members of the room, who can already read it through a terminal panel.                  |
| 4   | Low      | `preview-url` can open loopback and internal addresses (section 6.5).                                                                                                                                                              | By design.                                                                                                                |
| 5   | Low      | The members of a schedule's room can read its run transcripts, which can show the maker's secrets (section 7).                                                                                                                     | By design: they can read them through a terminal panel.                                                                   |
| 6   | Low      | A sign-in link is a bearer URL. Someone who reads it in the browser history or in the delivery channel before the recipient uses it gets the access.                                                                               | Mitigated: 24-hour or shorter life, one use, `no-referrer`.                                                               |
| 7   | Low      | A session on a shared device stays valid for up to one year (section 7).                                                                                                                                                           | Mitigated: revocation per device.                                                                                         |
| 8   | Low      | Webhook args carry text from outside the office to an agent or a schedule run that has a shell and its member's environment. A model can follow that text as instructions (section 4.7).                                           | By design: the data block marks the args as outside data, and only the args that the hook owner selects reach the target. |
| 9   | Low      | A webhook signature has no time stamp and does not cover the event header. A person who has a signed body can send it again after the 24-hour dedup window, with any event header, and Isomux can dispatch it again (section 4.7). | Accepted: GitHub signs no time stamp.                                                                                     |
| 10  | Info     | The sign-in link page shows a different message for a used link, an expired link and an unknown link. With 256-bit tokens, this does not help an attacker.                                                                         | Accepted.                                                                                                                 |
| 11  | Info     | The sign-in link page and the accept form have no rate limit (section 4.5).                                                                                                                                                        | Accepted.                                                                                                                 |
| 12  | Info     | On macOS, `claude auth status` runs without Claude Code's own telemetry opt-out (section 8.4). Isomux has no telemetry.                                                                                                            | Open.                                                                                                                     |
| 13  | Info     | The browser extension socket accepts any Chrome extension origin, which a client outside a browser can send. The real control is the pairing code (256 bits, one use, five minutes) and the paired credential (256 bits).          | Accepted.                                                                                                                 |

---

## Appendix: access internals

Operating detail of the access system that [Access and invites](access-and-invites.md) leaves out. The audit review does not cover this appendix.

### State files

In `~/.isomux/`:

- `users.json` - member profiles. Each record carries `role: "owner" | "member"`.
- `invites.json` - outstanding invites, keyed by sha256(token). Raw tokens never persist; only the hash and an 8-char display prefix.
- `sessions.json` - active sessions, keyed by sha256(session-id). Raw IDs never persist.

All three files are written atomically (temp + rename) and serialized under a single in-process mutex, so invite acceptance (which touches all three) can't race. Access pane saves go through the same mutex. Sessions persist to disk, so a restart keeps them.

`office-id` holds 12 random hex characters, made at the first start. It names this office's session cookies. It is not a secret.

### Cookie semantics

- Name: `__Host-isomux_session_<office id>`, or `isomux_session_<office id>` on `http://localhost*`, which cannot carry the `Secure` the prefix requires. The prefix is browser-enforced to be host-only, so a page on a subdomain of the office cannot write the cookie the office reads. Browsers scope cookies by host, not by port, so the office id keeps two offices on one host from reading or clearing each other's cookie. Both names are accepted, and the name the office writes is checked first, valid or not. The names `__Host-isomux_session` and `isomux_session` that every office used before are still read for one release, and an existing session moves onto the office's own name on its next page load, WebSocket connection, or read-only API request.
- Attributes: `HttpOnly; Path=/; SameSite=Lax`. `Secure` is set when the configured Public URL is `https://`, and omitted when the server is on `http://localhost*` (pre-claim, or post-claim with external access off).
- Rolling expiry: 30 days, refreshed on activity. Absolute cap: 1 year from creation.

The 1-year cap is a deliberate usability/security trade-off. The cookie attributes and a per-message server-side recheck cover the rest: a revoke from the Sessions pane disconnects an active session within about 1 second. The residual risk is the shared device where the member forgot to sign out (section 7). Revoke the sessions of devices used in untrusted environments, or sign out, rather than rely on session expiry.

### Link lifetimes

Neither link lifetime is configurable. Sign-in and device links are bearer tokens, and the shorter their acceptance window, the smaller the exposure if the URL ends up in the recipient's browser history, sync, or messaging archive. Device links use 1 hour because the legitimate flow is "both my devices are right here, click it now". The 24 hours on owner-issued links covers a realistic send-and-wait delivery. The session created on acceptance has its own, much longer lifetime.

For a device link, the server fixes the role, the target member and the lifetime from the caller's session. A tampered client cannot extend the window, change the role, or mint for a different identity; the wire-level check rejects any such attempt.

### Public origin

The Access pane saves the Public URL and the external access toggle to `~/.isomux/office-config.json`, and mints an owner sign-in link bound to the new URL. The resolved value drives:

- The Origin allowlist for WebSocket upgrades.
- The Origin allowlist for state-changing HTTP requests.
- Whether the session cookie's `Secure` attribute is set.
- The base URL for invite URLs.

The Public URL is **operator-authored configuration**. The server never infers the origin from `Host` or `X-Forwarded-Host` headers, since that's how WebSocket-hijacking bugs happen. An invalid value in `office-config.json` is logged and ignored at boot; the server degrades to the localhost fallback.

The toggle takes effect only on restart, by design: changing the reachability and cookie/origin policy mid-process is brittle, and the toggle is rare enough that "save then restart" is the right trade.

### Bootstrap-window exposure

Before an owner exists, the first-owner form is served only on `127.0.0.1`, so the OS bind rules out off-box clients regardless of LAN/VPN topology.

A same-host reverse proxy or tunnel configured **before** an owner claims forwards external traffic to `localhost:4000`. The claim needs the setup key (section 4.3) whatever the request's peer or headers, so a visitor through such a proxy cannot claim the office without the key. The claim does not check the Origin either: a page on another site cannot forge a claim without the key, so an Origin check would add no protection. Anyone who can read the server's log or its state directory before the claim can claim the office.

### Trust model boundaries

- **The owner/member split controls who expands the trust boundary**, not what members can do once inside. Owners mint invites for new identities and revoke sessions. Inside the office, every member has shell-equivalent access (section 3.2), and Isomux does not isolate members from each other at the OS level.
- **Agents run as the server's OS user.** The cookie auth doesn't constrain what an agent does once it's spawned in the office.
- **Session revocation stops future use of a session but doesn't undo past actions.** Anything the leaked session already wrote stays written.

### Wire-level notes

- **Revoking a live session.** The corresponding WebSocket force-closes within about 1 second (the per-message session recheck catches it). HTTP requests with the revoked cookie return 401 immediately.
- **A member tries to create a member or mint a link for someone else.** Rejected at the wire level. The account panes are scoped per role; the server-side check is the actual gate.
- **Scripts and the API.** `POST /api/users` creates a member (owner only); `POST /api/invites` with `{"userId": "..."}` mints their sign-in link. A privileged agent can create new office members, but not mint invite links for them. That always requires a human. The old one-step body (`username`, `label`, `role`, ...) returns 400. `POST /api/invites/recovery` is a permanent alias of `POST /api/invites`.
- **CSRF / CSWSH.** Origin is checked on WS upgrade and on state-changing HTTP methods. Browsers always send Origin; non-browser callers (agents on the same host) don't. Everything an agent calls is bearer-authenticated (each agent's injected `ISOMUX_AGENT_TOKEN`); there is no loopback bypass left.

## Appendix: files reviewed

- Authentication: `server/auth.ts`, `server/auth-middleware.ts`, `server/users.ts`, `server/identity/`
- API tokens: `server/api-tokens.ts`, `server/routes/handlers/api-tokens.ts`
- Route table and guards: `server/routes/table.ts`, `server/identity/guards.ts`, `server/isomux-office.ts`
- Agents and safety: `server/agent-manager.ts`, `server/identity/tokens.ts`, `server/safety-policy.ts`, `server/safety-hooks.ts`, `server/backends/`
- Recovery: `server/admin-socket.ts`
- Apps: `server/app-auth.ts`, `server/app-hosts.ts`, `server/app-proxy.ts`, `server/app-tokens.ts`
- Files: `server/routes/handlers/uploads.ts`, `server/mime-types.ts`
- Data: `server/user-env.ts`, `server/env-loader.ts`, `server/backup.ts`, `server/log-redaction.ts`
- Webhooks: `server/webhooks/`, `server/routes/handlers/webhooks.ts`, `server/cronjob-manager.ts`
- Pager: `server/pager-store.ts`, `server/pager-settings.ts`, `server/pager-delivery.ts`, `server/routes/handlers/pager.ts`, `server/routes/handlers/pager-settings.ts`
- Other: `server/preview-capture.ts`, `server/browser-extension-service.ts`, `server/office-usage.ts`
- Hosting: `deploy/install.sh`, `deploy/container/`, `deploy/kubernetes/`

## Appendix: sources for the webhook, pager and connection test statements

Paths are under `server/`, except those that start with `shared/`.

- Section 2 (Agent, App rows) and section 8.5 (who raises): `AGENT_CAPABILITIES` and `APP_CAPABILITIES` in `identity/index.ts`; the `pager.*` and `webhooks.*` routes in `routes/table.ts`.
- Section 3.2 and section 8.1: `createWebhookRegistry` in `webhooks/registry.ts`; `createPagerSettingsFilePersistence` in `pager-settings.ts`.
- Section 4.7, URL and id: `WEBHOOK_ID_PATTERN` and `create` in `webhooks/registry.ts`; `toWire` in `routes/handlers/webhooks.ts`.
- Section 4.7, signature: `verifyWebhookSignature` in `webhooks/verify.ts`; `createWebhookIngress` (`handle`) in `webhooks/ingress.ts`; the `/hooks/:id` branch of `buildServer` in `isomux-office.ts`.
- Section 4.7, before the signature check: `handle`, `readCapped` and `WEBHOOK_BODY_MAX_BYTES` in `webhooks/ingress.ts`.
- Section 4.7, replays, and finding 9: `claim` and `WEBHOOK_DEDUP_WINDOW_MS` in `webhooks/deliveries.ts`; `WEBHOOK_DELIVERY_LOG_MAX` in `webhooks/registry.ts`; `handle` and `dispatch` in `webhooks/ingress.ts`.
- Section 4.7, what reaches the target: `planWebhookDelivery` in `webhooks/ingress.ts`; `buildWebhookBlock` and `escapeArgsJson` in `webhooks/block.ts`; `renderArgs` in `webhooks/match.ts`; `formatWebhookSenderPrefix` in `shared/identity.ts`; the webhook branch of the run system prompt in `cronjob-manager.ts`.
- Section 4.7, prompt injection, and finding 8: as above, and `runCronjobFromWebhook` in `cronjob-manager.ts`.
- Section 4.7, targets: `webhookTargetPrecondition` in `routes/handlers/webhooks.ts`; `webhookAgentReachable` and `webhookCronjobRunnable` in `isomux-office.ts`; `cronjobOwnerOrOfficeOwner` in `identity/guards.ts`; `dispatch` in `webhooks/ingress.ts`; `runCronjobFromWebhook` in `cronjob-manager.ts`.
- Section 4.7, who sees a hook: `webhookVisibleTo` and `webhookViewerForIdentity` in `webhook-visibility.ts`; `webhookDeltaFor` in `events/webhook-delta.ts`; `webhookOwnerOrOfficeOwner` in `identity/guards.ts`; `webhooks.list` in `routes/handlers/webhooks.ts`.
- Section 4.7, the secret: the `webhooks.readSecret` and `webhooks.rotateSecret` routes in `routes/table.ts`; `userScope` in `identity/guards.ts`; `SENSITIVE_EXACT` and `SENSITIVE_PATTERNS` in `safety-policy.ts`.
- Section 5.1: `API_CAPABILITIES` in `identity/index.ts`; `selfUserOrApi`, `selfOrEnvOwner` and `webhookOwnerOrOfficeOwner` in `identity/guards.ts`; `toPagerSettingsRes` in `pager-settings.ts`.
- Section 7, integrations: `selfOrEnvOwner`, `officeEnvReader` and `officeEnvOwner` in `identity/guards.ts`; `secret:show` in `identity/index.ts`; the `secrets.*`, `officeSecrets.*`, `userEnv.*`, `officeEnv.names`, `mcpServers.*` and `officeMcpServers.list` routes in `routes/table.ts`; `memberSubject` in `routes/handlers/member-subject.ts`; `officeSecretSummary` in `routes/handlers/secrets.ts`; `officeServerSummary` in `routes/handlers/mcp-servers.ts`.
- Section 8.2: `BACKUP_EXCLUSIONS` in `backup.ts`.
- Section 8.5, raise: `pager.raise` and `pager.appRaise` in `routes/handlers/pager.ts`; `parseRaiseFields`, `PAGER_TITLE_MAX`, `PAGER_BODY_MAX` and `PAGER_MAX_ACTIVE_PER_SOURCE` in `pager-store.ts`.
- Section 8.5, who sees a page: `pagerEntryVisible` in `pager-store.ts`; `pager.ack` and `pager.resolve` in `routes/handlers/pager.ts`; `onTransitioned` in `pager-delivery.ts`.
- Section 8.5, the Discord webhook URL: `createPagerSettingsFilePersistence` and `maskWebhookUrl` in `pager-settings.ts`; `pagerSettingsHandlers` in `routes/handlers/pager-settings.ts`; the `pagerSettings.*` routes in `routes/table.ts`.
- Section 8.5, outbound requests: `parseDiscordWebhookUrl` in `pager-settings.ts`; `post`, `retryAfterMs` and `PAGER_SEND_TIMEOUT_MS` in `pager-delivery.ts`.
- Section 8.5, mentions and what leaves the office: `buildPageMessage` and `mentions` in `pager-delivery.ts`; `parsePagerSettingsPatch` in `pager-settings.ts`.
- Section 8.5, device notifications: `isPushEndpoint`, `parsePushDeviceInput` and `createWebPushFilePersistence` in `web-push-store.ts`; `sendTo`, `sendPage` and `buildPagePayload` in `web-push-delivery.ts`; `encryptPushPayload` in `web-push-crypto.ts`; `pushDevicesHandlers` in `routes/handlers/push-devices.ts`; the `pushDevices.*` routes in `routes/table.ts`.
- Section 8.6, who can test and where the secret goes: the `secrets.test`, `officeSecrets.test`, `mcpServers.test` and `officeMcpServers.test` routes in `routes/table.ts`; `IDENTITY_CHECKS` and `secretTestKind` in `connection-tests.ts`; `mcpServerSecret` in `mcp-servers.ts`.
- Section 8.6, outbound requests and what comes back: `send`, `readBody`, `cleanName` and `CONNECTION_TEST_TIMEOUT_MS` in `connection-tests.ts`.
- Section 8.7, the flow and its checks: `discover`, `send`, `startSignIn` and `finishSignIn` in `mcp-oauth.ts`; the `mcpServers.signIn`, `officeMcpServers.signIn` and `mcpOAuth.callback` routes in `routes/table.ts`.
- Section 8.7, where the tokens are: `writeOwnedSecret` in `mcp-oauth.ts`; `mcp-oauth-tokens.ts`; `mcpServerSecret` in `mcp-servers.ts`.
- Section 8.8, what an agent reads: the `agentConnections.list` route in `routes/table.ts`; `buildAgentConnections` in `agent-connections.ts`; `server/agent-reference/connections.md`.
