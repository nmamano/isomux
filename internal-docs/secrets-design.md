# Design: secrets that agents use but cannot read

Board task b38ddd02, co-designed with the OS-user split (task 01f5038c). Status: design, 2026-10-12. Line numbers are from main at bc2b9614. Section 8 lists the **PARKED FOR NIL** items, each with a recommendation.

This is its own document because the split design ([os-user-split-design.md](os-user-split-design.md)) is the spec of a running slice loop. Appendix E lists what the split design takes from this one.

## 0. Summary

- **A secret is a member's variable whose value the office never gives to an agent.** The member gives a name, a value and the hosts that may receive it. In the agent environment the name holds a placeholder.
- **The server makes the call.** A secret proxy runs as the server user. Agents send HTTPS through it. In a request to a listed host, the proxy replaces the placeholder with the value. `echo`, `printenv` and the model context show only the placeholder. This holds only while each listed host does not hand the credential back (section 2.5). Claude Code on the web (for GitHub) and Anthropic's sandbox-runtime use the same pattern (appendix B).
- **The split is the boundary.** With the split, the value is in server space, which the agent user cannot read. The split does not protect credentials that stay in agent space, such as the engines' sign-ins or a key file in a workspace. In single-user mode the same mechanism keeps values out of environments, transcripts and model context, but any shell can read the store, and the product says so (section 4).
- **Coverage.** HTTPS APIs (curl, SDKs), git over HTTPS, and CLIs that send a token from the environment (gh, fly, stripe). SSH keys through a filtered SSH-agent socket, in a later slice. Not covered: values that a tool uses locally (signing, database passwords, encryption keys).
- **Who may use a secret (proposal, PARKED D2).** Keep the two scopes of today's variables: the office, and a member (the agents that member spawned). A placeholder is a bearer credential: another agent of the same OS user can copy it and use the secret. This changes the task's requirement of kernel-checked grants, so Nil decides (section 3).

## 1. What a member defines

Today: personal variables are in `user-env/<userId>.env` ("agents I spawn") and office variables in `office-env/office.env`, both in the state root (server/user-env.ts:18-20). `ManagedEnvEditor` edits them (ui/components/ConnectionsPane.tsx:173,189). The routes return values in clear text to their owner (server/routes/table.ts:1061-1102); the editor masks them until revealed (ui/components/ManagedEnvEditor.tsx:34-36). `buildEnvForUserId` merges office, then personal variables into each agent, terminal and scheduled-run environment (server/env-loader.ts:92-123; server/terminal.ts:54; server/cronjob-manager.ts:884,903).

A secret is a variable with these fields:

| Field | Meaning |
|---|---|
| name | The environment name, as today (`GH_TOKEN`). |
| value | Write-only. No route returns it after a save. The editor shows "set" and the date of the last change. |
| hosts | The HTTPS hosts that may receive it (`api.github.com`, `github.com`). Required. Known names get presets: `GH_TOKEN`, `STRIPE_API_KEY`, `FLY_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. |
| form | Where the value goes: `Authorization: Bearer`, the HTTP Basic password, or a named header (`x-api-key`). Presets set it. |
| scope | Office (an owner sets it) or member, as today. |

**Storage.** `STATE_ROOT/secrets/office.json` and `secrets/users/<userId>.json`, 0600 in a 0700 directory, written as the env files are (server/user-env.ts:106-130). No encryption at rest: a key next to the file adds nothing to the OS-user boundary. Backups exclude the directory, as they exclude the env files (server/backup.ts:196-202).

**Changes.** Section 2.6 says what each change (rotate, add, convert, delete, reissue) does to running agents.

## 2. How an agent uses a secret

### 2.1 Placeholders

Each secret in an agent's scope puts `NAME=<placeholder>` in its environment. The placeholder is an HMAC of the scope, the name and a generation number, under a key in server state. It keeps the value's well-known prefix (`ghp_`), so client-side format checks pass. It stays the same across restarts and rotations. A member can reissue it (the generation goes up). It works only through this office's proxy, for the listed hosts, while the secret exists.

Placeholders are per scope, not per agent: agents of one member share one `opencode serve` per environment profile (server/env-loader.ts:176-191), and its tool calls inherit its environment.

### 2.2 The secret proxy

A server-user process that the server starts and supervises (`server/secret-proxy/`), never through the agent runner. It runs no code that an agent chose. The server sends it the values over a pipe, so the store has one reader.

- It listens on loopback TCP. Agents with a secret in scope get `HTTPS_PROXY`, `https_proxy`, `NO_PROXY` for loopback, and the trust variables of section 2.3. Agents with none get nothing new, so offices without secrets do not change.
- A `CONNECT` to a host that no secret lists becomes a plain tunnel. The proxy does not read it.
- For a listed host, the proxy ends TLS with an office-CA certificate and reads each request. It looks for a placeholder only in the header that the secret's form names (decoding HTTP Basic first). If the secret lists this host, it puts the value in and forwards. If the placeholder belongs to a secret that does not list this host, it answers 403 with the secret name and host. A placeholder sent to a tunneled host passes as a useless string; the value never goes there.
- It never swaps in a body, a query string or another header, so the value goes only where the member said.
- It injects only when the `CONNECT` target, the TLS SNI and the `Host` header name the same listed host, and it never follows a redirect (appendix D).
- It removes the exact value, and its Basic and URL encodings, from responses, as the OpenCode broker does with the office token (server/backends/opencode/authority-broker.ts:376,385-403). This is a backstop, not a proof (section 2.5).
- It logs each use (name, scope, host, method, path, time) in the office audit store.

### 2.3 The office CA, and what it costs

A proxy that adds a header to HTTPS must end TLS, so agents' tools must trust its CA. The office makes the CA when the first secret is saved. The key stays in server state. A bundle of the CA and the system roots goes in the share (`SHARE_ROOT/secrets/ca-bundle.pem`). The agent environment points `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO` and `CARGO_HTTP_CAINFO` at it, and sets `NODE_USE_ENV_PROXY=1`, without which Node ignores the proxy variables. Anthropic's sandbox-runtime sets the same list (appendix B).

Costs:
- A tool that ignores these variables, or pins certificates, fails TLS to listed hosts and cannot use the secret. Other hosts are unchanged tunnels. Node before 24 and 22.21 ignores the proxy variables.
- All HTTPS of agents with secrets passes the proxy. If it stops, they lose network until the server restarts it.
- The CA gives agents no new power: they are the clients that it could fool, and only the server user holds the key.

The alternative with no CA is a plain-HTTP base URL per secret. It covers only tools with a base-URL setting (appendix A.2). **PARKED FOR NIL (D1).**

### 2.4 Per use case

| Use case | How | Covered |
|---|---|---|
| HTTPS API with curl | `curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/...` | Yes |
| SDKs (Python, Node, Go, Bun) | They read `NAME` and honor the proxy and trust variables | Yes, where they honor them (appendix B) |
| git over HTTPS | git honors `https_proxy` and `GIT_SSL_CAINFO`. An office credential helper (set through `GIT_CONFIG_*`) answers the placeholder, which is safe to print. The proxy decodes Basic and swaps. | Yes |
| CLIs with a token in the environment (gh, fly, stripe) | Go programs honor `HTTPS_PROXY` and `SSL_CERT_FILE`. `gh auth token` prints the placeholder. | Yes; slice S3 proves each preset |
| CLIs with a token in a config file | Works if the file holds the placeholder. A CLI login that writes the real value defeats the design. | Partly |
| SSH keys (ssh, git over SSH, rsync) | `SSH_AUTH_SOCK` points at a share socket. The server relays to a private ssh-agent that holds the key, passing only "list keys" and "sign". | Yes, slice S4. Open for S4: the HTTPS hosts field does not apply to SSH destinations, and key entry and storage are not designed yet. |
| The engines' sign-ins (Claude, Codex, OpenCode) | Each CLI reads and refreshes its own sign-in files in agent space. | No. Provider API keys can be secrets. |

Not covered: values that a tool uses locally (AWS SigV4 and other request signing, webhook signature checks, JWT keys, encryption keys); protocols other than HTTPS and SSH (database passwords, SMTP); values in bodies or query strings (OAuth client secrets, `?key=`). Covered values can still be used for anything the token allows on a listed host, including by a prompt-injected agent: narrow tokens and the use log are the mitigation.

### 2.5 Trust in the listed hosts

The proxy decides where the value goes. It cannot decide what a listed host does with it. The promise "the office never gives the value to an agent" holds only if no operation on a listed host returns the credential to the caller in any form. Cases that break it:
- an endpoint that reflects request headers (a debug or echo endpoint), in an encoding that the scrub does not know;
- a host that logs requests and lets the same token read the logs;
- an operation that stores the credential where another operation reads it back.

A method or path filter does not prove an operation safe. The product statement is: values are safe from agents for integrations whose hosts do not echo or store request credentials. **PARKED FOR NIL (D5):** approved integrations only, or any host that a member names.

### 2.6 Changes over time

| Change | Proxy | Running processes |
|---|---|---|
| Rotate a value | Uses the new value on the next request. | No change: the placeholder is the same. |
| Delete a secret | Stops at once: the placeholder is then useless. | Keep the dead placeholder until they restart. |
| Add a secret, reissue a placeholder | Knows the new placeholder at once. | Get it, and the proxy and trust variables, only when they start again. |
| Convert a plain variable | As for add. | Keep the plain value until they restart. |

- **Conversion does not secure a value that agents already had.** Running processes, Codex shell snapshots, transcripts and any copy keep it. The editor tells the member to rotate or revoke the value at the provider after the conversion, and the promise of section 4 starts only then.
- A change of the set of secrets in a scope restarts that scope's agent processes and its OpenCode server on their next turn; a value rotation restarts nothing (appendix D).

## 3. Caller identity

Agents share one OS user, so each can read the others' environments (`/proc/<pid>/environ`), office tokens and placeholders included.

**The precedent.** The OpenCode authority broker listens on a Unix socket, reads the caller's uid and pid from the kernel (`SO_PEERCRED`, authority-broker.ts:287-293), requires the agent uid (:312), and walks the ancestry from the caller to the `opencode serve` pid of the active turn, using start times against pid reuse (:432-456). The slice-3 rig proved the walk across the two users (server/test-support/split-rig.integration.test.ts:603-626).

**What carries over.** That check needs a Unix socket. Tools reach `HTTPS_PROXY` over TCP, where the kernel gives no peer pid, and the server user cannot map a port to a pid (that needs the agent user's `/proc/<pid>/fd`). So the proxy knows the scope only from the placeholder: bearer strength, the same as the office token today. The SSH socket is a Unix socket and could take the kernel check (appendix D); version 1 gives each scope its own SSH socket path instead, a bearer like the placeholder.

**Proposal (pending D2): bearer strength for the office and member scopes.** This changes the task's requirement that grants need the kernel caller check. Reasons: members share the agent user (Nil, 2026-10-05) and today read each other's variables; with secrets, another member's agent can still use a member's secret inside this office, but cannot read the value, and each use is logged. Between agents of one OS user, a kernel check would not be a boundary either:
- An agent can change code or configuration that another agent's processes run: the shared home (shell start files, tool configuration), shared repositories (hooks, scripts), and the launch configuration of the engines in agent space.
- It can attach to another agent's process where `kernel.yama.ptrace_scope` is 0, and signal or stop any of them.
- Ancestry to a shared backend names the backend, not the agent: one `opencode serve` runs the tool calls of every agent of a member profile, so the broker's walk to the serve pid attributes a call to the profile only.

So no per-agent boundary exists under one OS user, and this design claims none.

**Future work, not established here.** Per-agent OS users (Nil's later direction) could make the caller a kernel fact: `SO_PEERCRED` on Unix sockets, and the owner uid of a TCP socket in `/proc/net/tcp`. Before that counts as a boundary, a later design must prove that a socket's owner uid still names the caller for the whole connection (a socket can pass to another process), and that no path lets one agent user write code or configuration that another agent user runs (group-writable shared workspaces). Room and per-agent scopes belong with that work. **PARKED FOR NIL (D2).**

## 4. Hosting paths

| Path | Mode | Promise |
|---|---|---|
| Installer after the split migration, or a fresh split install | split | The office never gives a secret value to an agent. Values that agents had before conversion, and listed hosts that return credentials, are outside the promise (sections 2.5, 2.6). |
| Container with `ISOMUX_SPLIT=1` | split | Same. |
| Installer before migration; self-hosted by its owner; Kubernetes; local and macOS | single-user | Values stay out of agent environments, transcripts and model context, but any shell in the office can read them. |

The secret editor states the promise of this office in one sentence, from the server's own mode. **PARKED FOR NIL (D3):** offer secrets in single-user mode with that sentence, or only in split mode.

## 5. Existing variables

- Variables stay as they are, and a plain variable works as today. The editor says, next to the plain/secret switch, that a plain value is in the agent environment.
- A member turns a variable into a secret in the editor: the value moves from the env file to the store, and the member adds hosts or takes a preset. No automatic conversion: hosts are required, and a secret changes how tools must call. **PARKED FOR NIL (D4).**
- The hint that suggests `GH_TOKEN` as a variable (shared/i18n/en.ts:831) points at secrets instead.
- The split migration moves `secrets/` with the other server state, and its undo moves it back.
- Converting needs a provider-side rotation to make the value secret (section 2.6).

## 6. Redaction as a backstop

- **Log redaction (994e004b, done)** masks key-shaped strings before a log entry is stored (server/log-redaction.ts:4-10). It stays: it still catches plain variables and values from outside the store (a `.env` in a repository, a value pasted in chat). Slice S2 adds exact-value masking of every secret, whatever its shape. In single-user mode that is the main protection.
- **Tool-result censor (9371248b, open)** stays open with its scope unchanged. In split mode the proxy removes its main case (environment values in tool output) for secrets. Nil's open question (refuse a result, or tell the agent that it changed) still governs it. It would use the exact-value list too.
- **The proxy** removes the exact value from responses (section 2.2). Codex shell snapshots (noted in 9371248b) then hold placeholders.

**Records.** Mark 0dda09a6 (agents can read injected variables) superseded by b38ddd02 when slice S2 ships. 9371248b stays open. 994e004b stays done.

## 7. Slices

Secrets slices follow split slice 7 (the switch). Each leaves offices without secrets unchanged.

- **S1. Proxy tracer.** Store, write-only routes, placeholders, the proxy process, the CA, header swap, response scrub, use log; behind a rig flag. First, check that Bun can end TLS with a certificate per host name (unchecked). Rig: an agent-user `curl` with a placeholder reaches a stub HTTPS host that receives the value; the agent user cannot read the store, the CA key or the proxy's environment. It also passes the boundary cases of appendix D.
- **S2. Members turn it on.** Editor switch, hosts and presets (or the approved integrations, per D5), write-only values, the changes of section 2.6 with restarts and the OpenCode identity rule, the per-mode sentence, the rotate-after-conversion notice, exact-value masking, docs and security-audit text. Removes the flag.
- **S3. git and CLIs.** The git credential helper and Basic swap; gh, fly and stripe proven with stub hosts.
- **S4. SSH.** The filtered relay, the share sockets, the trusted-check change. Its design first settles destination limits, key entry and storage.
- **Later, with per-agent OS users:** the uid check in the proxy; room and per-agent scopes.

## 8. PARKED FOR NIL

- **D1. Mechanism.** Recommendation: placeholders and an HTTPS proxy with an office CA. It covers curl, SDKs, git and the Go CLIs with no per-tool setup. Cost: a CA in the trust variables, and all HTTPS of agents with secrets passes the proxy. Alternative: plain-HTTP base URLs per secret, with no CA and fewer tools.
- **D2. Who may use a secret.** This changes the task's requirement that grants need a kernel caller check. Recommendation: keep today's two scopes (office, member) at bearer strength, and claim no per-agent boundary; room and per-agent scopes come with per-agent OS users, after their own proof. Alternative: per-agent grants now with the kernel check, which works only for Unix-socket clients (SSH, `curl --unix-socket`) and is still no boundary between agents of one OS user (section 3).
- **D3. Single-user offices.** Recommendation: offer secrets there, with one sentence saying a terminal on this office can read them. Most leaks are accidents (a printed environment), and this stops them. Alternative: split mode only.
- **D4. Member-facing shape.** Recommendation: a secret switch on each row of the existing variables editor, write-only values, host presets for known names, no automatic conversion. Alternative: a separate Secrets card.
- **D5. Which hosts.** Recommendation: approved integrations only in the first release (host, header form and operations checked not to return the credential), custom hosts later as an owner-only option with a plain statement of the trust it needs. Alternative: any host and header from the start, with that statement.

## Appendix A. Alternatives

1. **The server fills the value into a command or environment.** Rejected: the agent controls the process, so `echo` prints it (task b38ddd02).
2. **Plain-HTTP base URL per secret.** No CA. Works for curl, SDKs with a base-URL setting, and git through `url.<base>.insteadOf`. Not for gh and other CLIs without a base-URL setting.
3. **git credential helper that returns the value.** Rejected: git runs as the agent user and `git credential fill` prints the value.
4. **A wrapper that runs a CLI with the value** (as a third OS user). Rejected: the CLI can print its token (`gh auth token`), and its output goes back to the agent.
5. **Fill in and mask** (1Password `op run`, GitHub Actions masking). The child process holds the value; masking covers only the output that the wrapper sees. That is redaction, not secrecy.
6. **Plain-HTTP forward proxy, as Fly's tokenizer does.** The client asks for `http://api.example.com` through `HTTP_PROXY`, and the proxy upgrades to HTTPS. No CA, but every tool must use `http://` URLs, so it covers the same tools as item 2.
7. **Swap the placeholder anywhere in the request** (Docker Sandboxes, OpenClaw: headers, URLs and bodies). More tools work, but an agent can then put the placeholder in a body that a listed host stores or echoes. This design swaps only in the named header.

## Appendix B. Prior art and tool support

Checked 2026-10-12 by a research agent from official docs and source; Isomux Worker 4 read its report. "Reads the value" means a process that the agent controls can print it.

| System | Mechanism | Agent reads the value? |
|---|---|---|
| [1Password `op run`](https://www.1password.dev/cli/reference/commands/run/) | Fills references into the child's environment; masks them on the stdout and stderr that it relays. The docs' own `op run --no-masking -- printenv` prints the value. | Yes |
| git credential helpers ([gitcredentials](https://git-scm.com/docs/gitcredentials), [git-credential](https://git-scm.com/docs/git-credential), [credential-cache](https://git-scm.com/docs/git-credential-cache)) | The helper answers git, and git (agent uid) sends the value. `git credential fill` prints `password=`. `credential-cache` keeps values in a daemon behind a same-user socket. | Yes |
| HashiCorp Vault [Agent](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent) and [Proxy](https://developer.hashicorp.com/vault/docs/agent-and-proxy/proxy/apiproxy) | Templates write plain files; exec mode fills the environment. The proxy adds the Vault token only to requests to Vault. No injection into other APIs found. | Yes (app secrets) |
| [GitHub Actions masking](https://docs.github.com/en/actions/reference/security/secure-use) | Redacts the job log only. The docs: "automatic redaction is not guaranteed"; derived values (Base64, JSON) need separate registration. | Yes |
| [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | `tlsTerminate` with a MITM CA plus `credentials` in `mask` mode: a sentinel inside the sandbox, the real value on egress to `injectHosts` only. | No |
| [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/security/credentials/) | A host proxy writes auth headers; the VM sees a sentinel (`sbx-cs-<rand>`), swapped in requests to the listed hosts. | No |
| [OpenClaw](https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress), [iron-proxy](https://github.com/ironsh/iron-proxy), [Omnigent](https://github.com/omnigent-ai/omnigent/blob/main/docs/AGENT_YAML_SPEC.md) | Opt-in egress proxies that swap placeholders for bound hosts. | No |
| [Fly tokenizer](https://github.com/superfly/tokenizer) | The client sends a sealed secret in a proxy header over plain HTTP; the proxy decrypts it, injects it, and upgrades to HTTPS for allowed hosts. No CA. | No |
| ssh-agent ([manual](https://man.openbsd.org/ssh-agent.1), [ssh_config](https://man.openbsd.org/ssh_config.5), [ssh-agent.c](https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c)) | The protocol has no export message. Anyone who can connect can sign, add or remove keys. `ssh-agent` drops a peer whose uid is not its own or root, so a server-user agent needs a relay. | No (use only) |
| [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) | GitHub access through a proxy that swaps a scoped credential for the real token; `GH_TOKEN` reads `proxy-injected`. Environment variables of the environment are readable. | No for GitHub; yes for variables |
| [OpenAI Codex cloud](https://learn.chatgpt.com/docs/environments/cloud-environment) | Secrets exist only during the setup script; environment variables last the whole session. | Variables yes; secrets not in the agent phase |
| Devin ([docs](https://docs.devin.ai/product-guides/secrets), [write-up](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/)) | Secrets go into the environment per command; a public write-up shows exfiltration. | Yes |
| [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables) | Secrets are environment variables, masked in session logs only. | Yes |

Tool support: [curl](https://curl.se/docs/sslcerts.html) reads `CURL_CA_BUNDLE` and `SSL_CERT_FILE`; [Node](https://nodejs.org/api/cli.html) reads `NODE_EXTRA_CA_CERTS` at start and the proxy variables only with `NODE_USE_ENV_PROXY=1`; [Python requests](https://requests.readthedocs.io/en/latest/user/advanced/) reads `REQUESTS_CA_BUNDLE`; Go reads `SSL_CERT_FILE` on Unix ([crypto/x509](https://pkg.go.dev/crypto/x509)) and never proxies `localhost` ([net/http](https://pkg.go.dev/net/http#ProxyFromEnvironment)); git reads `GIT_SSL_CAINFO`; [Bun](https://bun.com/docs/runtime/environment-variables) reads `SSL_CERT_FILE` (its `NODE_EXTRA_CA_CERTS` support is unchecked). Base-URL settings exist in the Anthropic SDK (`ANTHROPIC_BASE_URL`), the OpenAI SDK (`OPENAI_BASE_URL`), flyctl (`FLY_API_BASE_URL`) and the Stripe CLI (hidden `--api-base`); [gh](https://cli.github.com/manual/gh_help_environment) has none for github.com. The SDK and CLI settings were read in their source: anthropic-sdk-python `_client.py`, openai-python `_client.py`, flyctl `internal/config/config.go`, stripe-cli `pkg/requests/base.go`.

## Appendix C. Evidence index

| Claim | Source |
|---|---|
| Variables merge into every agent, terminal and run environment | server/env-loader.ts:92-123; server/terminal.ts:54; server/cronjob-manager.ts:884,903 |
| Env files live in the state root, 0700 dir and 0600 files | server/user-env.ts:18-20,106-130 |
| Routes return values in clear text, self only | server/routes/table.ts:1061-1102 |
| The editor masks values until revealed | ui/components/ManagedEnvEditor.tsx:34-36 |
| The office token is in the agent environment | server/agent-manager.ts:5284 |
| OpenCode keeps the office token out of `opencode serve` | server/backends/opencode/supervisor.ts:491-493 |
| Broker: peer check, ancestry, scrub | server/backends/opencode/authority-broker.ts:287-293,312,376,385-403,432-456 |
| Cross-user ancestry proven | server/test-support/split-rig.integration.test.ts:603-626 |
| The runner reports the spawned pid | server/agent-runner/frames.ts:112 |
| The share may hold one socket | server/split/trusted-checks.ts:78 |
| Backups exclude the env files | server/backup.ts:196-202 |
| Log redaction pattern and scope | server/log-redaction.ts:4-10; docs/security-audit.md:268 |

## Appendix D. Implementation contract

**Proxy destination rule.** The proxy injects only when the `CONNECT` host and port, the TLS SNI and the request's `Host` agree, the port is 443, and the host is listed for that secret. It then connects to that same host and port and verifies its certificate against the system roots for that name. Any mismatch gets 421 and no injection. It offers only HTTP/1.1 in ALPN, so there is one request parser.

**Redirects.** The proxy never follows a redirect; it returns it to the client. A client that follows it to another origin makes a new request, which gets the value only if the destination rule passes for that origin.

**Restarts.** A change of the set of secrets in a scope (add, delete, reissue, convert) marks that scope's agents: their next turn starts a new process, as a changed variable does today with `/clear` (shared/i18n/en.ts:831), and the OpenCode server of the profile is replaced. Terminals that are open keep their environment until they are reopened, and the terminal card says so.

**OpenCode profile identity.** Today the source key hashes the paths of the env files and the revision hashes their contents (server/env-loader.ts:176-209). Two members with secrets but no env files would share the default profile. So the key also hashes the logical paths of the scopes' secret files, and the revision also hashes the non-value secret state: each secret's scope, name, generation, form and hosts. Adding, deleting, converting and reissuing change the revision and replace the server; a value rotation does not.

**A kernel check on the SSH socket.** In split mode, an ancestry walk would end at a pid that the runner reports at spawn (server/agent-runner/frames.ts:112). An agent can impersonate the runner (split design 2.3), so that pid is only as trusted as the agent user.

**S1 boundary cases.** A host that the proxy terminates but the secret does not list gets 403 and no value; a tunneled host receives only the placeholder; a `CONNECT`, SNI or `Host` mismatch gets 421 and no value; a redirect to another origin carries no value; a stub that reflects the header gets the raw, Basic and URL-encoded forms scrubbed, and a reflection in another encoding (for example hex) reaches the client, which the test records as the known limit of section 2.5.

## Appendix E. Changes to the split design

- **Inventory (split 1):** the secret proxy, a server-user process that the server starts directly.
- **Files (split 3.1):** server state gains `secrets/` (values, placeholder key, CA key). The share gains `secrets/ca-bundle.pem` (0640) and, in slice S4, the SSH sockets.
- **Trusted checks (split 2.4):** the share may hold one socket today (server/split/trusted-checks.ts:78); slice S4 adds the SSH sockets.
- **Environment (split 1):** `buildEnvForUserId` adds placeholders and the proxy and trust variables for scopes with secrets, on top of the runner's base environment in split mode.
- **Backups (split 3.5):** `secrets/` joins the credential exclusions.
- **Public text (split 9):** docs/security-audit.md sections 3.2 and 8 describe secrets in both modes.
