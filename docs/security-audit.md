---
description: Who can get access to an Isomux office, what each member, agent and API token can do after that, and the audit findings.
navTitle: Security audit
---

# Isomux security audit

**Date:** 2026-10-03, last updated 2026-11-14. This audit replaces the audit of 2026-05-17.

**Method:** Static review of the Isomux source. No live attack tests were done.

**Authors:** Claude agents in the Isomux office, under the direction of Nil Mamano, the primary author of Isomux. A second agent reviewed each statement against the source.

**Scope:** Who can get access to an office, and what each identity can do after it gets access. Out of scope: denial of service, the supply chain, and the security of the model providers.

---

## 1. Summary

Each office API request and each office WebSocket connection needs a valid credential. Each credential that Isomux mints is a 256-bit random value. The credential files keep SHA-256 hashes, not raw values. Section 4.1 tells where raw values exist. The browser surface rejects cross-site requests and cross-site WebSocket connections. Webhook deliveries (`POST /hooks/:id`) need no credential, only a valid signature (section 4.7).

Inside the office, the boundary is the operating-system user. On every hosting setup, the server, its agents, the terminal panels, the apps and the scheduled runs all run as the same OS user. Thus a member or an agent that runs a shell command can read and change everything that the server can: the office state and the credentials of other members. It can also act as any agent, also a privileged agent or an agent of another member. On an installer-managed box and on a self-hosted office, it can also change the server code. Room access and the safety hooks do not change this. Claude and OpenCode agents have no sandbox, and a Codex agent's sandbox setting limits only which files that agent's own commands can change. This is a design choice: one shared OS user lets members and agents work on the same files and with each other. Separate OS users would make that collaboration harder, and agents that talk to each other could still pass data across. A sandboxed Codex agent still has network access, so it can use the office API.

Thus, give office access only to persons you trust with a shell on the server. A personal API token gives the same access as its owner, from any network.

The [isolation model](isolation-model.md) gives the boundaries and what an admin should do, on one short page.

---

## 2. Identities

| Identity           | How it signs in                               | What it can do                                                                                                                                                                              |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner              | Browser session cookie                        | Everything a member can do. Also: create members, mint sign-in links, change room access, change office settings, revoke the sessions of any member, manage the integrations of any member. |
| Member             | Browser session cookie                        | Use the rooms the owner gives them: agents, terminal panels, tasks, files, apps, schedules. Mint their own device links and API tokens.                                                     |
| Personal API token | `Authorization: Bearer isomux_pat_…`          | The reach of the member who minted it, with some exclusions. See section 5.                                                                                                                 |
| Agent              | `ISOMUX_AGENT_TOKEN` in the agent environment | Its own chat affordances, messages to other agents, the task board, memory, logs, apps, webhooks, the schedules it made, pages to its manager, and new agents that it spawns and can kill.  |
| Privileged agent   | The same agent token, with more capabilities  | Also: kill, move and drive other agents, manage rooms and schedules, all inside the reach of the member who spawned it. See section 6.2.                                                    |
| Scheduled run      | A run token in the run environment            | Its own run affordances, messages that show the schedule as sender, and office-wide tasks plus those in its schedule's room.                                                                |
| App                | `ISOMUX_APP_TOKEN` in the app environment     | The reach of its live owner agent, without that agent's own chat affordances; writes name the app. Without a live owner agent: messages to its target and pages to its owner.               |

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

- **Members have shell access.** A member can open a terminal panel on each agent in their rooms. The terminal runs as the server's OS user. A member can also run a command of an agent's ask with one tap (Run), as the server's OS user, with that terminal's environment and the agent's folder. An agent can also run shell commands for the member.
- **Shell access is access to all office state.** The state directory (`~/.isomux`) holds the user records, the session and invite hashes, the API token hashes, the managed environment files of all members (`user-env/`, `office-env/`), the secrets of all members and the office (`secrets/`), the remote MCP servers that members and owners register (`mcp-servers/`), the webhook secrets, the Discord webhook URLs of the pager, the pager's Web Push key and device endpoints (`web-push.json`), the WhatsApp sessions of members who linked one (`whatsapp/`, each full access to that member's WhatsApp), the tokens of the Discord bots that members connect (`discord/`), and the provider sign-ins of all members (`provider-homes/`). File modes such as 0600 do not stop a process that runs as the owner of the file.
- **A process with that user can change what the server does.** It can write state that the server reads at start. After the next restart, it can have a sign-in that it made itself. On an installer-managed box and on a self-hosted office, that user also owns the server code and can change it. In the container image, root owns the code.
- **Agents do not see each other's processes, on Linux.** Each agent session runs in its own process namespace, so `ps` and `/proc` show only its own processes: it cannot read the environment of another agent or of the server, or signal their processes. A member's OpenCode agents share one namespace. A Codex agent in a sandbox mode is not wrapped, because Codex runs each command in its own sandbox; a command the member approves outside that sandbox, and Codex's MCP servers, see every process. Terminals and apps do not run in a namespace. This is not a boundary: an agent can start a process outside its namespace with `systemd-run --user`, connect to the box with ssh, or read the files of the OS user. An office owner can turn it off, and it is off on macOS and where the host does not let bubblewrap make a namespace. On Ubuntu with bubblewrap's AppArmor profile, it is off until `deploy/bwrap-apparmor.sh` has run as root (the installer runs it), because that profile would block network access for browsers such as Chrome. The script lets programs whose own AppArmor profile allows everything run under bubblewrap's profile alone inside any unprivileged bubblewrap on the box; programs with a confining profile keep it.
- **A member or an agent with a shell can act as any agent.** It can read the token of an agent, an app or a scheduled run from its environment, through a process outside its own namespace, or put code in a file that the agent runs. It then acts as that agent, also a privileged agent or an agent of another member, and its messages and audit rows name that agent, with that agent's same-manager marker. Put an agent that reads text from strangers below Standard (section 6.2a): it has no shell.
- **Room access is not a boundary against a member.** Room access controls what the office UI and API show. A shell in one room can read the files of all rooms.
- **The safety hooks are a guardrail, not a boundary.** See section 6.3.
- **If the OS user can become root, nothing in this document is a boundary.** The installer stops when its service user can log in as root or use `sudo` (see [Root access](hosting-reference.md#root-access)). On a self-hosted office, the owner's login user often has `sudo`. If it needs no password, an agent can use it.

This is a tradeoff between isolation and collaboration, not a defect with one correct fix. One shared OS user lets members and agents work on the same files and with each other.

A narrower change is planned: the server process gets its own OS user. Members and agents keep sharing one user with each other, but they can no longer read or change the server's state directory and its credentials. This change does not stop a member or an agent from acting as another agent. A separate OS user for each member would stop it across members, and it needs the server's own OS user first. A member's ordinary agent could still act as that member's privileged agent.

---

## 4. Access from outside the office

This section is about an attacker who has no credential.

### 4.1 Credentials

| Credential                                   | Format                            | Lifetime                                                      | Stored as                                                                           |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Session cookie                               | 32 random bytes                   | 30 days after last use, 1 year at most                        | SHA-256 hash in `sessions.json`                                                     |
| Sign-in link from an owner                   | 32 random bytes in the URL        | 3 days, one use                                               | SHA-256 hash in `invites.json`                                                      |
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
- **Cross-site requests.** On the office host, the server rejects a POST, PUT, PATCH or DELETE with a wrong Origin. `SameSite=Lax` also keeps the cookie off cross-site subrequests.
- **Sign-in forms.** The accept and sign-out forms need the office Origin. When the browser sends no Origin or `null`, they need `Sec-Fetch-Site: same-origin`, which page script cannot set. The first-owner form needs the setup key instead (section 4.3).
- **Headers.** Each office page has a Content Security Policy with `frame-ancestors 'none'` that loads images only from the office itself, and `X-Content-Type-Options: nosniff`. An app's page also loads the app's icon from the app's host. Pages that can have a token in the URL send `Referrer-Policy: no-referrer`. On HTTPS, the server sends HSTS for one year, without `includeSubDomains`.
- **Files that agents and members show.** Each file route sends a `sandbox` Content Security Policy. A file opened in the browser, such as HTML or SVG, runs in an opaque origin. It gets no session cookie, the office WebSocket refuses it, and it loads no image from an outside site. The file routes check room access, and they send `Cache-Control: private, no-cache`.

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

A limit that counts per client takes the client address from the rightmost `X-Forwarded-For` entry of the declared proxy, or else from the peer address. The limits:

- App sign-in: a limit for each app and client.
- The container setup form: a limit for each client.
- Webhook deliveries (`POST /hooks/:id`, which needs only a valid signature): signed deliveries start at most 10 dispatches per minute and 500 accepted dispatches per day for each hook.

Limits of this design:

- In `load-balancer` mode, a caller inside the cluster can reach the pod directly and set its own `X-Forwarded-For`. Thus it can select its rate-limit key. It cannot use an agent token, because its peer is not loopback.
- If a platform puts more than one proxy in front of the office, the limit applies to each proxy node, not to each client. This is not checked on Render.

The sign-in link page (`/i/<token>`) and the accept form have no rate limit. With 256-bit tokens, a guess attack is not possible.

### 4.6 App hosts

Each app has its own host name (`<label>.<app domain>`), which is a different origin from the office. The relay removes the office cookies before it sends a request to the app. The relay sets `X-Isomux-Member-Id` and `X-Isomux-Member-Name` to the signed-in member, and an app may authorize on the id. The relay removes every `X-Isomux-*` header that the client sent, so a client cannot forge them. Any process on the box can call an app's port directly and set these headers. So the relay also sends the app's own proxy secret in `X-Isomux-Proxy-Secret` on every request, and the app reads the same value from `ISOMUX_APP_PROXY_SECRET` in its environment. The agent reference tells apps to trust the member headers only when the two match. The safety hooks keep agents from reading the secret: the secrets file is in the secret store, and the hooks refuse writes to the units and drop-ins of the office and its apps and to the user manager's environment (section 6.3). This is the safety-hook level, not a boundary. An agent can still change code or config the app loads (its source, or toolchain config in the home directory) and restart it, attach to the app process where `ptrace_scope` is 0, change the user manager's environment over D-Bus, or drive a member's browser, which sends that member's headers through the office. The agent reference tells apps to ask for a confirmation in their own page before a public or costly action. The relay refuses a POST, PUT, PATCH or DELETE whose Origin is not the app's own, or whose `Sec-Fetch-Site` is `same-site` or `cross-site`. `SameSite=Lax` alone does not stop such a request from another host under the same parent domain. A GET is not checked. An app session lasts 12 hours at most, and the office stores only a SHA-256 hash of its cookie. A host name that has no live app gets the same answer as a live app, so an attacker cannot list app names. On the office host, a request for a short app link `/<name>` from a caller who is not signed in gets the same answer for a live name and an unknown name. A signed-in member who cannot open the app gets the same not-found page as for an unknown name. The certificate gate that the TLS terminator calls (`/__isomux/tls-ask`) does tell a live name from an unknown one, so Isomux answers it only for a request that did not come through a proxy: a request with any forwarding header (`X-Forwarded-*`, `Forwarded`, `X-Real-IP` or `Via`) gets the same refusal for every name. The installer's Caddy and the Kubernetes ingress also refuse that path at the edge. With `trustedProxy` set to `load-balancer`, a caller that reaches the office port without passing the balancer and sends no forwarding header can still ask. A `preview-url` capture of an app the agent's manager may open signs in to that one app with a single-use code; the session ends with the capture and does not open WebSockets.

Every app-host response permits framing only by the app itself and the configured office origin. Isomux replaces upstream frame-ancestors and removes X-Frame-Options; it preserves other CSP directives and report-only policies. A framed request with no live app session sends a fixed, origin-bound sign-in signal. The signal reveals no app or member data.

### 4.7 Webhooks

A webhook lets an outside service, such as GitHub, send a message to an agent or start a schedule run. Each hook has a public URL, `<office origin>/hooks/<id>`, with 64 random bits in the id.

- **The signature is the only check.** A delivery needs no session or token, and Isomux reads no forwarding header for it. Isomux computes the HMAC-SHA256 of the raw body with the hook's secret, and compares it with the signature header in constant time. A header with a wrong form fails before any decode. The route answers only on the office host, not on an app host.
- **Before the signature check**, Isomux finds the hook and checks the method. A disabled hook gets the same 404 as an unknown id.
- **Replays.** The signature covers the body only. It has no time stamp, and it does not cover the event, delivery-id and `Content-Type` headers. A body has only one reading: a JSON object, or a form body whose only field is `payload`. A copy sent with the other `Content-Type` gets 400. While the body's SHA-256 hash is in the hook's delivery log of the last 24 hours (500 rows at most), a copy of the body is a duplicate, and Isomux does not dispatch it. One exception: when the earlier delivery hit the dispatch limit or found no target, the copy is a retry with the stored event, and it can dispatch. After that window, a person who has a signed body can send it again with any event header, and Isomux can dispatch it again. The secret, the rules, the limits and the target checks still apply.
- **What reaches the target.** Isomux does not send the payload. It sends only the args that the hook's rule takes from the payload, in a data block. Isomux writes each line outside the JSON. In the JSON line, `<`, `>` and `&` are `\u` escapes and there is no newline, so a value cannot close the block. The block tells the model that the JSON comes from an outside sender and is data, not instructions. An agent message starts with `[Webhook "<name>"]`, and a hook name has only lowercase letters, digits and hyphens. The system prompt of a run that a webhook starts has the same statement.
- **Prompt injection.** The block keeps the layout. It does not stop a model from following text in a value as an instruction. The signature proves the sender, not the author of the content: a GitHub hook on a public repository carries issue and comment text from any GitHub user. The target agent runs shell commands with its manager's environment, and a schedule run uses the environment of its maker (section 7).
- **Targets.** A hook targets an agent in a room that the hook owner can access, or a schedule. To point a hook at a schedule, the caller must be able to manage that schedule: its maker, an office owner, the maker's API token or privileged agent, or the ordinary agent that made it, while the schedule is within that agent's access. Also, the hook owner must have made it or be an office owner. Isomux checks the target again on each delivery. A webhook starts a run also when the schedule is turned off, as Run now does.
- **Who sees a hook.** A hook belongs to the member who created it, also when their agent created it, and to its target's room: the room of the target agent or of the target schedule. The hook owner, office owners and the members of that room, with their agents and API tokens, see the hook, its rules and its delivery log, and can dry-run it. The delivery log shows the event names, the delivery ids, the outcomes, the matched rule, the args and the target. Only the hook owner and office owners can change or delete it. A hook whose target is gone, has no room or is in a closed room is only for its owner and office owners. A hook that the caller cannot see gets the same 403 as an unknown id. An agent needs no privileged flag for this.
- **The secret.** The answer to the create holds the secret once, for the member, agent or API token that created the hook. After that, only a browser session of the hook owner or of an office owner can read it. Such a session can also rotate it, and so can the agent that made the hook while its manager owns the hook. Every other agent, a scheduled run, an app and an API token get 403. An agent that prints the answer puts the secret in its conversation, where the members who can see that agent, history search and the model provider can read it. The agent reference tells agents to save the answer to a 0600 file and print only the id, but nothing enforces it. These rules are a guardrail, not a boundary: an agent with a shell can read `webhooks/secrets.json` (section 3.2).

---

### 4.8 WhatsApp

- **Only chosen chats.** The bridge passes on a message only from a chat on the member's list, so the text of other chats does not leave the bridge process. The member names each chat; an agent never sees a contact's own WhatsApp name.
- **What reaches the agent.** The messages arrive in a data block, built as for webhooks (section 4.7): JSON with `<`, `>` and `&` escaped, under a line that says the text is data, not instructions. The label is `[WhatsApp "<name>"]`. Prompt injection is still possible: a contact can write text that the model follows. An agent with a shell runs commands with its manager's environment, and the chat form warns the member when they pick such an agent.
- **Replies.** By default an agent cannot send a WhatsApp message. Its reply opens an ask in the member's Inbox, and the reply goes out only when the member answers Send from a browser session. The agent itself, the member's other agents, office owners, apps, scheduled runs and the member's API tokens cannot answer that ask. The agent cannot edit a draft after the member can see it. The member can turn the Send step off for one chat, only from a browser session, as for the other chat settings. Then that chat's agent sends as the member, to that chat only, at most 20 messages in 10 minutes.
- **Member packs.** Linking and the chat rows need the environment area of a member pack; a reply needs asks.

### 4.9 Discord

A member can connect their own Discord bot by its token and send a channel, a category or a whole server to an agent they manage. The member, from a browser session, or a privileged agent of theirs sees the bots and their servers, changes the routes and disconnects a bot. No API token or office owner can act for the member. An agent connects a bot only through an ask in which the member types the token, so the token never reaches the agent. An agent may make the bot in the member's browser, but the member resets the token in a tab of their own, which cancels any token that the agent's tab showed. A standard agent cannot open that ask. A privileged agent can add a route whose replies post at once as the bot.

- **The token.** Isomux checks the token with Discord, then keeps it in `discord/<user>/bots.json` (0600, a credential store left out of backups). It never goes back to a browser. Each bot has its own gateway child, with only `PATH`, `HOME`, `TZ` and `LANG` from the server's environment. Isomux removes each token, raw, URL-encoded and base64, from every text of a child, of Discord and of an error before it reaches a log. As for every file in the state directory, an agent with a shell can read the token (section 3.2).
- **Only routed places.** The gateway child sends the server every message the bot sees. The server drops a message that no live route covers, the bot's own posts, and posts by bots and webhooks unless the route lets them in.
- **What reaches the agent.** The messages arrive in a data block, built as for webhooks (section 4.7), with the label `[Discord "<name>"]`. Anyone who can post in a routed channel can write text that the model follows; on a public server that is anyone. An agent with a shell runs commands with its manager's environment, and the route form warns the member when they pick such an agent.
- **Replies.** The member picks one of three modes per route. By default a reply opens an ask, as for WhatsApp (section 4.8), and Send checks the route, the agent and the channel again before it posts. "Read and reply as the bot" posts at once, at most 20 posts per route in 10 minutes. A post goes only to a text channel or a thread that the route covers when it goes out, and it mentions nobody (`allowed_mentions` with no parse). "Read only" gives the agent no reply.
- **Member packs.** Connecting a bot and the routes need the environment area of a member pack; a reply needs asks.

## 5. Personal API tokens

### 5.1 Reach

A personal API token acts as the member who minted it. It has that member's live role and room access. It can drive agents, rooms, tasks, apps, schedules, memory and files, and read logs. It can read and replace its member's managed environment variables, and show its member's saved secrets. An owner's token can also manage the integrations of any member and show the office secrets (section 7). It can replace its member's pager settings, which hold the Discord webhook URL, but it reads only the masked URL. It can add and remove its member's notification devices. It can manage its member's webhooks. An owner's token can also create a member and give that member room access. The new member cannot sign in until a human owner mints a sign-in link. An owner's token can change the office instructions, the office name and the member usage cap, and give an agent another manager. A token can edit its member's instructions, and read those of any member who shares a room with its member; an owner's token can read and edit any member's. Memory access follows rooms in the same way. A system prompt that the token reads shows the instructions and memory of the agent's manager or the schedule's maker only under the same rule.

A token cannot:

- mint, list or revoke API tokens, including itself,
- mint sign-in links,
- list or revoke browser sessions,
- change other member record fields or room access,
- change other office settings,
- make an agent privileged,
- read a webhook secret after the answer to its create, or rotate one,
- open a terminal panel.

These exclusions do not make a boundary. A token can spawn an agent, and the agent runs shell commands as the server's OS user (section 3). Thus a token has shell-equivalent access. Treat it like a password for a shell account on the server.

A member can limit a token to some areas of the office when they mint it (none, read, or read and write for each area). Isomux checks the limits on each request, before the route's own checks, and refuses a route that has no area. A chat command needs the area of the route that does the same thing: for example, `/isomux-diff` needs files read and `/model` needs agent management write. The limits cover only the token's own calls. Write access to these areas gives the token shell-equivalent access too, and the mint form marks them: rooms, office settings and members, memory, skills, schedules, apps, webhooks, files, and environment and secrets. Each one can make an agent act with the member's reach. Without them, the token's writes to agents (agents and messages, agent management, asks) reach only agents whose access fits inside its pack: an agent at Chat, or one at Office when the token has write in agents, tasks and asks. It can spawn or revive only such an agent. To any other agent it only replies, after that agent wrote to it, and the server marks the reply `replies only`, as below. A token that can write tasks or the members chat writes text that agents read; a task it creates, or a change of its that carries text, carries `limited: true`. The Read only preset leaves out the areas that can show secrets: logs, terminals, attachments and system prompts; files; and environment values and secrets.

A token can also be limited to some rooms. It then reaches a room only while its member can access it too, never the lobby, and gets messages only from agents in its rooms. Office-wide data stays reachable by area. A room-limited token has no office-owner reach: owner-only surfaces, such as the office settings, the office secrets and the audit log, refuse it. The limit does not pass to an agent that the token spawns: that agent has its member's full room access.

A token can also be limited to replies. It can then send to, abort, or cancel a queued message of an agent only after that agent wrote to the token's inbox, and every other agent write is refused. A new token has written to no agent. The server marks the token's messages `replies only` in the sender label, defuses member-label lines in their bodies, and runs no command or prompt answer from them. The system prompt tells agents to treat such a message as data. That is an instruction rule, not a server check: the agent still acts with its manager's reach.

### 5.2 Mint and storage

Each member can mint tokens in **Integrations → API tokens**. Only a browser session can mint a token. An agent, an app or another token cannot. An agent reaches this page only in a Chrome tab that a member offered to it on the office (section 6.5).

Isomux shows the raw token one time. It stores the SHA-256 hash, the name, the dates, the limits, and a display prefix: `isomux_pat_` and the first 8 characters of the secret. The file is `api-tokens.json` (mode 0600).

### 5.3 Expiry and revocation

- The member selects 30 days, 365 days or no expiry.
- The member revokes a token in the same pane. The revocation has an effect on the next request, and it closes the token's open WebSocket.
- An owner can list and revoke the tokens of each member, on the member's profile in **Settings**. The effect is the same.
- Isomux records the last use of each token.

### 5.4 Remote inbox

An agent can send a reply to a token holder (`POST /api/api-token-inboxes/<token-id>/messages`). The token must belong to the member who manages that agent.

The token holder reads replies over HTTP (`POST /api/me/api-token-inbox/drain`) or over a WebSocket that only receives. The messages to and from a token are stored in `token-logs/<token-id>.jsonl`, with secrets masked as in agent logs (section 8.3). Entries that older versions wrote stay as plain text. Revocation does not delete the log.

---

## 6. Agents

### 6.1 Agent tokens

Isomux puts a new token in the environment of each Claude and Codex agent and each scheduled run. An OpenCode agent's token stays in the server: its commands reach the office through a socket that checks which process calls. The server keeps the token only in memory, never in a file, and it stops when the agent stops, when the run ends, or when the server restarts. Isomux takes the sender of a message from the token, not from the request body. A member or an agent with a shell can still take an agent's token, or run code as that agent, and act as it (section 3.2). An agent can use its chat affordances only on its own chat.

A terminal panel does not get an agent token.

Any agent can spawn agents in the rooms its manager can access. The new agent has the same manager and is never privileged. An agent that is not privileged, and that asks for approval or runs in a sandbox, cannot spawn an agent with more permissions than its own, or one that works outside its folder. An agent can kill the agents that it spawned, and no others.

### 6.2 Privileged agents

An owner can make any agent privileged. A member can make privileged only the agents that they spawned. No agent can set the flag.

A privileged agent gets a part of its member's capabilities: it can kill, move and drive other agents, create rooms, manage the rooms that its member can access, manage its member's schedules, and read and upload files. If its member is an owner, it can also create a member, as an owner's API token can (section 5.1), change the office instructions, the office name, the member usage cap, the **Record terminals** setting and the fallback to the office sign-in, and give any agent another manager, which puts that agent on the new manager's credentials (section 7). It cannot mint sign-in links, revoke sessions, change room access or other office settings, or open a terminal panel.

A privileged agent can add, change, remove and test its manager's variables, secrets and MCP servers, and the office's and every member's when its manager is an owner. It never reads a value: no variable values, no Show, no MCP sign-in, and the MCP server routes give it the host in place of the URL. It cannot add a host to a saved secret: it holds the secret's placeholder and could send it to a host it controls. It cannot give a secret to an app: it could read the app's environment. It cannot change a saved secret's token exchange, or move its token to or from the web address: a service can store and show a web address parameter. An ordinary agent only reads its connections and asks for a secret.

A privileged agent has the destructive reach of its member. For example, it can close a shared room. While it runs, any member or agent with a shell can act as it (section 3.2) and use that reach. Give the flag as you give your own seat. The spawn dialog starts a member's new agent at Privileged, or at the agent level of the member's permission pack: move the slider down for an agent that does not need it.

### 6.2a Agents below Standard

An agent's access is one stop on a slider: Chat, Office, Folder, Web, Standard and Privileged. The member who manages the agent, or an owner, sets it; no agent can. Below Standard the agent has no shell, so the limits of section 3.1 do not reach it: it cannot read another agent's token or the office files.

- **Office.** The agent reaches the office only through the office MCP server, with its own token. That token is limited as a limited API token is limited (section 5.1), to one fixed set: write in agents and messages, tasks and asks, no logs, in every room its manager can access. It changes only the tasks it created, and those tasks carry `limited: true`. It opens and edits only its own asks. Its messages to other agents carry the `limited` marker and never the same-manager marker. It writes only to agents whose access fits inside its own (an agent at Chat or Office), and to any other agent only as a reply, after that agent's message reached it. It spawns no agent. A scheduled message is checked again when it is delivered. One from an agent that was killed in the meantime has no token left to check: it is delivered, without the same-manager marker, so the receiver reads it as data. Its member's and the office's MCP servers and skills are off. Chat has no office access at all.
- **Tools.** Isomux gives Claude the exact built-in tools of the stop and loads no settings, CLAUDE.md, skills or plugins from disk. A hook denies every other tool, whatever lets it through. Office has no file tools; Folder adds read, write, edit and search inside the agent's folder; Web adds web search and fetch.
- **Codex.** The thread runs in an empty folder that Isomux makes for the agent, read-only, without network or approvals. Isomux turns off each Codex feature that adds a tool, and each MCP server and skill that Codex finds for the member, except the office MCP server at Office. The model keeps `request_user_input` and `apply_patch`; the read-only sandbox refuses every patch. At Office, Codex also gives the model its tool search and its MCP resource tools, which reach only the office MCP server. At Folder and Web the thread runs in the agent's folder, with a sandbox that writes only there and has no network or temporary folder. Codex has no file reading tool without its shell, so Isomux gives it `read_file`, `list_dir` and `grep_files` on its own MCP server. These run in a separate process as the agent's user, never follow a symlink, and never search a sensitive file. Isomux's safety hook gets the agent's folder, holds each patch to the Folder rules and refuses every tool that is not on the stop's list. The agent does not start when Codex would load a `.codex` folder from the agent's folder or a folder above it. Web adds Codex's web search, which has no fetch tool.
- **OpenCode.** The session runs on a second OpenCode server of the member, which loads no settings, plugins or `AGENTS.md` from the agent's folder or the folders above it. Its rules deny every tool and allow the stop's tools by name, and Isomux's plugin refuses every other call. At Chat and Office it runs in an empty folder that Isomux makes. The agent does not start when OpenCode shows settings other than Isomux's and the member's own, or an MCP server named like the office one.
- **Folder.** A read resolves symlinks and must stay inside the folder. A write may not pass through a symlink, and may not touch engine, repository or shell settings at any depth (`.claude`, `.codex`, `.opencode`, `.agents`, `.git`, `.vscode`, `.mcp.json`, `opencode.json`, `opencode.jsonc`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `.envrc`); the match ignores case. The folder may not hold the office state or sit inside it, may not be the home folder, may not hold or sit inside a Claude, Codex or OpenCode home, and may not overlap another agent's, a schedule's or an app's folder; no agent, schedule or app may later move into it. One exception: agents below Standard of one room may share that room's folder, because none loads settings, instructions, skills or MCP servers from its folder. Under a member's permission pack, a Folder or Web agent's folder is its room's folder, and one elsewhere moves to Office. No agent at any level, schedule or app works inside the office state. Attachments are copied into its `attachments` folder. At Chat and Office only images reach the agent, inline.
- **Web.** At Web the agent can send what it reads to any site. Text it fetches can carry instructions, so the stop combines the agent's office data, strangers' text and a way out. Chat shows an image from an outside site as a link, which sends nothing until a member clicks it, so chat is no way out below Web.
- **Schedules.** A schedule the agent made while at Standard does not run while it is below Standard.
- **Residuals.** Moving an agent down keeps its conversation, so what it read at a higher stop stays in its context. The hook checks only the paths that a Grep or Glob call names, so a symlink or hard link that a member puts in the folder can lead a search to files outside it. Keep links out of such a folder. Under Codex at Chat and Office, `apply_patch` reads a file before the sandbox refuses the write, so its error tells the model whether a path exists and whether a whole line is in a file. At Folder and Web the hook refuses a patch outside the folder before Codex reads the file. The member's global `AGENTS.md` loads, and a skill the member adds after the session starts loads when a message names it. Under OpenCode, the member's own OpenCode settings load: their plugins run in the server and can add or replace a tool, also one with an allowed name. Some Codex features add a tool only under a ChatGPT sign-in. Isomux turns them off by name, but no test sees them run; the checked Codex version limits this, because a Codex update closes every stop below Standard until a new check.

### 6.3 Safety hooks

Isomux checks each recognized tool call of Claude, Codex and OpenCode agents before it runs. No setting turns the check off. The check blocks:

- destructive git commands, such as `git reset --hard`, `git push --force` and `git clean -f`,
- `rm -rf` outside `/tmp` and `/var/tmp`, or through a symbolic link there,
- writes into the state directory,
- reads of files that usually hold secrets, such as `.env`, private keys, backend sign-in files, OpenCode's databases, and the secrets, managed environment files and app token files (`apps/units/*.env`) in the state directory,
- recursive searches (`grep -r`, `rg`, the Grep tool) rooted at the secret store or above it, unless they exclude `secrets/`. This rule does not cover the managed environment files, the MCP servers or the app token files,
- writes of a systemd user unit or drop-in that applies to the office's unit or an app's unit, in any directory systemd reads them from, writes of the user manager's environment (`systemd/user.conf`, `user.conf.d/`, `environment.d/`), `systemctl set-environment` and `import-environment`, and `systemctl edit` and `set-property` on those units,
- recognized process-kill commands, such as `pkill`, `killall` and kills of processes found by name,
- reads of another process's environment (`/proc/<pid>/environ`, `ps e`), and recursive searches of `/proc` or `/`,
- recognized commands that open outbound tunnels,
- recognized uses of the owner recovery socket.

The check reads each command of a shell line, also the commands inside `bash -c`, `eval`, `find -exec` and command substitutions. One blocked command blocks the line.

The safety hooks are a guardrail against mistakes by honest agents. They are not a security boundary:

- They recognize known command forms. A script, a renamed program, an interpreter or a variable set in an earlier command can do the same thing.
- They see only the tools that they map. For example, an MCP server with file access goes around them.
- For Codex and OpenCode, if the checker cannot run, the call runs. Isomux then shows a warning in the chat.
- Reads in the state directory are allowed, because agents need logs and discovery.

### 6.4 Owner recovery

An operator who loses the last owner session can mint a 15-minute owner sign-in link through a Unix socket (`admin.sock`). By default the socket is in the state directory. On Kubernetes, it is on a volume that the office and a recovery container share. The socket reads the OS user of the caller from the kernel. It answers only root. On Kubernetes, it also answers a separate recovery container that runs as a different user. It always refuses the server's own OS user, so an agent cannot mint a sign-in link through it.

This closes the one-call route. It does not close the class in section 3.2: a process with the server's OS user can still change state that the server reads at start.

### 6.5 Agent affordances that reach outside the chat

- **Show a file** (`read-file`) copies any file that the server's OS user can read into the chat. It does not check for secrets. The members of the room can then open the file. The agent does not read the content, so this is also a way to give a member a secret without passing it through the model.
- **Preview a page** (`preview-url`) opens any HTTP or HTTPS URL in a browser on the server. This includes loopback and internal addresses. The only control is the agent system prompt.
- **Read a terminal** (`GET /api/agents/:id/terminal`) returns the output of the agent's own terminal, or of the terminal of an agent in a room that its manager can access. Secrets in it are masked as in logs (section 8.3). The server keeps only the last 100,000 characters of each open terminal, in memory.
- **Browser control** acts only on a tab that a member offers in their paired Chrome extension, to the agents they choose for that browser: My agents (every agent they manage), My agents and members I pick (also the agents of the members they pick, in a room they can access) or All agents (every agent in a room they can access, also the agents of other members). The same choice decides which agents may open their own tabs there. The tab is signed in as that member, so the offer is their consent: the agent acts as the member on that tab's sites. In a tab offered on the office, the agent can use the office as the member, also the pages that agent tokens cannot reach: API tokens, secrets and sign-in links. If an office owner offers an office tab to All agents or to picked members, those agents, also the agents of other members, can use the office as the owner.
  - Browser control refuses an office page that the member did not offer. Each office response carries the `X-Isomux-Office` header. The server learns office origins from it, and it refuses every command on a page that loads from an office origin other than the offered one. A `goto` to a known office is refused before Chrome sends a request. One office request passes: an app host's sign-in hop to the office's `/auth/app`, which gives the app only its own cookie. A page that `/auth/app` answers with, such as the office login, is refused.
  - The load of such a page still happens. It is a top-level GET, which any site that the member visits can also start, because the session cookie is `SameSite=Lax`.
  - A command that is already on its way when Chrome shows the office page can still reach it, within one round trip and before the office page can show a control.
  - The server always knows its own public address as an office. Another office of an older version, which does not send the header, is not found.

### 6.6 The secret proxy

An agent, terminal or scheduled run with a secret in scope gets a placeholder in place of each value, and the proxy and trust variables (`HTTPS_PROXY`, `SSL_CERT_FILE` and similar). A child process of the server, on a loopback port, puts the value into requests to the hosts that the secret lists, only in the header that the secret names. For those hosts it ends TLS with a certificate from the office CA, which agents with a secret trust. Every other host, and the model and package registry hosts on the fixed never-list, pass as plain tunnels. The proxy removes the value from responses as a backstop; a host that returns it in another encoding (hex, for example) defeats that. Each use of a secret is an audit entry. The proxy refuses a client without the office's proxy password, which agents get in `HTTPS_PROXY`, so another OS user on the box cannot use it. On Linux, a client that runs as the office's own OS user needs no password, so headless Chrome works. A browser without the password reaches a secret's host through a plain tunnel and gets no secret. A port forward or relay that the office's OS user runs on the box lets whoever reaches it use the proxy without the password. A placeholder is a bearer credential inside the office: any process on the box that has it can use the secret for its listed hosts. A member can reissue a placeholder: the old one stops working at once, and the agents in scope get the new one at their next start.

A secret with a token exchange holds an app or client secret. The proxy sends it, with the app id, to the token address (one of the secret's hosts), never follows a redirect there, and keeps the short-lived token it gets in memory. The token goes in the header the secret names or, with the query form, in one parameter of the web address. A token in the web address lands in that service's request logs. The scrub removes live tokens as it removes values. An MCP server cannot use such a secret.

An agent can ask for a secret (`POST /api/agents/:id/secret-requests`). The request waits as an ask (`~/.isomux/asks.json`, which holds the request and never a value); the value goes from the member's browser to the store, never into the transcript. A reply, dismiss or filed task on that ask is refused, so a value typed there cannot reach the chat. Only the member it names (by default the manager) can save it, and only into secrets they own, or as an office owner. With an app, the value goes to that app's environment and the agent gets no placeholder. The same request can ask for a variable or an MCP server; the value or URL takes the same path, into the variables or the MCP servers.

A member can give a personal secret to the apps they own, and an owner can give an office secret to any app. The app gets the value in its environment, from a file in `secrets/apps/` (mode 0600). A secret with no host gives agents no placeholder. The app's process holds the value, so an agent that reads that process's environment can read it (section 3.2), and an office owner can change a member's app command to print a member's secret. The app logs route removes every secret value, as a backstop.

---

## 7. Members inside the office

Section 3.2 applies first: a member with a terminal panel or an agent has shell access. The items below describe the office API.

- **Rooms.** A member sees only the agents, files and tasks of their rooms, plus the lobby and office-wide tasks. A chat command that lists agents or schedules of other rooms (`/isomux-all-hands`, `/isomux-cronjob-system-prompt`) shows only those that the sender and every member of the chat's room may see. Any member can create a room. A member with access to a room can rename it or close it.
- **Files.** Upload and file routes check room access. A denial gets the same 404 as a missing file. The files of a stopped agent follow its last room. When that room is gone, only owners can read them.
- **Schedules.** A schedule has an owner: the member who made it, or whose agent made it, until it passes to another member. It belongs to a room, or to no room. The members of its room see the schedule, its runs and their transcripts. A run uses the environment of the schedule's owner, so a transcript can show their secrets. Only the schedule's owner, office owners and the agent that made it can change, delete or run it. A schedule with no room, or whose room was closed, is visible only to its owner and office owners.
- **Integrations.** An owner manages the variables, secrets and MCP servers of every member, but never reads the value of a member's variable or secret: an owner sets or removes one variable at a time, and replaces or removes a secret. A member reads the names, hosts and notes of the office's variables, secrets and MCP servers, never a value, an MCP server's URL path or the name of its credential. Show returns a saved secret's value to the member who owns it, or an office secret's value to an owner. No agent token, privileged or not, can call Show, and each Show writes an audit row with the secret's name. A privileged agent changes integrations with its manager's reach (section 6.2); the audit row names the agent. An agent with a shell can still read the secret files (section 3.2). An owner's browser session can also sign a member in to or out of the member's own Claude and Codex accounts; no API token or agent can. An audit row of an owner's change to a member's integration names that member. Removing a member deletes their variables, secrets and MCP servers.
- **Agent managers.** An office owner, a privileged agent whose manager is an office owner, or an owner's API token can give an agent another manager. The agent then runs on that member's credentials. A member cannot give an agent away. The agent gets a new token with the same privilege, its conversation restarts under the new manager, and the apps, schedules and webhooks it made move to the new manager. Each webhook that moves gets a new secret, because the old manager could read it. A resumed session from before the change still uses the old manager's Claude connection, and the chat says so. Removing a member passes their agents, schedules and webhooks to the oldest office owner. Their schedules pass turned off, because a schedule would run the member's prompt with the heir's environment and secrets: the heir reads each schedule and turns it back on. Their webhooks pass turned off, with a new secret, because the member could read each secret.
- **Permission packs.** A member with a pack is capped to its areas (section 5.1) on every identity of theirs, read live: session, API tokens, agents, schedule runs and apps. Their agents sit at or below the pack's agent level. They create no rooms and set no folders, so their Folder and Web agents reach only their room's folder, which an owner sets. A save moves them down; an agent whose engine cannot run there blocks the save and does not start. Office socket pushes reach them only for the pack's areas, and never the terminal stream. They get no terminal, and they message and open the files of only agents that fit inside the pack. Their schedules need a target agent, and their apps run only with apps write. Logs read still shows an agent's terminal screen. The pack is a boundary only for a member who never had an agent at Standard or Privileged (section 3.2).
- **Shared devices.** A session cookie lasts up to one year. A member who does not sign out on a shared computer leaves access open. Revoke it in Settings → You → Sign-in links, or an owner revokes it in Settings → Housekeeping → Sessions: an open tab closes in about one second.

---

## 8. Data at rest and outbound data

### 8.1 State files

All office state is in the state directory: `~/.isomux` of the server's OS user, or `/var/data/home/.isomux` in the container. The server sets the state directory to mode 0700 at each start, which closes it to other OS users on the box. The credential files (`api-tokens.json`, `token-logs/`, `user-env/`, `office-env/`, `secrets/`, `mcp-servers/`, `apps/app-tokens.json`, `webhooks/secrets.json`, `pager-settings.json`, `whatsapp/`, `provider-homes/`, each OpenCode profile `opencode/profiles/<key>/`) have mode 0600 or 0700. The managed environment files and the secrets hold their values as plain text. `secrets/` also holds the placeholder key and the office CA key. A registered MCP server's header holds its secret's placeholder, never the value, so the config file of each OpenCode profile (`opencode/profiles/<key>/opencode.json`, mode 0600) holds no value. The database of each OpenCode profile (`opencode/profiles/<key>/data/opencode/opencode-v2.db`) holds its provider sign-ins. [Data retention and deletion](data-retention.md) lists the other stores and what each delete keeps.

### 8.2 Backups

Backups do not include the managed environment files, the secrets, the registered MCP servers, the OpenCode profile configs, the app environment files, the container app tokens, the webhook secrets, the pager's Discord webhook URLs, the pager's Web Push key and devices, the WhatsApp sessions, the Discord bot tokens, the TLS key, the OpenCode server records or the backend sign-in files. They include the OpenCode databases, with their conversations and provider sign-ins, `api-tokens.json` (hashes only), the token logs, and the agent logs. Logs can hold sensitive text that a member typed or that a tool printed.

### 8.3 Secret redaction in logs

Before Isomux stores a new agent, scheduled-run or token log entry, it masks values that look like provider keys or `API_KEY=…` assignments. It keeps the first 8 characters. It also masks the value of every secret of 8 characters or more, whatever its shape, raw, URL-encoded and base64. The app logs route removes the same values from each line it returns. A new secret value must have at least 8 characters. This is a backstop: it can miss secrets. If the scan fails, Isomux stores the original entry. Attachments and backend transcripts are not scanned. Live terminal output is not stored; the terminal read (section 6.5) masks it on each read. The output of an ask's Run is masked before the ask stores its last 4,000 characters. Terminal recordings are masked too (section 8.10).

### 8.4 Telemetry

Isomux itself has no telemetry. It sends no usage data to Isomux LLC or to anyone else. The one exception is an office whose owner turns on the Enterprise Contract box: it sends its member count to the seat service (section 8.12).

The agent programs that Isomux runs have their own telemetry, which goes to their vendors.

Isomux turns off Claude Code usage metrics and error reports for each agent session, scheduled run, one-shot prompt, usage probe and sign-in client. One exception: on macOS, the Claude sign-in check runs `claude auth status` without these settings, so Claude Code's own telemetry to Anthropic can run for that one command. Isomux turns off Codex analytics and OpenCode sharing.

Model requests, sign-in, updates and operator-configured OpenTelemetry still go to their services. The data policy of each provider applies to model requests.

### 8.5 Pager

An agent can page its manager, and an app can page its owner. Isomux takes the source and the target from the token, not from the request body. A member, an API token and a scheduled run cannot raise a page.

- **Who sees a page.** A page follows the room of its source, as tasks do. The members with access to that room, and their agents, can read, acknowledge and resolve it. An app page is also open to the app owner and office owners. Thus a member or an agent in the room can acknowledge or resolve a page to another member, and that stops its Discord repeats.
- **The Discord webhook URL.** Each member can save one Discord webhook URL. Anyone who has the URL can post to that channel. Isomux keeps it in `pager-settings.json` (mode 0600), not in the managed environment, so agents do not get it in their environment. The settings routes take the gate of the member's secrets: the member, or an office owner for any member, by browser session, API token or privileged agent. The responses show only the host and the last 4 characters of the URL. An agent with a shell can read the file (section 3.2).
- **Outbound requests.** Isomux accepts only an `https` URL on `discord.com` or `discordapp.com` with a Discord webhook path, and with no port, user, query or fragment. It does not follow redirects. Its log lines do not include the URL.
- **Mentions.** Each message sets `allowed_mentions` with no `parse` types. Thus `@everyone`, `@here` and role mentions in a title or body ping nobody. Only the Discord user ID saved in the member's settings, if there is one, gets a ping. The "resolved" message pings nobody.
- **What leaves the office.** The title, the body, the source name, the room name and a link to the page go to Discord. The source writes the title and the body, so they can hold text that an agent read in a file or in a webhook delivery.
- **Device notifications (Web Push).** A member turns on notifications on a device, and the browser gives Isomux an endpoint at its push service. Isomux keeps the endpoints and its own VAPID key pair in `web-push.json` (mode 0600). Only the member's browser session and the member's API tokens reach the device routes, and the responses do not include an endpoint. Isomux accepts only an `https` endpoint on the push service of Chrome, Firefox, Safari or Edge, with no port or user. It does not follow redirects. It encrypts each message for the device (RFC 8291), so the push service cannot read it. The same text as for Discord goes out, for every page aimed at the member. When a member is deleted, Isomux removes their devices. When a member signs out, the browser removes its own device and unsubscribes before the session ends; a session revoked from another device does not reach it, so the member removes that device from the list. A member also gets the agent's name and the room name when an agent ends a turn that a person started, in a room where they ticked Push. The lobby sends none.

### 8.6 Connection tests

The Test button of the Integrations page makes the server itself send a secret. A member's browser session or API token can start a test of their own connections, and an owner's can start a test of any member's. Only an owner can test an office secret or an office MCP server. Each test writes an audit row.

- **Where the secret goes.** For a secret of the GitHub, Stripe or Fly preset, the server sends it to one fixed identity endpoint (`api.github.com/user`, `api.stripe.com/v1/account`, or Fly's GraphQL `viewer` query). For a registered MCP server, it sends the server's secret to the registered URL. The secret goes only to a host that it lists. A secret on any other host gets no test.
- **Outbound requests.** Isomux does not follow redirects. The request goes out from the server process, not through the agents' secret proxy.
- **What comes back.** The answer holds only the host, a reason code, and an account or server name. Isomux drops a name that contains the secret or a part of the URL path or query. No log line holds the URL or the secret.

### 8.7 OAuth MCP servers

For a registered MCP server that needs the MCP authorization flow, Isomux is the OAuth client. The member, or an owner for an office server or a member's server, starts the sign-in; the authorization server sends the browser back to `/api/mcp-oauth/callback` on the office's public origin.

- **Checks.** Every endpoint is `https`. The protected-resource metadata must name the registered URL, and the authorization-server metadata must name the issuer it was fetched for. The flow uses PKCE (S256) and a random state that expires after 10 minutes. Only the person who started the flow can finish it, with a browser session, and only while they still have access to the server: their own, or any as an owner. Isomux does not follow redirects.
- **Where the tokens are.** The refresh token, and a client secret if there is one, are secrets of the server's scope (`MCP_<NAME>_OAUTH` and `MCP_<NAME>_OAUTH_CLIENT`). They go only to the authorization server's token endpoint: agents get no placeholder for them, and the secret proxy does not hold them. The access token is in the server's memory only. Agents get it as the value of the server's header, through the same channels as a static credential's placeholder (never argv or the environment). A change of the server's URL, a switch away from OAuth, or a delete removes the tokens.
- **What is recorded.** A finished sign-in writes an audit row with the server's name and its scope: the office, or the member. No log line, response or audit row holds a token, a code or the state.

### 8.8 Usage notes for agents

A member can write a note for agents on a variable, a secret or an MCP server. An agent reads, through `GET /api/agent-connections`, the kind, name, hosts and note of each connection it gets: the office's and its member's, never another member's. The answer holds no value, URL path or query. The agent reference tells agents that a note never overrides a chat message or the system prompt.

### 8.9 Speech

Each member picks what voice input and read aloud use, in Integrations > Voice: the browser (the default) or OpenAI.

With the browser, the member's browser sends the audio and the text to its speech services directly; the office server does not take part.

- **Voice input.** Isomux does not ask the browser to recognize speech on the device. Thus the browser can send the audio to its vendor's speech service. Chrome sends it to Google.
- **Read aloud.** Isomux prefers a voice whose name contains "Google". In desktop Chrome, these voices are remote: Chrome sends the reply text to Google, which makes the audio.

With OpenAI, the browser sends the recording or the reply text to the office server, and the office server sends it to OpenAI with the key in `OPENAI_VOICE_API_KEY` (or `OPENAI_API_KEY` when only that one is set), from the member's variables or else the office's. A recording also carries the names of the office's agents, as words to expect. The key does not leave the server, and the server keeps no recording, text or audio. Agents and API tokens can call the same routes; each call spends the key of the member they act for. If OpenAI fails, the mic and read aloud say so; neither falls back to the browser without a word.

No office setting turns these features off.

### 8.10 Terminal recordings

The office setting **Record terminals** is off by default. When an owner turns it on, each terminal session started after that is saved to one file under `terminal-recordings/` in the state directory (mode 0600): the output, the resizes, and a mark with the member's name when a member starts typing. The server takes that name from the member's session. Keystrokes and their count are never saved. A terminal echoes what members type, so the commands are in the output. A password prompt that echoes nothing leaves nothing of the password. An ask's Run is not a terminal session and is not recorded; the ask history keeps the command and the answer.

- **Who reads them.** The audit log's readers: owners, their API tokens, and privileged agents whose manager is an owner. Each change of the setting is its own audit entry.
- **Notice.** A recorded terminal tells every member who opens it. A change of the setting applies from the next terminal start.
- **Redaction.** Before writing, Isomux masks the output as it masks logs (section 8.3), with the secrets stored at that moment. These are not caught: a secret split by escape sequences (colour, cursor movement), a secret printed in another encoding, and a password that a program echoes as one `*` per character, which shows its length. Anything else a member shows on screen, such as `cat .env`, is in the recording.
- **Timing.** A mark starts when a member types after a pause of 2 seconds with new output in between, so a prompt that echoes nothing gives one mark at any typing speed.
- **Replay.** The replay terminal takes no input, ignores clipboard writes and opens no links. The route serves the file as a download.

### 8.11 Lobby floors

The lobby elevator links to other Isomux offices. Each office answers a public card at `/.well-known/isomux-office` with its name only, which its sign-in page title already shows. To add a floor, a member, a privileged agent or an API token gives an address, and the server reads the card there.

- **Outbound requests.** One `GET` of that fixed path, with no cookie or credential. Isomux does not follow redirects. Only the name comes back. An office from before the card, whose sign-in wall answers instead, gets its own answer; every other failure gets the same one.
- **Reach.** The request goes out from the server process, so it reaches addresses on the office's own network. The caller learns which of three answers one fixed path gives at that address: a card, an older office's sign-in wall, or neither.
- **What is stored.** The address (its origin only) and the name, in `floors.json`. No token or secret goes to the other office.
- **The panel a member carries.** Each ride from the elevator carries the member's panel in the address fragment, which the browser never sends to a server: the addresses of the offices that browser rode through and of their floors, with no name. The office keeps it in that browser's local storage and checks every address in it. It shows no name that a ride carried: a signed-in member or a privileged agent asks the office server for the name at an address (`GET /api/floors/name`), and the server reads the card as above. The server keeps each answer for an hour, for all callers. So every office a member rides to learns every address on the member's panel. A crafted link can add addresses to the panel in that browser, or hide entries that only the panel holds, never the office's own floors.

### 8.12 Enterprise seats

An office whose owner checks "This office is part of an Enterprise Contract" in Settings -> Office -> Enterprise and pastes the company's enterprise secret asks the seat service at `cloud.isomux.com` for a seat before each member add.

- **What leaves the office.** A random office id (32 hex characters, made once per office) and the office's member count. No names, emails, agents or content. The secret goes in the `Authorization` header.
- **Outbound requests.** Isomux does not follow redirects.
- **Where the secret is.** In `secrets/enterprise-seats.key` (mode 0600) under the state root. No route returns it, and no log line or audit row holds it. Turning the box off deletes it. An agent with a shell can read the file (section 3.2).

---

## 9. Findings

| #   | Severity | Finding                                                                                                                                                                                                                            | Status                                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | All office processes run as one OS user. A member or agent with a shell can read the credentials of other members and change office state. Outside the container image, it can also change the server code (section 3).            | By design: a tradeoff for collaboration. Planned: a separate OS user for the server, so agents cannot read its state.     |
| 2   | High     | A member or an agent with a shell can act as any agent, also a privileged agent or an agent of another member. Messages and audit rows then name that agent (sections 3.2 and 6.1).                                                | By design: one OS user. Put an agent that reads text from strangers below Standard (section 6.2a): it has no shell.       |
| 3   | Medium   | A personal API token has shell-equivalent access from any network, and can have no expiry (section 5).                                                                                                                             | Token reach by design. Owners can revoke the token of any member (section 5.3).                                           |
| 4   | Low      | An agent in a Chrome tab that a member offered to it on the office acts with that member's browser session, also on the pages that agent tokens cannot reach (section 6.5).                                                        | By design: the offer is the member's consent. Other office pages are refused.                                             |
| 5   | Low      | `read-file` puts any readable file into the chat, with no secret check (section 6.5).                                                                                                                                              | By design: it shows a file to the members of the room, who can already read it through a terminal panel.                  |
| 6   | Low      | `preview-url` can open loopback and internal addresses (section 6.5).                                                                                                                                                              | By design.                                                                                                                |
| 7   | Low      | The members of a schedule's room can read its run transcripts, which can show the maker's secrets (section 7).                                                                                                                     | By design: they can read them through a terminal panel.                                                                   |
| 8   | Low      | A sign-in link is a bearer URL. Someone who reads it in the browser history or in the delivery channel before the recipient uses it gets the access.                                                                               | Mitigated: 3-day or shorter life, one use, `no-referrer`.                                                                 |
| 9   | Low      | A session on a shared device stays valid for up to one year (section 7).                                                                                                                                                           | Mitigated: revocation per device.                                                                                         |
| 10  | Low      | Webhook args carry text from outside the office to an agent or a schedule run that has a shell and its member's environment. A model can follow that text as instructions (section 4.7).                                           | By design: the data block marks the args as outside data, and only the args that the hook owner selects reach the target. |
| 11  | Low      | A webhook signature has no time stamp and does not cover the event header. A person who has a signed body can send it again after the 24-hour dedup window, with any event header, and Isomux can dispatch it again (section 4.7). | Accepted: GitHub signs no time stamp.                                                                                     |
| 12  | Info     | The sign-in link page shows a different message for a used link, an expired link and an unknown link. With 256-bit tokens, this does not help an attacker.                                                                         | Accepted.                                                                                                                 |
| 13  | Info     | The sign-in link page and the accept form have no rate limit (section 4.5).                                                                                                                                                        | Accepted.                                                                                                                 |
| 14  | Info     | On macOS, `claude auth status` runs without Claude Code's own telemetry opt-out (section 8.4). Isomux has no telemetry.                                                                                                            | Open.                                                                                                                     |
| 15  | Info     | The browser extension socket accepts any Chrome extension origin, which a client outside a browser can send. The real control is the pairing code (256 bits, one use, five minutes) and the paired credential (256 bits).          | Accepted.                                                                                                                 |
| 16  | Info     | Voice input and read aloud send the audio or the reply text to the browser vendor, or, when the member picks OpenAI, to OpenAI through the office server. No office setting turns them off (section 8.9).                          | Open.                                                                                                                     |

---

## Appendix: access internals

Operating detail of the access system that [Access and invites](access-and-invites.md) leaves out. The audit review does not cover this appendix.

### State files

In `~/.isomux/`:

- `users.json` - member profiles. Each record carries `role: "owner" | "member"`.
- `invites.json` - outstanding invites, keyed by sha256(token). Raw tokens never persist; only the hash and an 8-char display prefix.
- `sessions.json` - active sessions, keyed by sha256(session-id). Raw IDs never persist.

All three files are written atomically (temp + rename) and serialized under a single in-process mutex, so invite acceptance (which touches all three) can't race.

`office-id` holds 12 random hex characters, made at the first start. It names this office's session cookies. It is not a secret.

### Cookie semantics

- Name: `__Host-isomux_session_<office id>`, or `isomux_session_<office id>` on `http://localhost*`, which cannot carry the `Secure` the prefix requires. The prefix is browser-enforced to be host-only, so a page on a subdomain of the office cannot write the cookie the office reads. Browsers scope cookies by host, not by port, so the office id keeps two offices on one host from reading or clearing each other's cookie. On HTTPS only the `__Host-` name is read, so a cookie a subdomain writes under the plain name is ignored. On `http://localhost*` both names are read, and the name the office writes is checked first, valid or not. When none of these is present, the names every office used before, `__Host-isomux_session` and (on `http://localhost*` only) `isomux_session`, are read, and accepted only when they carry a live session of this office, which then moves onto the office's own name. The office never writes or clears them.
- Attributes: `HttpOnly; Path=/; SameSite=Lax`. `Secure` is set when the configured Public URL is `https://`, and omitted when the server is on `http://localhost*` (pre-claim, or post-claim with external access off).
- Rolling expiry: 30 days, refreshed on activity. Absolute cap: 1 year from creation.

The 1-year cap is a deliberate usability/security trade-off. The cookie attributes and a per-message server-side recheck cover the rest: a revoke from the Sessions pane disconnects an active session within about 1 second. The residual risk is the shared device where the member forgot to sign out (section 7). Revoke the sessions of devices used in untrusted environments, or sign out, rather than rely on session expiry.

### Link lifetimes

Neither link lifetime is configurable. Sign-in and device links are bearer tokens, and the shorter their acceptance window, the smaller the exposure if the URL ends up in the recipient's browser history, sync, or messaging archive. Device links use 1 hour because the legitimate flow is "both my devices are right here, click it now". Owner-issued links use 3 days because the recipient often opens the link a day or two after the owner sends it. The session created on acceptance has its own, much longer lifetime.

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
- **Scripts and the API.** `POST /api/users` creates a member (owner only); `POST /api/invites` with `{"userId": "..."}` mints their sign-in link. A privileged agent can create new office members, but not mint invite links for them. That always requires a human.
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

## Appendix: sources for the webhook, pager, connection test, floor and enterprise seat statements

Paths are under `server/`, except those that start with `shared/`.

- Section 2 (Agent, App rows) and section 8.5 (who raises): `AGENT_CAPABILITIES` and `APP_CAPABILITIES` in `identity/index.ts`; the `pager.*` and `webhooks.*` routes in `routes/table.ts`.
- Section 3.2 and section 8.1: `createWebhookRegistry` in `webhooks/registry.ts`; `createPagerSettingsFilePersistence` in `pager-settings.ts`.
- Section 4.7, URL and id: `WEBHOOK_ID_PATTERN` and `create` in `webhooks/registry.ts`; `toWire` in `routes/handlers/webhooks.ts`.
- Section 4.7, signature: `verifyWebhookSignature` in `webhooks/verify.ts`; `createWebhookIngress` (`handle`) in `webhooks/ingress.ts`; the `/hooks/:id` branch of `buildServer` in `office-front-door.ts`.
- Section 4.7, before the signature check: `handle` in `webhooks/ingress.ts`.
- Section 4.7, replays, and finding 11: `claim` and `WEBHOOK_DEDUP_WINDOW_MS` in `webhooks/deliveries.ts`; `WEBHOOK_DELIVERY_LOG_MAX` in `webhooks/registry.ts`; `handle`, `dispatch` and `parsePayload` in `webhooks/ingress.ts`.
- Section 4.7, what reaches the target: `planWebhookDelivery` in `webhooks/ingress.ts`; `buildWebhookBlock` and `escapeArgsJson` in `webhooks/block.ts`; `renderArgs` in `webhooks/match.ts`; `formatWebhookSenderPrefix` in `shared/identity.ts`; the webhook branch of the run system prompt in `cronjob-manager.ts`.
- Section 4.7, prompt injection, and finding 10: as above, and `runCronjobFromWebhook` in `cronjob-manager.ts`.
- Section 4.7, targets: `webhookTargetPrecondition` in `routes/handlers/webhooks.ts`; `webhookAgentReachable` and `webhookCronjobRunnable` in `isomux-office.ts`; `cronjobOwnerOrOfficeOwner` in `identity/guards.ts`; `dispatch` in `webhooks/ingress.ts`; `runCronjobFromWebhook` in `cronjob-manager.ts`.
- Section 4.7, who sees a hook: `webhookVisibleTo` and `webhookViewerForIdentity` in `webhook-visibility.ts`; `webhookDeltaFor` in `events/webhook-delta.ts`; `webhookOwnerOrOfficeOwner` in `identity/guards.ts`; `webhooks.list` in `routes/handlers/webhooks.ts`.
- Section 4.7, the secret: the `webhooks.create`, `webhooks.readSecret` and `webhooks.rotateSecret` routes in `routes/table.ts` and `routes/handlers/webhooks.ts`; `userScope` and `webhookMakerAgent` in `identity/guards.ts`; `transferAgentManager` in `isomux-office.ts`; `SENSITIVE_EXACT` and `SENSITIVE_PATTERNS` in `safety-policy.ts`.
- Section 5.1: `API_CAPABILITIES` in `identity/index.ts`; `selfUserOrApi`, `selfOrEnvOwner` and `webhookOwnerOrOfficeOwner` in `identity/guards.ts`; `toPagerSettingsRes` in `pager-settings.ts`.
- Section 7, integrations: `selfOrEnvOwner`, `officeEnvReader` and `officeEnvOwner` in `identity/guards.ts`; `secret:show` in `identity/index.ts`; the `secrets.*`, `officeSecrets.*`, `userEnv.*`, `officeEnv.names`, `mcpServers.*` and `officeMcpServers.list` routes in `routes/table.ts`; `memberSubject` in `routes/handlers/member-subject.ts`; `officeSecretSummary` in `routes/handlers/secrets.ts`; `officeServerSummary` in `routes/handlers/mcp-servers.ts`.
- Section 8.2: `BACKUP_EXCLUSIONS` in `backup.ts`.
- Section 8.5, raise: `pager.raise` and `pager.appRaise` in `routes/handlers/pager.ts`; `parseRaiseFields` in `pager-store.ts`.
- Section 8.5, who sees a page: `pagerEntryVisible` in `pager-store.ts`; `pager.ack` and `pager.resolve` in `routes/handlers/pager.ts`; `onTransitioned` in `pager-delivery.ts`.
- Section 8.5, the Discord webhook URL: `createPagerSettingsFilePersistence` and `maskWebhookUrl` in `pager-settings.ts`; `pagerSettingsHandlers` in `routes/handlers/pager-settings.ts`; the `pagerSettings.*` routes in `routes/table.ts`.
- Section 8.5, outbound requests: `parseDiscordWebhookUrl` in `pager-settings.ts`; `post` in `pager-delivery.ts`.
- Section 8.5, mentions and what leaves the office: `buildPageMessage` and `mentions` in `pager-delivery.ts`; `parsePagerSettingsPatch` in `pager-settings.ts`.
- Section 8.5, device notifications: `isPushEndpoint`, `parsePushDeviceInput` and `createWebPushFilePersistence` in `web-push-store.ts`; `sendTo`, `sendPage` and `buildPagePayload` in `web-push-delivery.ts`; `encryptPushPayload` in `web-push-crypto.ts`; `pushDevicesHandlers` in `routes/handlers/push-devices.ts`; the `pushDevices.*` routes in `routes/table.ts`.
- Section 8.6, who can test and where the secret goes: the `secrets.test`, `officeSecrets.test`, `mcpServers.test` and `officeMcpServers.test` routes in `routes/table.ts`; `IDENTITY_CHECKS` and `secretTestKind` in `connection-tests.ts`; `mcpServerSecret` in `mcp-servers.ts`.
- Section 8.6, outbound requests and what comes back: `send` and `cleanName` in `connection-tests.ts`.
- Section 8.7, the flow and its checks: `discover`, `send`, `startSignIn` and `finishSignIn` in `mcp-oauth.ts`; the `mcpServers.signIn`, `officeMcpServers.signIn` and `mcpOAuth.callback` routes in `routes/table.ts`.
- Section 8.7, where the tokens are: `writeOwnedSecret` in `mcp-oauth.ts`; `mcp-oauth-tokens.ts`; `mcpServerSecret` in `mcp-servers.ts`.
- Section 8.8, what an agent reads: the `agentConnections.list` route in `routes/table.ts`; `buildAgentConnections` in `agent-connections.ts`; `server/agent-reference/connections.md`.
- Section 8.12: `seatCall`, `headerSafeSecret` and `createEnterpriseSeats` in `enterprise-seats.ts`; `enterpriseSeatsHandlers` in `enterprise-seats-routes.ts`; the `office.enterprise.*` routes in `routes/table.ts`; the `takeSeat` calls in `office-users-routes.ts` and `auth-middleware.ts`.
- Section 8.11: `officeCardResponse` and `probeOffice` in `office-card.ts`; `floorsHandlers` in `routes/handlers/floors.ts`; `createFloorsStore` in `floors-store.ts`; `createOfficeNameCache` in `office-name-cache.ts`; the panel rules in `shared/elevator-panel.ts`; the `floors.*` routes in `routes/table.ts`.
