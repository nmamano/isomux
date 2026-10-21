# Design: secrets that agents use but cannot read

Board task b38ddd02. Status: decided, 2026-10-13; the spec for slice loop B ([secrets-loop.md](secrets-loop.md), rulings 1-11). Line numbers are from main at bc2b9614. Prior art: [secrets-prior-art.md](secrets-prior-art.md).

## 0. Summary

- **A secret is a credential that the office never gives to an agent.** A member gives a name, a value, the hosts that may receive it and the form it is sent in. In the agent environment the name holds a placeholder.
- **The server makes the call.** A secret proxy runs as the server user. Agents send HTTPS through it. In a request to a listed host, the proxy replaces the placeholder with the value. `echo`, `printenv`, transcripts and the model context show only the placeholder.
- **The promise (single-user offices).** Values stay out of agent environments, transcripts, the model context and every route, export, backup and log. An agent that reads the office's files on purpose can read the store, and the Secrets list says so in one sentence (section 4). The design does not depend on the OS-user split, which is on hold.
- **Coverage.** HTTPS APIs (curl, SDKs), git over HTTPS, and CLIs that send a token from the environment (gh, stripe). A registered app can get a raw value in its environment (section 9). Not covered for agents: flyctl (appendix F), values that a tool uses locally (signing, database passwords, encryption keys), protocols other than HTTPS, and website logins.
- **Who may use a secret.** The two scopes of today's variables: the office (owner-only, as office variables) and a member (the agents that member spawned). No per-agent limits: those would need per-agent sandboxing. A placeholder is a bearer credential inside the office, and each use is logged.

## 1. What a member defines

Today: personal variables are in `user-env/<userId>.env` ("agents I spawn") and office variables in `office-env/office.env`, both in the state root (server/user-env.ts:18-20). `buildEnvForUserId` merges office, then personal variables into each agent, terminal and scheduled-run environment (server/env-loader.ts:92-123; server/terminal.ts:54; server/cronjob-manager.ts:884,903).

Secrets have their own list next to the variables list, on the office and the personal half of the connections settings (which loop A grows into the integrations page). There is no secret switch on a variable row. A secret has these fields:

| Field | Meaning |
|---|---|
| name | The environment name (`GH_TOKEN`), same rules as a variable. Unique in its scope. A secret with a host cannot use a model sign-in key name (`MODEL_KEY_SECRET_NAMES` in `shared/secret-hosts.ts`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the like): the engine would sign in with the placeholder, and the proxy never swaps it on a never-listed host (task f51e4ab9). The rule holds on create, on every edit and on a secret request (400 `invalid_secret`, field `name`, reason `model_key`); a secret stored before it keeps loading and shows a warning on its row. An app-only secret may use the name. |
| value | Write-only. No route returns it. The list shows "set" and the date of the last value change. A new value has at least 8 characters, because the scrub and the log masking skip shorter values (Nil, 2026-10-13); a shorter value saved before that rule keeps working. |
| hosts | 1-20 exact DNS host names that may receive it (`api.github.com`). No scheme, port, path, wildcard, IP literal or `localhost`. A host on the never-list (section 2.2) is refused. |
| form | `authorization`: the `Authorization` header in any scheme (Bearer, `token`, the user or password of Basic after decoding). `header`: the whole value of one named header (`x-api-key`). |
| generation | Starts at 1. B2 derives the placeholder from it; reissue raises it. |
| timestamps | `createdAt`, `valueSetAt`, `updatedAt` (ms). |

**Presets** (GitHub, Stripe, Fly) fill name, hosts and form. They and the never-list are one table, `shared/secret-hosts.ts`, read by the UI, the routes and the proxy. B3 proves each preset end to end. There are no presets for model APIs, which are on the never-list.

**Vouching (D5).** A secret may go to any host that is not on the never-list. Where hosts are entered, the list says that the member vouches the host does not send the credential back (section 2.5).

**Storage.** `STATE_ROOT/secrets/office.json` and `STATE_ROOT/secrets/users/<userId>.json`, 0600 in 0700 directories, written atomically as the env files are (server/user-env.ts:106-130). Each file is `{"version":1,"secrets":[...]}`, sorted by name. No encryption at rest: a key next to the file adds nothing. An office without secrets has no `secrets/` directory. Backups exclude the directory, as they exclude the env files (server/backup.ts:196-202).

**A removed member.** Removal deletes `secrets/users/<userId>.json`, `user-env/<userId>.env` with its notes, and `mcp-servers/users/<userId>.json` (Nil, 2026-10-13). There is no purge action. The member's agents keep running; those that had a member secret restart after their turn, without it.

**Routes.** Gated as the variables are: `cap("user:env")`, which no agent scope holds. A member's secrets reach the member and an office owner (`selfOrEnvOwner`, Nil, 2026-10-13); office secrets reach owners (`officeEnvOwner`), and members read the office list as names, hosts and notes (`officeEnvReader`). Show is the only response with a value: `cap("secret:show")`, held by humans and their API tokens and by no agent scope, for the secret's own member (`selfUserOrApi`) or an owner on an office secret. An owner never reads a member's secret.

| Operation | Member | Office |
|---|---|---|
| list | `GET /api/users/:username/secrets` | `GET /api/office/secrets` |
| create | `POST /api/users/:username/secrets` | `POST /api/office/secrets` |
| show the value | `GET /api/users/:username/secrets/:name/value` | `GET /api/office/secrets/:name/value` |
| rotate the value | `PUT /api/users/:username/secrets/:name/value` | `PUT /api/office/secrets/:name/value` |
| edit hosts and form | `PATCH /api/users/:username/secrets/:name` | `PATCH /api/office/secrets/:name` |
| delete | `DELETE /api/users/:username/secrets/:name` | `DELETE /api/office/secrets/:name` |

Each change and each Show writes an audit row with the secret name as target and the body's field names, never their values. A row on a member's secret also names the member.

## 2. How an agent uses a secret

### 2.1 Placeholders

Each secret in an agent's scope puts `NAME=<placeholder>` in its environment. The placeholder is an HMAC of the scope, the name and the generation, under a key in server state. It keeps the value's well-known prefix (`ghp_`), so client-side format checks pass. It stays the same across restarts and rotations. A member can reissue it (the generation goes up). It works only through this office's proxy, for the listed hosts, while the secret exists.

Placeholders are per scope, not per agent: agents of one member share one `opencode serve` per environment profile (server/env-loader.ts:176-191), and its tool calls inherit its environment.

When a name is set more than once, the order is: personal secret, personal variable, office secret, office variable. The Secrets list marks a clash with a variable.

The secrets an OAuth MCP registration owns (its refresh token and client secret, integrations A2b) are the server's own credentials: no placeholder, not in the proxy snapshot, and the flow's rotation of one restarts no agent. The registration lists them (`ownedSecrets` in the MCP servers file); when that file cannot be read, every name of the flow's shape (`MCP_<NAME>_OAUTH`, `MCP_<NAME>_OAUTH_CLIENT`) counts as owned. See server/secret-proxy/runtime.ts, `ownedIn`.

### 2.2 The secret proxy

A server-user process that the server starts and supervises (`server/secret-proxy/`). It runs no code that an agent chose. The server sends it the values over a pipe, so the store has one reader.

- It listens on loopback TCP. Agents with a secret in scope get `HTTPS_PROXY`, `https_proxy`, `NO_PROXY` for loopback, and the trust variables of section 2.3. Agents with none get nothing new, so offices without secrets do not change.
- A `CONNECT` to a host that no secret lists becomes a plain tunnel. The proxy does not read it.
- **The never-list.** A fixed list of hosts that never get a secret: the hosts that carry engine model traffic, the model provider APIs (including the Bedrock and Vertex endpoints) and the package registries. A domain that a model or registry vendor owns is listed with all its subdomains; on shared platforms only the model endpoints are listed. The proxy keeps these hosts as plain tunnels and never ends TLS for them, so the engines' own traffic never passes the office CA. The create and edit routes refuse them as secret hosts.
- For a listed host, the proxy ends TLS with an office-CA certificate and reads each request. It looks for a placeholder only in the header that the secret's form names. If the secret lists this host, it puts the value in and forwards. If the placeholder belongs to a secret that does not list this host, it answers 403 with the secret name and host. A placeholder sent to a tunneled host passes as a useless string.
- It never swaps in a body, a query string or another header, and never on `TRACE` or `OPTIONS` (TRACE reflects the request; Omnigent).
- It injects only when the `CONNECT` target, the TLS SNI and the `Host` header name the same listed host, and it never follows a redirect (appendix D).
- It removes the exact value, and its Basic and URL encodings, from responses, as the OpenCode broker does with the office token (server/backends/opencode/authority-broker.ts:376,385-403). This is a backstop, not a proof (section 2.5).
- It logs each use (name, scope, host, method, path, time) in the office audit store.

### 2.3 The office CA, and what it costs

A proxy that adds a header to HTTPS must end TLS, so agents' tools must trust its CA. The office makes the CA when the first secret is saved. The key stays in server state. A bundle of the CA and the system roots goes in the share (`SHARE_ROOT/secrets/ca-bundle.pem`). The agent environment points `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO` and `CARGO_HTTP_CAINFO` at it, and sets `NODE_USE_ENV_PROXY=1`, without which Node ignores the proxy variables. Anthropic's sandbox-runtime and OpenClaw set the same list.

Costs:
- A tool that ignores these variables, or pins certificates, fails TLS to listed hosts and cannot use the secret. Other hosts are unchanged tunnels. Node before 24 and 22.21 ignores the proxy variables.
- All HTTPS of agents with secrets passes the proxy. If it stops, they lose network until the server restarts it.
- The CA gives agents no new power: they are the clients that it could fool.

### 2.4 Per use case

| Use case | How | Covered |
|---|---|---|
| HTTPS API with curl | `curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/...` | Yes |
| SDKs (Python, Node, Go, Bun) | They read `NAME` and honor the proxy and trust variables | Yes, where they honor them (appendix B) |
| git over HTTPS | git honors `https_proxy` and `GIT_SSL_CAINFO`. An office credential helper (set through `GIT_CONFIG_*`) answers the placeholder, which is safe to print. It replaces the host's other helpers, so git never sends the member's own token there or changes their credential store. The proxy decodes Basic and swaps. | Yes (B3) |
| CLIs with a token in the environment (gh, stripe) | Go programs honor `HTTPS_PROXY` and `SSL_CERT_FILE`. `gh auth token` prints the placeholder. | Yes (B3) |
| flyctl | It drops a token that is not a valid, unexpired macaroon before it sends anything (appendix F). curl and SDK calls to the Fly APIs work. | No |
| CLIs with a token in a config file | Works if the file holds the placeholder. A CLI login that writes the real value defeats the design. | Partly |
| Model API keys (an agent's app calling a model SDK) | The model APIs are on the never-list. | No |
| The engines' sign-ins (Claude, Codex, OpenCode) | Each CLI reads and refreshes its own sign-in files. | No |

Not covered: values that a tool uses locally (AWS SigV4 and other request signing, webhook signature checks, JWT keys, encryption keys); SSH keys; protocols other than HTTPS (database passwords, SMTP); values in bodies or query strings (OAuth client secrets, `?key=`). Covered values can still be used for anything the token allows on a listed host, including by a prompt-injected agent: narrow tokens and the use log are the mitigation.

### 2.5 Trust in the listed hosts

The proxy decides where the value goes. It cannot decide what a listed host does with it. The promise holds only if no operation on a listed host returns the credential to the caller in any form: an endpoint that reflects request headers in an encoding that the scrub does not know, a host that logs requests and lets the same token read the logs, or an operation that stores the credential where another operation reads it back.

A method or path filter does not prove an operation safe. So a secret may go to any host that a member names (D5), and the member vouches, in the sentence next to the hosts field, that the host does not send the credential back. Presets cover common services.

### 2.6 Changes over time

| Change | Proxy | Running processes |
|---|---|---|
| Rotate a value | Uses the new value on the next request. | No change: the placeholder is the same. |
| Edit hosts or form | Uses them on the next request. | No change. |
| Delete a secret | Stops at once: the placeholder is then useless. | Keep the dead placeholder until they restart. |
| Add a secret, reissue a placeholder | Knows the new placeholder at once. | Get it, and the proxy and trust variables, only when they start again. |

- **Moving a variable to a secret does not secure a value that agents already had.** Running processes, Codex shell snapshots, transcripts and any copy keep it. The list tells the member to rotate the value at the provider after the move.
- A change of the set of secrets in a scope restarts that scope's agent processes and its OpenCode server on their next turn; a value rotation restarts nothing (appendix D). A change of a scope's variables releases its agents by the same rule.

## 3. Caller identity

Agents share one OS user, so each can read the others' environments (`/proc/<pid>/environ`), office tokens and placeholders included. Tools reach `HTTPS_PROXY` over TCP, where the kernel gives no peer pid, so the proxy knows the scope only from the placeholder: bearer strength, the same as the office token today. Another member's agent can use a member's secret inside this office, but cannot read the value through the office, and each use is logged.

No per-agent boundary exists under one OS user, and this design claims none: an agent can change code or configuration that another agent's processes run (the shared home, shared repositories), and can signal or attach to their processes.

## 4. The promise in the product

One sentence in the Secrets list, from B4: values stay out of agent environments, transcripts and the model context, but an agent that reads this office's files on purpose can read them. It is true on every hosting path (installer, container, Kubernetes, local and macOS), because none of them separates the agent user from the server today.

## 5. Existing variables

- Variables stay as they are, and a plain variable works as today. The variables list says that a variable's value is in the agent environment.
- No automatic conversion: hosts are required, and a secret changes how tools must call. A member who moves a variable creates the secret and deletes the variable, and rotates the value at the provider (section 2.6).
- The hint that suggests `GH_TOKEN` as a variable (shared/i18n/en.ts:831) points at secrets instead (B4).

## 6. Redaction as a backstop

- **Log redaction (994e004b, done)** masks key-shaped strings before a log entry is stored (server/log-redaction.ts:4-10). It stays: it still catches plain variables and values from outside the store. B2 adds exact-value masking of every secret, whatever its shape.
- **Tool-result censor (9371248b, open)** stays open with its scope unchanged. It would use the exact-value list too.
- **The proxy** removes the exact value from responses (section 2.2). Codex shell snapshots then hold placeholders.

**Records.** Mark 0dda09a6 (agents can read injected variables) superseded by b38ddd02 when B2 ships. 9371248b stays open. 994e004b stays done.

## 7. Slices

Each leaves offices without secrets unchanged.

- **B1. The store and the Secrets list.** Write-only store and routes, the preset and never-list table, the list in both halves of the connections settings, and a test per read path that a known value never appears (routes, backup, logs, audit, the agent reference, the demo server). Agents get nothing new.
- **B2. The proxy.** Placeholders, the proxy process, the CA, header swap, response scrub, use log, the environment and restart rules of section 2.6, exact-value log masking. Bun 1.4.2 ends TLS with a certificate per host name (checked 2026-10-13: a `tls.TLSSocket` over the CONNECT socket with an SNI callback). It passes the boundary cases of appendix D with stub hosts. Known limits, appendix F.
- **B3. Each preset end to end.** curl, git over HTTPS (the credential helper and Basic swap), gh, stripe, fly, and the Node and Python SDKs, against stub hosts.
- **B4. An agent asks, the member types.** An agent starts "add a secret" and the member enters the value in a masked form outside the chat (OpenClaw, qm, Grok Bot). The promise sentence of section 4; docs and security-audit text.

**Later option, not built now.** From Codex cloud: a shared scope names the secrets that it needs, and each member supplies their own value.

## 8. Decisions

All decided on 2026-10-13 (loop file rulings).

- **D1. Mechanism.** Placeholders per scope, an office CA, and a proxy that swaps a placeholder only in the secret's named header and only for a listed host, never on TRACE or OPTIONS, with a never-list, a response scrub and a use log (ruling 7).
- **D2. Who may use a secret.** The office and member scopes, at bearer strength. No per-agent limits (ruling 1).
- **D3. Single-user offices.** Secrets ship there, with one honest sentence (ruling 3; section 4).
- **D4. Member-facing shape.** A separate Secrets list next to the variables list; no switch on a variable row (ruling 2). Variables, secrets and integrations are one page (ruling 11).
- **D5. Which hosts.** Any host off the never-list, with presets and the vouch sentence (ruling 9). Office secrets are owner-only (ruling 10).

## 9. Secrets that apps read

Task c7007f8b (Nil, 2026-10-20: option A, "apps get raw values, agents never do"). Some values must be raw inside a process: an HMAC key that signs, a bot token sent in a websocket login. An app can get them; an agent never does.

- **Grants.** A secret has an apps list next to its hosts: `{name, createdAt}` pairs in the store (`apps` in the file, absent when none). A secret needs at least one host or one app. The creation time binds a grant to one registration, so a new app with a deleted app's name gets nothing. The wire (`SecretWire.apps`) lists the names of the grants whose app is live.
- **Who gives one.** Only a human, by session or API token (`identity.scope` user or api). Any other caller that sends apps on create, or adds a `(name, createdAt)` pair on update, gets 403 `secret_app_add_refused`; it may keep or remove apps, and it keeps rotate (it writes a value, it reads nothing). The reason: any agent can read an app's process environment. A secret request (B4) takes no apps. A member secret goes only to an app that member owns; an office secret to any app. An app with no owner gets office secrets only.
- **Names.** A secret with apps cannot use a name the app's environment needs (`PORT`, `PATH`, `HOME`, `LANG`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`; `ISOMUX_` is reserved for every secret). One app cannot get an office secret and a member secret with the same name: the store refuses the grant in the same write (400 `invalid_secret`, field `apps`, reason `clash`), and if a hand-edited file holds one anyway, the app gets neither value.
- **Agents.** A secret with no host gives no placeholder, is not in the proxy snapshot or the set signature, and is not in `GET /api/agent-connections`: adding, rotating or removing one restarts no agent. Its value is still masked in logs. An office whose secrets have no hosts starts no proxy and makes no CA.
- **Delivery.** `server/app-secrets.ts` is the one writer of `STATE_ROOT/secrets/apps/<app>.env` (0600, directory 0700): one `NAME="value"` line per secret, sorted, double-quoted with a backslash before each of `" \ $` and the backtick. systemd 255 reads it back byte for byte (checked 2026-10-19 and in the live test), and `parse_secrets_env` in `deploy/container/supervisor.py` is the exact inverse. The systemd unit names the file as an `EnvironmentFile` before the token's, so the token file wins a shared name; the container worker reads it at each launch, after the definition env and before the token. Inside `secrets/`, the file has the safety hook's guards and the backup exclusion.
- **Sync.** After every committed secret change (routes, a saved secret request, member removal), after an app delete and at boot, a sync writes the file of each live app that holds a secret, removes every other file in the directory, prunes grants of apps that are gone, and restarts each running or starting app whose file changed. A stopped or failed app reads the file at its next start. The boot sync also regenerates a unit that does not name the file (only at boot: in a container the check is a subprocess per app). A rotation therefore costs a restart (one Discord reconnect for a bot). The route answers after the sync. A failure for one app is logged with the app's name only and does not stop the others or fail the route.
- **Logs.** `GET /api/apps/:name/logs` removes every vault value (raw, URL-encoded and base64) from each line, so an app that prints a value does not put it into an agent's context. A backstop, like the response scrub of section 2.2.
- **The promise.** The app's process holds the value, and every agent runs as the same OS user, so an agent that reads that process's environment on purpose can read it. An office owner can also change a member's app command and read its logs (apps.update, apps.logs), so an owner's agent could make a member's app print a member secret in an encoding the scrub does not know. The Secrets list sentence of section 4 names apps with the files.

## Appendix A. Alternatives

1. **The server fills the value into a command or environment.** Rejected: the agent controls the process, so `echo` prints it.
2. **Plain-HTTP base URL per secret.** No CA. Works for curl, SDKs with a base-URL setting, and git through `url.<base>.insteadOf`. Not for gh and other CLIs without a base-URL setting.
3. **git credential helper that returns the value.** Rejected: git runs as the agent user and `git credential fill` prints the value.
4. **A wrapper that runs a CLI with the value.** Rejected: the CLI can print its token (`gh auth token`), and its output goes back to the agent.
5. **Fill in and mask** (1Password `op run`, GitHub Actions masking). The child process holds the value; masking covers only the output that the wrapper sees. That is redaction, not secrecy.
6. **Plain-HTTP forward proxy, as Fly's tokenizer does.** Every tool must use `http://` URLs, so it covers the same tools as item 2.
7. **Swap the placeholder anywhere in the request** (Docker Sandboxes, OpenClaw: headers, URLs and bodies). More tools work, but an agent can then put the placeholder in a body that a listed host stores or echoes. This design swaps only in the named header.

## Appendix B. Prior art and tool support

Checked 2026-10-12 from official docs and source, and re-checked on 2026-10-13 in [secrets-prior-art.md](secrets-prior-art.md), which also covers the Related projects of site/about.html. "Reads the value" means a process that the agent controls can print it.

| System | Mechanism | Agent reads the value? |
|---|---|---|
| [1Password `op run`](https://www.1password.dev/cli/reference/commands/run/) | Fills references into the child's environment; masks them on the stdout and stderr that it relays. `op run --no-masking -- printenv` prints the value. | Yes |
| git credential helpers ([gitcredentials](https://git-scm.com/docs/gitcredentials), [git-credential](https://git-scm.com/docs/git-credential)) | The helper answers git, and git (agent uid) sends the value. `git credential fill` prints `password=`. | Yes |
| HashiCorp Vault [Agent](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent) and [Proxy](https://developer.hashicorp.com/vault/docs/agent-and-proxy/proxy/apiproxy) | Templates write plain files; exec mode fills the environment. The proxy adds the Vault token only to requests to Vault. | Yes (app secrets) |
| [GitHub Actions masking](https://docs.github.com/en/actions/reference/security/secure-use) | Redacts the job log only; "automatic redaction is not guaranteed". | Yes |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | `tlsTerminate` with a MITM CA plus `credentials` in `mask` mode: a sentinel inside the sandbox, the real value on egress to `injectHosts` only. | No |
| [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/security/credentials/) | A host proxy writes auth headers; the VM sees a sentinel, swapped in requests to the listed hosts. | No |
| [OpenClaw](https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress), [iron-proxy](https://github.com/ironsh/iron-proxy), [Omnigent](https://github.com/omnigent-ai/omnigent/blob/main/docs/AGENT_YAML_SPEC.md) | Opt-in egress proxies that swap placeholders for bound hosts. Omnigent never injects on TRACE or OPTIONS. | No |
| [Fly tokenizer](https://github.com/superfly/tokenizer) | The client sends a sealed secret in a proxy header over plain HTTP; the proxy decrypts it, injects it, and upgrades to HTTPS for allowed hosts. No CA. | No |
| [Claude Code on the web](https://code.claude.com/docs/en/cloud-environments) | Network secrets (Pro and Max plans): the agent proxy adds the header for the listed hosts after the request leaves the VM, and never for GitHub, `api.anthropic.com` or the package registries. GitHub through a proxy that swaps a scoped credential; `GH_TOKEN` reads `proxy-injected`. Environment variables are readable. | No for network secrets and GitHub; yes for variables |
| [OpenAI Codex cloud](https://learn.chatgpt.com/docs/environments/cloud-environments) | Network secrets: a placeholder in the process, swapped by a proxy for the allowed domains. A personal vault per member; a shared environment can ask each member for their own value. The legacy product gave secrets to setup scripts only. | Variables yes; network secrets no |
| Devin ([docs](https://docs.devin.ai/product-guides/secrets), [write-up](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/)) | Secrets go into the environment per command; a public write-up shows exfiltration. | Yes |
| [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables) | Secrets are environment variables, masked in session logs only. | Yes |

Tool support: [curl](https://curl.se/docs/sslcerts.html) reads `CURL_CA_BUNDLE` and `SSL_CERT_FILE`; [Node](https://nodejs.org/api/cli.html) reads `NODE_EXTRA_CA_CERTS` at start and the proxy variables only with `NODE_USE_ENV_PROXY=1`; [Python requests](https://requests.readthedocs.io/en/latest/user/advanced/) reads `REQUESTS_CA_BUNDLE`; Go reads `SSL_CERT_FILE` on Unix ([crypto/x509](https://pkg.go.dev/crypto/x509)) and never proxies `localhost` ([net/http](https://pkg.go.dev/net/http#ProxyFromEnvironment)); git reads `GIT_SSL_CAINFO`; [Bun](https://bun.com/docs/runtime/environment-variables) reads `SSL_CERT_FILE` (its `NODE_EXTRA_CA_CERTS` support is unchecked).

## Appendix C. Evidence index

| Claim | Source |
|---|---|
| Variables merge into every agent, terminal and run environment | server/env-loader.ts:92-123; server/terminal.ts:54; server/cronjob-manager.ts:884,903 |
| Env files live in the state root, 0700 dir and 0600 files | server/user-env.ts:18-20,106-130 |
| Variable routes: owner-only office, self-only personal | server/routes/table.ts:1061-1102 |
| The office token is in the agent environment | server/agent-manager.ts:5284 |
| Broker scrub of the office token | server/backends/opencode/authority-broker.ts:376,385-403 |
| Backups exclude the env files | server/backup.ts:196-202 |
| Log redaction pattern and scope | server/log-redaction.ts:4-10; docs/security-audit.md:268 |

## Appendix D. Implementation contract (B2)

**Proxy destination rule.** The proxy injects only when the `CONNECT` host and port, the TLS SNI and the request's `Host` agree, the port is 443, the method is not `TRACE` or `OPTIONS`, and the host is listed for that secret and not on the never-list. It then connects to that same host and port and verifies its certificate against the system roots for that name. Any mismatch gets 421 and no injection. It offers only HTTP/1.1 in ALPN, so there is one request parser.

**Redirects.** The proxy never follows a redirect; it returns it to the client. A client that follows it to another origin makes a new request, which gets the value only if the destination rule passes for that origin.

**Restarts.** A change of the set of secrets in a scope (add, delete, reissue) marks that scope's agents: their next turn starts a new process, and the OpenCode server of the profile is replaced. Terminals that are open keep their environment until they are reopened, and the terminal card says so. A save of a scope's variables that adds, removes or changes a value marks the same agents the same way; a notes-only save marks none (server/isomux-office.ts, replaceUserEnv and replaceOfficeEnv).

**OpenCode profile identity.** Today the source key hashes the paths of the env files and the revision hashes their contents (server/env-loader.ts:176-209). Two members with secrets but no env files would share the default profile. So the key also hashes the logical path of the member's own secrets file once it exists (the store deletes it only when the member is removed; office files never join the key; integrations A2 adds its MCP servers file by the same rule). The revision also hashes each secret's scope, name, generation and placeholder, and the proxy port. Adding, deleting and reissuing change the revision and replace the server; a value rotation or an edit of hosts or form does not, because the proxy reads them per request.

**Boundary cases (tests).** A host that the proxy terminates but the secret does not list gets 403 and no value; a tunneled host receives only the placeholder; a never-listed host is always a tunnel; `TRACE` and `OPTIONS` to a listed host carry no value; a `CONNECT`, SNI or `Host` mismatch gets 421 and no value; a redirect to another origin carries no value; a stub that reflects the header gets the raw, Basic and URL-encoded forms scrubbed, and a reflection in another encoding (for example hex) reaches the client, which the test records as the known limit of section 2.5.

## Appendix E. If the OS-user split resumes

The split is on hold, and nothing in this loop touches it. If it resumes, its design takes from this one: server state gains `secrets/` (values, placeholder key, CA key) and its migration moves the directory; the share gains `secrets/ca-bundle.pem` (0640); the promise of section 4 becomes "the office never gives a secret value to an agent" for split offices.

## Appendix F. Known limits of the proxy (B2)

Measured or read in code, 2026-10-13.

- **Scrub.** It knows the raw, URL-encoded and base64 forms of a value of 8 characters or more. A reflection in hex, base64url (JWT style), JSON-escaped (`\/`) or lower-case percent encoding reaches the client (section 2.5).
- **Trust.** Tools that ignore `SSL_CERT_FILE` and its siblings, or that pin certificates, fail TLS to a host that a secret lists. On macOS the bundle takes the self-signed certificates of the System keychains and does not read trust settings, so a root that an administrator distrusted is still trusted.
- **Company proxy.** The server's own `HTTPS_PROXY` is chained with CONNECT, for tunnels and listed hosts alike, and its `NO_PROXY` is honored without CIDR entries. An `https://` company proxy URL is dialled as plain TCP and fails closed (502). A member variable named `HTTPS_PROXY` is replaced, not chained.
- **Restarts.** A conversation that cannot resume (a Codex thread that is not durable yet) keeps its process and its old environment until `/clear`. An open terminal keeps its environment until it is restarted, and the terminal panel says so.
- **Protocols.** HTTP/1.1 only to listed hosts; upgrades (WebSocket) to a listed host get 501.

Tools (B3, 2026-10-13, stub hosts; `server/secret-proxy/tools.test.ts`):

- **flyctl.** It parses `FLY_API_TOKEN` into macaroons and, before its first request, deletes every token that does not decode or has expired (fly-go 9cd55520, `tokens/tokens.go:259-300`, called through flyctl 9068e6f4 `internal/command/command.go:616` and `internal/config/tokens.go:225,240`). A placeholder is not a macaroon, so flyctl sends an empty credential (read in code; what the member then sees is unchecked). Not run: flyctl is not installed on the box that ran B3.
- **Fly header form.** flyctl sends `Authorization: FlyV1 fm2_...` (fly-go `tokens/tokens.go:235-245`, `flaps/flaps.go:273`); Fly's Machines API docs send `Authorization: Bearer <token>` with the same token. The proxy swaps both. The connection test sends a value that starts with its own scheme as it is.
- **git.** The helpers are fixed when a process starts. A hosts or form edit changes the OpenCode revision, so an OpenCode server with the old helpers is not adopted again; a running Claude or Codex process and an open terminal keep the old helpers until they start again (a hosts edit marks no restart).

