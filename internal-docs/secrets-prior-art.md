# Prior art: how other products handle secrets

Research for the secrets design ([secrets-design.md](secrets-design.md)) and the integrations page (board task 911c9bbb). Checked 2026-10-13 by Isomux Workers 1-6, from official docs and public source. No product was installed or run, and no account was made.

The products are the "Related projects" of site/about.html. Appendix B of the secrets design already covered OpenClaw, Claude Code on the web, Codex cloud, Devin and the Copilot coding agent; section 2 re-checks those rows.

**How to read it.** A table cell is verified unless it says "(inference)". Verified means that a person opened the cited doc page, or the cited lines at the named commit, and it says what the cell says. The evidence for each cell is in the notes (section 3). "Reads the value" means that a process the agent controls can print it.

## 1. Per product

| Product | 1. Entry and scope | 2. How the agent uses it | 3. Agent reads the value? | 4. Tied to hosts; who may use it | 5. Redaction | 6. Connectors |
|---|---|---|---|---|---|---|
| Omnigent | Self-hosted: `credential_proxy` in the agent YAML; the value comes from an env var, file, command or broker socket of the host. Managed: per-user GitHub and Databricks OAuth, encrypted with KMS. | Self-hosted: an egress MITM proxy adds `Authorization` to bound-host requests, with no placeholder by default; an `oa_cred_` placeholder for clients such as `gh`. Managed: a broker gives the real token to the sandbox. | Self-hosted: no. Managed: yes, as its own code comment says. | One host per entry; a placeholder sent to another host gets 403; never on TRACE or OPTIONS; needs a bwrap or Seatbelt sandbox. | Pattern redaction of process logs. No scrub of proxy responses. | GitHub and Databricks connections share the store and broker. Remote MCP headers take `${ENV}` values. |
| qm | Personal "keychain" (one-time secret-drop form, saved CLI login, OAuth) and org credentials that admins set. Shared to a room by a grant (once or standing). | `env` and `file`: only in a command that names the credential handle. `broker`: an HTTP API; the server makes the call. | `env` and `file`: yes. `broker`: no. | Broker: one pinned host, methods (default GET), path prefixes, no redirects. Use needs a grant. | Exact-value masking of command output (raw, URL, Base64). No scrub of broker responses. | OAuth connectors save to the keychain. Per-user MCP tokens go only to the registered host. Composio key held by the server. |
| Orca | Settings → Integrations (Linear, Jira, Bitbucket), OS keychain (Linear falls back to a plain 0600 file), per machine. A per-agent-type env editor. `.env` files copied into worktrees. | Integrations: fixed CLI verbs (`orca linear …`); the app makes the call. Other values: plain env vars or files. | Env: yes, and `settings.get` returns the values that the editor hides. Integration tokens: not given out, but the agent is the same OS user (inference). | Tokens per Linear workspace or Jira site. Env: no host binding (inference). | Only its own dispatch tokens and telemetry. Masks MCP env values in its settings view. | Built-in clients with CLI verbs. MCP stays in the agents' own config files. |
| Munder Difflin | Settings → Integrations (template or custom REST API, plus a secret), app-wide, encrypted with Electron safeStorage. BYOK model keys. Slack keys in plain `config.json`. | A loopback broker. A worker gets the broker URL and a per-worker capability token; the broker adds the auth header. | Integrations: no, but the store belongs to the same OS user (inference: no OS boundary). BYOK keys: yes. | One `baseUrl` origin and path per secret. Every worker spawned through a spawn request gets every enabled integration; desk agents get none. | Regex redaction of voice-layer messages only. No broker response scrub, no use log. | The integrations registry is its connector layer (REST, no OAuth yet). MCP catalog entries have empty secret values. |
| OpenClaw | Control UI Settings → Secrets, the CLI, or an agent request that the member answers in a masked prompt. One Gateway-wide team store. | `env` kind: plain env var. `secret` kind: an `oc-sent-v2…` sentinel and an opt-in loopback MITM proxy (default off). | `env`: yes. `secret`: no. | Exact hosts per secret; no host means never swapped. Any Gateway-hosted exec may use it. | Exact-value redaction of logs. Transcripts and tool results not masked. No response scrub (inference). | SecretRefs feed model keys and MCP server `env` (plain in the MCP process). |
| Hermes Agent | `~/.hermes/.env` per profile, a masked prompt when a skill loads, or a vault fetch at start (Bitwarden, 1Password, a command). Admin "managed scope". | Plain env var. Hermes credentials are stripped from tool processes unless declared; `execute_code` and remote backends are default-deny. A browser vault fills logins by handle. | Declared variables: yes (inference: the process holds them). Vault passwords: no. | Env: no host binding, per profile. Vault: exact page origin. | Regex redaction of tool output and logs, on by default. Exact-value scrub for vault values only. | MCP stdio servers get safe variables and their own `env`. MCP OAuth tokens in plain files. |
| Pi | `auth.json` (`/login`), env vars, or `!command` that a vault CLI answers. Per OS user. | No secrets feature for tools. The bash tool gets the whole process environment. | Yes. | No. | None, except the bug-report export. | MCP OAuth tokens in a plain file. `${VAR}` or `!command` in headers. Its docs point to Docker Sandboxes for placeholders. |
| AdaL | No secrets store. Model keys in `~/.adal/settings.json`; MCP keys from the shell or flags; connector keys pasted on a connector page, per account. | Plain env vars and files (inference). Connectors through two broker tools. | Env and files: yes (inference). Connector tokens: no (inference; closed source). | Connectors per account. Env: no host binding (inference). | Key masked in the `/byoak` dialog only. Partial redaction of what goes to its completion-check service. | Connectors (OAuth or key) tied to the AdaL account; tokens likely on AdaL's backend (inference). Local MCP OAuth tokens. |
| Cursor | Cloud agents: a Secrets tab and API; team, user, environment and per-run scopes; each value can be limited to repos. Local agent: none; `.cursorignore` hides `.env`. | Plain env in the cloud VM, of three types: Environment Variable, Runtime Secret (output redacted), Build Secret (image build only). OIDC tokens, AWS role. | Environment Variable: yes. Runtime Secret: in the env with output redacted, so readable (inference). Build Secret: no. | Repos and scope, not hosts. Egress allowlist is separate. | Runtime Secrets removed from tool results, transcript and commits. MCP `env` and `headers` write-only. | HTTP MCP: credentials stay in the backend, calls proxied. Stdio MCP: credentials in the VM. MCP OAuth per user. |
| Grok Bot | A masked "secure secret card" (user). A Team Bot Secrets panel: name, description, value (whole team). Enterprise Team Secrets (setup scripts only). | Team Bot: "uses a secret by name" with output redaction; likely a plain env var (inference). Card: filled into a web page. Plugins: OAuth on Cursor's backend. | Docs: "The Bot can't see a value". The only mechanism named is `[REDACTED]` on outputs, so an encoded value passes (inference). | No host binding. A Team Bot secret works in every teammate's chat. | Output redaction (8-character minimum). "pattern matching cannot catch every secret". | Cursor's MCP plugins, OAuth held on Cursor's backend. Templates exclude secrets. |
| Muse | Settings → Connectors (OAuth); a custom client form for passwords; custom connectors into a "Secure Credentials Store". One person, one VM. | A surrogate token from `authd`; the Sentinel egress proxy swaps it after it approves the request. Built-in connectors run in separate workers with narrow privileges. | No. | Sentinel checks host, IP, port, method, path and body per request. Per-worker credential allowlists by cgroup. | None for secrets (the agent holds none). The email connector drops one-time codes and reset links. | Built-in connectors, and custom connectors that Muse writes. MCP not in the official pages read. |

## 2. Appendix B rows, re-checked

| System | Appendix B row | Status on 2026-10-13 |
|---|---|---|
| OpenClaw | Opt-in egress proxy that swaps placeholders for bound hosts. | Holds. It also swaps in URLs and streamed bodies, but not in WebSocket frames (appendix A item 7 holds). |
| Claude Code on the web | GitHub through a proxy; environment variables readable. | Holds. New: "network secrets" (Pro and Max plans only). Anthropic's agent proxy adds the header for listed hosts after the request leaves the VM, with no placeholder, and never for `api.anthropic.com`, package registries or GitHub. |
| Codex cloud | Secrets only in the setup script. | Out of date. The cited page is now "Codex Cloud (Legacy)" and still says this. The current Codex Cloud has network secrets (a placeholder in the process, swapped by a proxy for allowed domains) and a personal vault per member. |
| Devin | Secrets in the environment per command; public exfiltration write-up. | Holds. |
| Copilot coding agent | Environment variables, masked in session logs. | Holds. Now "Copilot cloud agent" with "Agents" secrets; names that start with `COPILOT_MCP_` go only to MCP server configuration. |

Some Codex pages and the Devin docs blocked automated reads on 2026-10-13, so those were read from Wayback Machine copies of the official URLs; the notes give each snapshot date. The current Codex cloud guide loaded live in the re-check and matched its snapshot.

## 3. Notes

Each product's notes name their source. Repositories were read at these commits:

| Product | Source | Commit |
|---|---|---|
| Omnigent | https://github.com/omnigent-ai/omnigent | `5f9d79cd2fdf7e25f03d8133334885693a231fd2` |
| qm | https://github.com/yc-software/qm | `ca4642fbcc517e7d5662efef6a420d17a9007464` |
| Orca | https://github.com/stablyai/orca | `9e52645e6cd8d6d110f37cd883b4b8987e99fbfd` |
| Munder Difflin | https://github.com/chaitanyagiri/munder-difflin | `241d1e593a28d30e7150fff2cc2de0e54c031a3b` |
| OpenClaw | https://github.com/openclaw/openclaw | `1aeab0fc15c2b5e9431d8cde386ae21546af6010` |
| Hermes Agent | https://github.com/NousResearch/hermes-agent | `ae3f9f9cb149a828ae61625bb9c84b7bae837a0f` |
| Pi | https://github.com/earendil-works/pi | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` |
| AdaL | https://github.com/SylphAI-Inc/adal-cli holds no CLI source; docs at https://docs.sylph.ai | `afe695a0e166767602ed705156aa65c8f02096ab` |

Cursor, Grok Bot and Muse are closed source: their rows rest on official docs only, and anything about internals that the docs do not state is marked inference. Doc pages were read on 2026-10-13. Every verified citation was re-opened by a second agent before this commit, and the fixes it found are applied.

### Omnigent

Source: github.com/omnigent-ai/omnigent at `5f9d79cd2fdf7e25f03d8133334885693a231fd2`. Links: `O/` = `https://github.com/omnigent-ai/omnigent/blob/5f9d79cd2fdf7e25f03d8133334885693a231fd2/`, `Q/` = `https://github.com/yc-software/qm/blob/ca4642fbcc517e7d5662efef6a420d17a9007464/`.

**Two separate systems.** The self-hosted sandbox has a "secretless credential proxy". The managed (hosted) product has a per-user credential store with a broker. They make opposite promises.

**(a) Secretless credential proxy.**
- Entry: `os_env.sandbox.credential_proxy` in the agent YAML; each entry names a type (`https_bearer`, `https_basic`, `git_https`, `gh_basic`, `databricks_cli`), a `target` host and a `source` (`{env}`, `{file}`, `{command}`) that the unsandboxed parent reads. O/designs/SANDBOX_CREDENTIAL_PROXY.md#L100-L117, O/docs/AGENT_YAML_SPEC.md#L481-L487. Broker-socket sources that refresh: O/docs/AGENT_YAML_SPEC.md#L515-L564.
- Mechanism: "The default model is **swap-on-access**: nothing credential-shaped enters the sandbox at all." The proxy adds `Authorization: <scheme> <real>` to a bound-host request that has no `Authorization` header. O/designs/SANDBOX_CREDENTIAL_PROXY.md#L22-L41; code O/omnigent/inner/egress/proxy.py#L1315-L1406 (the `elif host_rule is not None` branch at L1398-L1402).
- Placeholder opt-in for clients that refuse to send a request without a local token (`gh`): a random `oa_cred_` value per entry, "non-secret and bound to one host". O/designs/SANDBOX_CREDENTIAL_PROXY.md#L43-L52; minted at O/omnigent/inner/credential_proxy.py#L273.
- Leak guard: "A placeholder presented for a host it is not bound to (an exfiltration attempt) is rejected with HTTP 403." O/designs/SANDBOX_CREDENTIAL_PROXY.md#L54-L60; code O/omnigent/inner/egress/proxy.py#L1381-L1391.
- No clobbering: a client's own non-placeholder `Authorization` is forwarded and suppresses injection. O/omnigent/inner/egress/proxy.py#L1376-L1380.
- TRACE and OPTIONS never get the credential, because "TRACE would reflect the injected secret back into the sandbox". O/omnigent/inner/egress/proxy.py#L68-L76.
- It requires `egress_rules` and `linux_bwrap` or `darwin_seatbelt`, "because only those two backends can guarantee the MITM proxy is the *only* egress path". O/designs/SANDBOX_CREDENTIAL_PROXY.md#L92-L98. `gh_basic` and `databricks_cli` are rejected on macOS because Go there ignores `SSL_CERT_FILE`. O/designs/SANDBOX_CREDENTIAL_PROXY.md#L188-L190.
- Host binding only: "only the host binds the credential; path scoping is delegated to `egress_rules`". O/designs/SANDBOX_CREDENTIAL_PROXY.md#L111-L113.
- Responses: `_relay_response` streams upstream bytes to the client unchanged. O/omnigent/inner/egress/proxy.py#L1201-L1229.
- The docs also tell authors: "Do not pass secrets through the environment unless the tool genuinely needs them." O/docs/AGENT_YAML_SPEC.md#L459-L460.
- Inference on a gap: swap-on-access gives the credential to every request to the bound host, so a bound host that echoes request headers returns the value to the sandbox. No placeholder is needed for that. Reasoning: the proxy adds the header whenever none is present (L1398-L1402) and does not scrub responses (L1201-L1229).

**(b) Managed connections and broker.**
- Store: one `connections` table keyed by workspace, user, provider and account; the secret is a KMS ciphertext. O/designs/CREDENTIAL_STORE.md#L16-L20, O/designs/CREDENTIAL_STORE.md#L42-L54. Providers registered: `github`, `databricks`. O/omnigent/server/connections_registry.py#L57-L70.
- Broker: `GET /v1/hosts/{host_id}/credentials/{provider}`, authenticated by the sandbox's launch token. Its own docstring: "Any in-sandbox process that can reach this endpoint (it authenticates with the launch token baked into the sandbox) can obtain that credential for its TTL. So the trust boundary is the sandbox itself". O/omnigent/server/routes/host_credentials.py#L20-L28.
- git: a credential helper fetches the token per operation; `gh`: the token is written into `hosts.yml`. "Threat model: this removes the GitHub token from disk/env, not the ability of in-sandbox code to request one." O/omnigent/git_credential_github.py#L10-L33.
- MCP roadmap: route MCP through Databricks AI Gateway, with a short-lived token per connection from the broker. O/designs/CREDENTIAL_STORE.md#L234-L247.
- MCP today: `type: mcp` with `url` and `headers: {Authorization: Bearer ${TOKEN}}`. O/docs/AGENT_YAML_SPEC.md#L607-L616. Whether the model can read `TOKEN`: unknown (inference: it is an env var of the host process; the sandbox environment is not documented for this case).

**Redaction.** `redact_log_text` masks `Authorization` values, `token=`/`secret=` style pairs, known prefixes (`sk-`, `ghp_`, `xox*-`, `AIza`, `dapi`), JWTs and long mixed-case strings. O/omnigent/process_logging.py#L108-L176. Callers are log formatters and diagnostics (debug_logging.py, cli_diagnostics.py, harnesses/diagnostics.py). No caller on session transcripts found by grep (inference).

### qm

Source: github.com/yc-software/qm at `ca4642fbcc517e7d5662efef6a420d17a9007464` (`Q/` links, as above).

**Stance.** "the agent acts as the person it's working for, with their credentials and permissions, and everything it does is audited." Q/README.md#L110-L112. Known limitation: "Sandbox credentials are plaintext while in use. Credentials and capability tokens materialized as environment variables or files are readable by processes in that sandbox." Q/SECURITY.md#L146-L150.

**Entry and scope.**
- Credential record: owner, service, `kind` `env` | `file` | `broker`, optional host, encrypted secret. Q/src/credentials/keychain.ts#L26, Q/src/credentials/keychain.ts#L50-L60, Q/src/credentials/keychain.ts#L95-L115.
- Grants: a credential is shared to another scope (a room) by a grant with `mode` `once` or `standing`, a `purpose`, expiry and revocation. Q/src/credentials/keychain.ts#L122-L136. "Credential purposes are not enforced authorization ... The stated purpose travels with the credential as an instruction to the model and an audit field." Q/SECURITY.md#L151-L156.
- Secret drop: an agent mints a one-time link (only "on a turn a person sent") to a web form where the person types the value; it goes to the keychain, not the chat. TTL 7 days. Q/src/api/routes/secret-drop.ts#L18, Q/src/api/routes/secret-drop.ts#L394-L396, Q/src/credentials/secret-drop.ts#L39.
- CLI logins: the agent runs the native login in a temp HOME; a script uploads the files to `POST /v1/keychain/credentials`; "Secrets never enter model context." Later commands name the handle in `execute.credentials`. Q/docs/credential-refresh-handoff.md#L5-L13.
- Org service credentials: set by admins through the admin resources API. Q/src/api/routes/admin-resources.ts#L1176-L1183.

**Delivery.**
- env and file: the value is staged only for the command that names the handle; file bundles go to a private temp HOME and refreshed files are written back. Q/docs/credential-refresh-handoff.md#L19-L25. QA record: "An execution without selection saw the variable absent." Q/docs/qa/execution-credentials/README.md#L9-L13.
- broker: `POST /v1/credentials/broker` with `credential`, `url`, `method`, `headers`, `body`; the server adds the header and returns `{status, contentType, body}`. Q/src/api/credential-broker.ts#L120-L270. Agent instructions: "You are NOT given the secret (a shared bearer sitting in your shell could leak)." Q/skills-seed/use-shared-credential/SKILL.md#L6-L10.
- Broker checks: entitlement in the capability token (L100-L101); `https:` only (L181); host equals the pinned host or a subdomain (L53-L57, L182-L188); methods default `GET` (L192-L196); path prefixes, with `..` rejected (L59-L80, L197-L199); caller headers limited to `accept`, `accept-language`, `content-type`, `user-agent` (L49, L201-L205); `redirect: "manual"` (L27); optional `x-qm-actor` attestation (L162-L172, L209). All in Q/src/api/credential-broker.ts.
- The broker returns the upstream body as is, with no scrub of the secret (Q/src/api/credential-broker.ts#L238-L270).
- Published apps get a long-lived token for the broker; an admin can switch a credential off for apps. Q/docs/deploy-directory.md#L157-L178.

**Redaction.** `createExactSecretValueMasker` replaces exact values with `<redacted:credential>` (Q/src/security/secret-masking.ts#L47-L52) and is applied to a command's stdout and stderr (Q/src/tools/primitives.ts#L929-L933). `createSecretValueMasker` also matches URL-encoded and Base64 forms (Q/src/security/secret-masking.ts#L16-L33). QA: tool-result entries and the tape held the mask and no raw values; background-job polls after the start call are unmasked. Q/docs/qa/execution-credentials/README.md#L18, Q/docs/credential-refresh-handoff.md#L34-L35.

**Connectors.**
- OAuth connectors for Google, GitHub, Slack, Notion, Linear, Dropbox are keychain entries (`managed: "connector"`). Q/src/connectors/oauth.ts, Q/src/credentials/keychain.ts#L109. Consent links: Q/skills-seed/connect-apps/SKILL.md#L13-L27.
- MCP: `credentialScope` `shared` or `per-user`; "`credentialHost` explicitly authorizes sending that connector's user token to the registered server"; no fallback to another user's or the org's token. Q/docs/mcp-connectors.md#L6-L13, Q/docs/mcp-connectors.md#L38-L54.
- Composio: "Agent code never receives the project API key"; the generic broker rejects Composio hosts. Q/docs/composio.md#L3, Q/docs/composio.md#L15.

### Orca

Source: github.com/stablyai/orca at `9e52645e6cd8d6d110f37cd883b4b8987e99fbfd`; docs read as their source files in `docs/site/content/docs/`. Paths are file:line at that commit.

**1. Where secrets are entered, and scope.**
- Settings → Integrations lists GitHub OAuth, Linear API token, Jira, Bitbucket, MiniMax cookie and "MCP servers" (docs/site/content/docs/settings.mdx:88-95). Verified.
- GitHub goes through the `gh` CLI and its own login; agents call `gh` with the same account (docs/site/content/docs/github-errors.mdx:6, :23). Verified.
- Linear token: stored per Linear workspace at `~/.orca/linear-tokens/<id>.enc` (src/main/linear/linear-credential-paths.ts:24-31), encrypted with Electron safeStorage, and written in plaintext (mode 0600) with a warning when OS encryption is unavailable (src/main/linear/linear-token-store.ts:37-46). Verified.
- Jira: "encrypted via the OS keychain and stored locally" (docs/site/content/docs/review/jira.mdx:51-53). Bitbucket: `ORCA_BITBUCKET_*` env vars win over a saved credential; on a remote Orca server, set env vars there (docs/site/content/docs/settings.mdx:93). Verified.
- Per-agent-type env vars (`agentDefaultEnv`, keyed by agent such as Claude Code or Codex): the host editor shows names only and a password field "Saved value · enter to replace" (src/renderer/src/components/settings/HostAgentEnvironmentEditor.tsx:86-97; names-only projection at src/shared/agent-launch-settings.ts:51-55). Verified.
- GitHub: Orca can bind a GitHub account per project and gives a short-lived token only to its own `gh` child process, not to agents (src/main/github/gh-account-token.ts:1-5, src/main/git/command-runner/gh-exec-file.ts:49). Verified.
- Plugin secrets: a per-plugin safeStorage vault with no plaintext fallback (src/main/plugins/plugin-secrets-store.ts:11-17). Verified. Plugins, not agents, use it (inference from the class name and path).
- Project secrets: "Keep secrets in the ignored files they refer to" (docs/site/content/docs/model/orca-yaml.mdx:6); `.worktreeinclude` copies `.env` and similar gitignored files into each new worktree (docs/site/content/docs/model/worktrees.mdx:46). Verified.

**2. How the agent uses it.**
- Linear: "Agents can read and write Linear through `orca linear` (and the `orca-linear` skill)" (docs/site/content/docs/review/linear.mdx:35). The CLI calls runtime RPC `linear.mcpListIssues` and similar (src/cli/handlers/linear-list-issues.ts:40), and the runtime calls Linear with the stored token. Verified. This is an operation-level broker: fixed verbs, not a general HTTP proxy.
- Env vars: `agentDefaultEnv` goes into the agent launch env (src/shared/agent-startup-plan-inputs.ts:81, src/shared/tui-agent-startup.ts:92). Verified. Plain env var.
- I found no egress proxy or placeholder substitution in `src/` (a search for egress, injection and placeholder terms hit browser routing, SSH and login-session code, none about secrets). Inference: absence from a keyword search.

**3. Can the agent or model read the value?**
- Env vars: yes, they are in the agent process env. Also, RPC `settings.get` has permission `workspace` (src/main/runtime/rpc/methods/client-ui.ts:32-36) and returns `agentDefaultEnv` with values (src/main/runtime/runtime-client-settings.ts:59). So the write-only editor is a UI property only. Verified.
- Integration tokens: no RPC method returns the Linear token (method list in src/main/runtime/rpc/methods/linear.ts; `linear.connect` takes a key and needs `accounts-admin`, line 25-28). Verified for that file. But Orca states that a `workspace` caller "can run code as this host's user" and that changing launch env is "not a boundary" for it (src/main/runtime/rpc/rpc-method-permission.ts:7-9), and that an unstamped call is "this host's own desktop or owner-token CLI" with every permission (src/main/runtime/rpc/rpc-caller-scope.ts:4-5, :54-55). Verified. Inference: an agent running as the same user can read the encrypted file and, with keychain access, decrypt it; Orca does not claim otherwise.
- Computer use docs tell agents to pass secrets through stdin, and say this "does not hide them from every local observer" (docs/site/content/docs/cli/computer-use.mdx:85-94). Verified.

**4. Host binding.**
- Linear token per Linear workspace (paths above); Jira credentials "only used to call your configured Jira site" (jira.mdx:52-53). Verified. These follow from the built-in clients, not from a user-set host list.
- Env vars have no host binding; they apply to every launch of that agent type on that host (inference from the `agentDefaultEnv[agent]` shape at src/shared/agent-launch-settings.ts:110).

**5. Redaction.**
- Worker transcripts read through orchestration: only Orca's own dispatch capability tokens (`dcap_…`) are replaced (src/main/runtime/orchestration/worker-transcript-payload.ts:18-19, :282-300). Verified.
- Error telemetry: a redactor for labeled key=value, provider key shapes, JWT, PEM and URL userinfo (src/main/observability/redactor.ts:1-40). Verified. It covers the error-tracking lane, not agent transcripts (its header comment, line 1-3).
- MCP settings view masks env values whose key or value looks sensitive as `••••••••` (src/shared/mcp-server-inspection.ts:84-86). Verified.
- `config/scripts/pty-transcript-secret-scan.mjs` scrubs captured PTY transcripts before they are committed as test evidence (line 1). Verified; developer tooling, not a product feature.

**6. Connectors.** Built-in integrations (Linear, Jira, Bitbucket, GitHub via `gh`) are clients inside the Orca runtime; agents reach Linear through CLI verbs that mirror Linear MCP semantics (docs/site/content/docs/cli/reference.mdx:282-315). MCP servers stay in the agents' own config files (`workspace`, `cursor`, `claude` formats, src/shared/mcp-config.ts:10); Orca inspects them and offers a starter file, with secrets in those files. Verified.

### Munder Difflin

Source: github.com/chaitanyagiri/munder-difflin at `241d1e593a28d30e7150fff2cc2de0e54c031a3b`. Paths are file:line at that commit.

**1. Where secrets are entered, and scope.**
- Settings → Integrations registry: the member picks a template (GitHub, Linear, Jira, Notion, Stripe, Confluence, Sentry, HubSpot) or a custom REST API, sets `baseUrl`, auth type (`none`, `bearer`, `header`, `github`) and pastes a secret (src/shared/integrations.ts:24-60, :239-338; UI in src/renderer/src/components/IntegrationsRegistry.tsx). Verified. App-wide scope: one registry per install.
- Secrets are write-only: IPC `integrations:setSecret` stores, `integrations:list` returns records with only `hasSecret` (src/main/index.ts:3138-3146; src/main/integrations.ts:78-80). Stored in `<userData>/integration-secrets.json`, mode 0600, encrypted with Electron safeStorage, refusing to store when encryption is unavailable (src/main/integrations.ts:85, :102, :107-123). Verified.
- BYOK model-provider keys (Anthropic, OpenAI, Gemini, OpenRouter, Groq) use the same encrypted store under `apikey:<backend>` (src/main/index.ts:395-406, :3154-3170). Verified.
- Slack signing secret, Slack bot token and the Groq dictation key sit in `config.json` (src/main/config.ts:331-333, :350-353), which is written as plain JSON (src/main/config.ts:650). Verified.
- README mentions "custom secrets stored encrypted beside your provider keys" (README.md:336-337). I found no separate custom-secrets code at this commit (searched for "custom secret" and "customSecret"). Inference: the phrase means custom REST integrations.

**2. How the agent uses it.**
- Integrations: a loopback broker on 127.0.0.1 (src/main/integrationBroker.ts:1-24, :103). At spawn, each ephemeral worker gets `MD_BROKER_URL` and `MD_BROKER_TOKEN`, a random per-worker capability (src/main/index.ts:4763-4767; src/main/integrationBroker.ts:129-135). The worker calls `http://127.0.0.1:<port>/i/<integrationId>/<path>`; the broker checks the token, checks the integration is enabled, confines the path under `baseUrl`, decrypts the secret, sets the auth header, and forwards with `redirect: 'manual'` (src/main/integrationBroker.ts:172-209, :244-259). Worker-supplied `authorization` and `cookie` headers are stripped (src/main/integrationBroker.ts:46-48). The token is revoked at teardown and on a failed spawn (src/main/index.ts:452, :4780). Verified.
- Agents learn this from a bundled skill: "You call the broker; it holds the credentials" (resources/skills/capabilities/SKILL.md:68-74). Verified.
- The same pattern existed first for Slack replies: a loopback reply server posts "WITHOUT ever seeing the bot token" (src/main/slack.ts:416-422). Verified.
- BYOK keys: written into the env of OpenCode, Crush, pi and qwen agents at spawn, only the key for the model's provider when the prefix is known, else all stored keys (src/main/index.ts:2969-2988). Verified. Plain env var.
- Only workers spawned through spawn-requests get a broker grant; the grant code is in that path only (src/main/index.ts:4763). Verified. Inference: regular desk agents have no broker access.

**3. Can the agent or model read the value?**
- Integration secrets: not in the worker env or transcript; the token is "a handle, never a secret" (src/main/index.ts:4757-4761). Verified. But the encrypted file is in the same user's `userData`, and the agent runs as that user. Inference: on Linux without a keyring, Electron safeStorage falls back to a fixed key, so a same-user agent could decrypt it; on macOS the keychain item gates it. Not checked in Electron source.
- Inference: a worker can read another live worker's `MD_BROKER_TOKEN` from `/proc/<pid>/environ` (same uid), but every grant holds the same set (below), so this gives nothing new.
- BYOK keys: yes, `printenv` shows them (they are env vars; see above).

**4. Host binding and who may use it.**
- Each integration binds its secret to one `baseUrl` (https, or http only for loopback; no userinfo, query or `..`) (src/shared/integrations.ts:151-167), and the broker refuses paths that leave that origin and base path (src/shared/integrations.ts:204-236). The member picks the header form, so a secret goes only in that header to that origin. Verified.
- Who: every spawned worker gets all enabled integrations that hold a secret (`integrations.enabledIds()`, src/main/integrations.ts:45-49, used at src/main/index.ts:4764). No per-worker or per-objective selection. Verified.

**5. Redaction.**
- `redactSecrets` (provider key shapes, JWT, PEM, bearer, labeled key=value) (src/main/hive.ts:275-302) is used on hive message subjects and bodies sent to the voice layer only (src/main/hive.ts:2057-2058, the only call site). Verified.
- The broker does not scrub the secret from upstream responses; it strips only `set-cookie` and hop-by-hop headers (src/main/integrationBroker.ts:51-53). It has no log statements (zero `console.` calls in the file), so the bundled skill's word "auditable" has no audit log behind it at this commit. Verified.

**6. Connectors.** The integrations registry is Munder Difflin's connector layer: REST only, no OAuth; Gmail, Google Calendar and Salesforce wait for an OAuth broker (src/shared/integrations.ts:262-265; hive/docs/integration-templates.md:41-53). The contract file it names, `hive/docs/integrations-spec.md`, is not in the repo. Separately, an MCP catalog has a "secret" tier (GitHub, Postgres, GSuite, Brave), off by default; entries carry empty env values such as `GITHUB_PERSONAL_ACCESS_TOKEN: ''` (src/shared/mcpCatalog.ts:109-150), and the catalog env is copied as is into the agent's settings (src/main/hive.ts:1334-1338). Verified. Inference: Munder Difflin does not fill these from the encrypted store, so the member must supply them some other way.

### OpenClaw

Source: github.com/openclaw/openclaw at `1aeab0fc15c2b5e9431d8cde386ae21546af6010`; docs/ paths are the source of https://docs.openclaw.ai.

Product link: "Related projects" in site/about.html links https://github.com/openclaw/openclaw.

The Appendix B entry still holds: an opt-in egress proxy that swaps placeholders for bound hosts. Its citation (docs.openclaw.ai/gateway/secrets/secret-store-and-egress) loads and says so. Appendix A.7 ("swap anywhere: headers, URLs and bodies") also holds: verified, docs/gateway/secrets/secret-store-and-egress.md:55 ("replaces it in request URLs, headers, and streamed bodies"), and src/secrets/egress-proxy/proxy-server.ts:159-197 (`substituteRequest` swaps every header and the URL; body swap is in stream-substitution.ts). WebSocket message frames are not swapped, only the handshake URL and headers (secret-store-and-egress.md:148).

1. Entry and scope. Verified, docs/gateway/secrets/secret-store-and-egress.md:14: "Gateway-wide, team-scoped … Manage it from Settings → Secrets in the Control UI or locally with `openclaw secrets store`." Verified, :152: "Identity-scoped secrets are not supported; only the team store participates." Agent-initiated entry: verified, docs/tools/secrets.md:10-12, :30-31 and :54 (`request` asks the human in a masked prompt; protected secrets only) and :48 ("no action that writes a value the agent supplies"). The prompt shows an editable list of allowed hosts the agent proposed: verified, docs/tools/secrets.md:58. Values are not encrypted at rest (SQLite, 0600): verified, secret-store-and-egress.md:49-51.
2. Use. Verified, secret-store-and-egress.md:18-19 (two kinds: `secret` write-only and inert until a SecretRef or the egress proxy uses it; `env` added as plaintext to Gateway-hosted exec), :23 (secrets never injected into subprocess environments by default), :55 and :87 (sentinel `oc-sent-v2…end` in the environment, loopback proxy swaps it), :67-71 (proxy enabled explicitly, Gateway restart), :103-108 (it sets `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`: the CA variables of our section 2.3 except `CARGO_HTTP_CAINFO`). Per-process proxy credentials and grants, revoked on exit: verified, :110-114. `bypassHosts` for certificate-pinned clients as blind tunnels: verified, :132. Only Gateway-hosted exec: sandbox exec, remote node exec and provider-native harnesses (Codex shell, Claude Code via ACP) get neither proxy nor sentinels: verified, :21 and :155. Model provider keys get an in-process sentinel too: verified, docs/gateway/secrets/runtime-model.md:40.
3. Readable? `env`: yes, verified, secret-store-and-egress.md:19 ("The agent can print, transmit, or persist these values"). `secret`: no for the value, verified, :18 (no reveal RPC) and :87 (sentinel in the environment). Same-process caveat for model keys: verified, runtime-model.md:49 ("not process isolation").
4. Hosts and users. Verified, secret-store-and-egress.md:59 (exact hostnames, no wildcards or ports, none = never substituted), :87 (refusal names the secret and prints the exact `--allow-host` command), :114 (sentinel bound to another host is refused before plaintext is forwarded), :117 (binding does not make a host trustworthy; reflecting hosts and DNS are out of scope). Who: any Gateway-hosted exec process, since the store is team-wide (:14, :152). Optional traffic allowlist for non-secret traffic: verified, :136-144.
5. Redaction. Verified, runtime-model.md:42 ("Resolved secret values are also registered for exact-value log redaction"). Verified, docs/logging.md:1097-1100 (raw file logs, masked on read and export) and :1111 ("Tool arguments and results are not secret-masked", including session transcripts). Verified, runtime-model.md:55 ("Tool results and transcripts do not secret-mask that content"). Inference: the proxy does not scrub response bodies: `grep -i 'scrub\|redact'` over src/secrets/egress-proxy/ finds nothing, response-headers.ts only re-encodes Content-Disposition, and the doc warns that a reflecting host "can still return the plaintext to the agent" (:117).
6. Integrations. Verified, docs/gateway/secrets/integration-examples.md:240 and :269 (MCP server env vars under `plugins.entries.acpx.config.mcpServers` take SecretRefs, resolved "before the MCP server process spawns", so the MCP process holds the plain value). SecretRef for model providers: secret-store-and-egress.md:29-41. OAuth and auth-profile credentials are not supported by the Crabbox credential path: verified, :179-181.

### Hermes Agent

Source: github.com/NousResearch/hermes-agent at `ae3f9f9cb149a828ae61625bb9c84b7bae837a0f`; docs at https://hermes-agent.nousresearch.com/docs/, whose source is `website/docs/`. Paths are file:line at that commit.

1. **Entry and scope.**
- Verified: keys live in `~/.hermes/.env`; secret sources pull keys "from external secret managers at process startup instead of storing them in `~/.hermes/.env`", with Bitwarden, 1Password and a command helper bundled, more as plugins. https://hermes-agent.nousresearch.com/docs/user-guide/secrets (website/docs/user-guide/secrets/index.md:3-9, :50-54).
- Verified: a skill declares `required_environment_variables`; "Hermes prompts for them securely when the skill is loaded in the local CLI"; gateway and messaging sessions do not collect secrets in band; values are stored in `~/.hermes/.env`. https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills (website/docs/developer-guide/creating-skills.md:166-178, :236).
- Verified: scope is the profile. Under a multi-profile gateway, "A profile's declared value never reaches another profile's children" (secrets/index.md:48); agent/secret_scope.py:1-10 holds each profile's secrets in a context variable and fails closed when no scope is set.
- Verified: "Managed scope" lets an administrator pin config and secrets that a non-root user cannot override. https://hermes-agent.nousresearch.com/docs/user-guide/managed-scope (website/docs/user-guide/managed-scope.md:8-17).
- Verified: a separate encrypted browser vault. `hermes vault add` reads the password with getpass, never as argv (hermes_cli/vault.py:1-15); payload encrypted with a local Fernet key in `<HERMES_HOME>/vault/`, files 0600 (agent/vault_store.py:1-12).

2. **How the agent uses it.**
- Verified: "Terminal commands, `execute_code` sandboxes and `no_agent` cron scripts run with a sanitized environment: Hermes-managed credentials are stripped, and only variables you declare in `terminal.env_passthrough` (or a loaded skill's `required_environment_variables`) are forwarded ... Provider credentials cannot be declared" (secrets/index.md:48). Per-sandbox filter table: https://hermes-agent.nousresearch.com/docs/user-guide/security (website/docs/user-guide/security.md:679-688): execute_code blocks names with KEY, TOKEN, SECRET and similar; local terminal blocks Hermes infrastructure vars; Docker, SSH and Modal get no host env by default.
- Verified: a declared variable reaches the child as a plain env var (security.md:604-626; tools/environments/local.py:242-307 builds the child env, with the passthrough check at :267-273).
- Verified: `browser_vault` `fill` is "server-side fill of the CURRENT page from a vault handle"; the tool result reports only `{filled_fields, kind, origin, success}` (tools/browser_vault_tool.py:1-22). Design credited to Merit-Systems/OpenInstinct (MIT).

3. **Can the agent read the value?**
- Verified: the docs claim "Hermes never exposes the raw secret value to the model" (creating-skills.md:178).
- Inference: for a declared variable the child process holds the value, so `echo $NAME` prints it; only the output redaction (item 5) stands between it and the model, and a transform such as base64 defeats regex redaction.
- Verified: file tools refuse to read Hermes secret stores (`.env`, `mcp-tokens/`, `vault/`, Bitwarden cache) and any project `.env` (security.md:363, :366). Inference: the local terminal runs as the same OS user, so `cat ~/.hermes/.env` still runs; its output gets the env-file redaction pass (agent/redact.py:1173-1187, `_command_reads_secret_file`). I found no approval rule for reading that file on POSIX (tools/approval_detection.py:285 covers only the Windows path); there are approval rules for uploading a secret variable or credential file with curl or wget (tools/approval_detection.py:339-345).
- Verified: vault passwords never enter tool results, logs or the session DB, and their exact bytes are registered for scrubbing before the fill (browser_vault_tool.py:13-20, :519-525). Inference: the password sits in the page DOM after the fill, so page JavaScript can still send it elsewhere; the scrub covers only what returns to the model.

4. **Tied to hosts?**
- Verified: the refusal text says "Vault fills only run on the exact origin(s) the credential was saved for" (browser_vault_tool.py:474-475): exact origin, no parent-domain inference; checked before the fill and again inside the fill script (browser_vault_tool.py:450-476, :13-14). Payment cards need a human confirmation; headless sessions refuse (browser_vault_tool.py:447-449, :571-581).
- Verified: env secrets have no host binding; the boundary is which processes get them (declared names, per profile), as in item 2.

5. **Redaction.**
- Verified: regex redaction of tool output and logs, on by default; the flag is read at import so a model-run `export HERMES_REDACT_SECRETS=false` cannot turn it off mid-session (agent/redact.py:89-97). Terminal output goes through `redact_terminal_output` (tools/terminal_tool_result.py:231-242); code output too (tools/code_execution_tool.py:519-521); log files use `RedactingFormatter` (hermes_logging.py:365-382, :409-417).
- Verified: patterns cover vendor prefixes, auth headers, JWTs, private keys, `KEY=value` dumps; short tokens fully masked, long ones keep the first 6 and last 4 characters (agent/redact.py:1-4; patterns at :138-141, :212-221, :496-500, :515, :548-549).
- Verified: exact-value scrubbing exists only for vault values, kept in memory per profile, at most 64 (agent/redact.py:20-35).
- Verified: MCP tool error messages are redacted before they reach the model (security.md:723-730).

6. **Connectors.**
- Verified: MCP stdio servers receive only `PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR`, `XDG_*`, and the server's own `env` map; skill passthrough does not apply (security.md:698-722, :688).
- Verified: catalog entries with an API key prompt at install and write the value to `~/.hermes/.env`; remote MCP OAuth tokens are cached at `~/.hermes/mcp-tokens/<server>.json`, 0600, and a refresh token is dropped if the server's authorization server changes. https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp (website/docs/user-guide/features/mcp.md:122-127, :376-378).
- Verified: OAuth-file skills (for example Google Workspace) declare `required_credential_files`, mounted read-only into Docker (security.md:639-666).

### Pi

Source: github.com/earendil-works/pi at `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` (site/about.html links pi.dev, which links this repo); docs at https://pi.dev/docs/latest/. Paths are relative to `packages/` at that commit.

Pi has no secrets feature for tools. Its security page says it has no built-in boundary and tells the member to isolate it.

1. **Entry and scope.**
- Verified: `/login` saves an API key or OAuth credential in `auth.json`; environment variables such as `ANTHROPIC_API_KEY` also work; a `key` of `!command` runs a secret-manager command when first needed and caches its output for the process lifetime. https://pi.dev/docs/latest/providers (coding-agent/docs/providers.md:10-29, :71-84). `auth.json` is in the agent directory, default `~/.pi/agent` (coding-agent/docs/configuration.md:3-17), written with mode 0600 (coding-agent/src/core/auth-storage.ts:37).
- Inference: scope is the OS user (one agent directory). Project `.pi/` settings and MCP servers load only after project trust (coding-agent/docs/security.md:27-55).

2. **How the agent uses it.**
- Verified: provider keys are for Pi's own model calls. The bash tool spawns with `env ?? getShellEnv()` (coding-agent/src/core/tools/bash.ts:115), and `getShellEnv` returns `{...process.env, PATH}` (coding-agent/src/utils/shell.ts:138-149), so every variable of the Pi process reaches agent commands.

3. **Can the agent read the value?**
- Verified: yes for env vars (item 2). Verified: "Pi can read, change, and execute files with the permissions of the account that started it", and "Watching the transcript, using project trust, and reviewing changes do not create a security boundary." https://pi.dev/docs/latest/security (coding-agent/docs/security.md:3, :7).
- Inference: `auth.json` and `mcp-auth.json` are readable by the read tool and bash; a grep of coding-agent/src/core/tools/ for those names finds no deny rule.
- Verified: the isolation page states that with the Gondolin micro-VM "Commands inside the VM inherit the host process environment", so it is no credential boundary unless sensitive variables are removed. https://pi.dev/docs/latest/containerization (coding-agent/docs/containerization.md:155-157).

4. **Tied to hosts?** Verified: no such feature in Pi. The containerization page sends members to Docker Sandboxes, where "The sandbox receives an OAuth-shaped placeholder, which the proxy replaces only for requests to the configured host", and warns not to run `/login` inside the sandbox (containerization.md:12, :84-103).

5. **Redaction.**
- Verified: none in transcripts or logs. The docs: review sessions before sharing, as they "can contain ... credentials exposed during the conversation" (security.md:93).
- Verified: the only credential redaction in source is the bug-report export: sensitive JSON keys and URL query parameters become `<redacted>` (coding-agent/src/core/bug-report.ts:19-56). A grep of packages/ for "redact" finds otherwise only redacted-thinking handling. The `diagnostics` field is commented "Redacted provider/runtime diagnostics" (ai/src/types.ts:577), but ai/src/utils/diagnostics.ts has no redaction code.

6. **Connectors.**
- Verified: MCP remote OAuth: Pi registers itself, stores tokens in `~/.pi/agent/mcp-auth.json`, refreshes them; credentials belong to a server name and URL. `env` and header values may use `${VAR}` or a whole-value `!command`; `--bearer-token-env-var` names a variable for a bearer token. https://pi.dev/docs/latest/mcp (coding-agent/docs/mcp.md:18, :81, :117-131). Credentialed servers belong in the user-level file, not the project file (mcp.md:73).
- Verified: Pi Durable can run tools on a remote machine "while the Durable worker, its storage and credentials stay local" (env/README.md:3-4). This is an execution split, not a secret feature.

### AdaL

Sources. site/about.html links AdaL to https://github.com/SylphAI-Inc/adal-cli. I cloned it at commit afe695a0e166767602ed705156aa65c8f02096ab (2026-09-22). It holds only a README, assets and hackathon pages: the CLI source is not public (`git ls-files` lists 19 files, no code). So every AdaL answer comes from the official docs that the README links, https://docs.sylph.ai, read through https://docs.sylph.ai/llms-full.txt on 2026-10-13. I matched each quote below to the page named in the `URL:` header of its section.

1. Where the member enters a secret.
- verified: there is no general secrets feature. The docs index (https://docs.sylph.ai/llms.txt) has no secrets page, and a search of llms-full.txt for "secret", "vault", "redact" finds no store for agent secrets.
- verified, model provider keys: `/byoak add <provider> <key>`; "Keys, and any endpoint URL, are stored on your machine in `~/.adal/settings.json`." Scope is per provider on one machine. https://docs.sylph.ai/customize/bring-your-own-api-key
- verified, MCP API-key servers: "Set token BEFORE starting AdaL / export GITHUB_TOKEN=..." and "AdaL reads env vars (`GITHUB_TOKEN`, etc.) at startup"; custom servers take `--env "KEY=value"` and `--header "Authorization:Bearer ${TOKEN}"`; the docs suggest `echo 'export GITHUB_TOKEN="xxx"' >> ~/.zshrc`. https://docs.sylph.ai/features/mcp-support-proposed
- verified, connectors: OAuth in the browser, or for Firecrawl, Exa, Tavily, Apollo, PostHog and 1Password "The page that opens asks you to paste a key"; "The connection list is per AdaL account, so the same accounts show up on every surface you sign in from." https://docs.sylph.ai/features/connectors
- verified, project files: worktrees copy `.env`, `.env.*`, `.env.local`, `.env.*.local` by default, and the example config adds `config/secrets.json`. https://docs.sylph.ai/features/worktrees. Scheduled tasks: "That folder's `AGENTS.md` and `.env` apply". https://docs.sylph.ai/features/scheduled-tasks
- verified, sign-in: `~/.adal/adal_oauth_creds.json`, and the SDK docs print its `access_token` with `cat ... | python3 -c ...`. https://docs.sylph.ai/integration/sdk/quickstart. ChatGPT OAuth tokens: `~/.adal/openai_oauth.json`. https://docs.sylph.ai/customize/chatgpt-subscription

2. How the agent uses it.
- inference: plain env vars and plain files. The agent runs shell commands as the member (https://docs.sylph.ai/getting-started/how-adal-works: "run shell commands"; hooks "run with your user account and inherited environment", https://docs.sylph.ai/customize/lifecycle-hooks), so the values above are in its reach. No proxy, placeholder or broker for them is documented.
- verified, connectors are a broker: "Two tools are always available to the agent once an account is connected: `connector_discover` ... `connector_execute` — runs one action on one account you chose. Always asks for approval first." https://docs.sylph.ai/features/connectors

3. Can the agent read the value?
- inference: yes for env vars, `.env` files and `~/.adal/*.json`. The agent has a shell as the same user, and the docs themselves show `echo $GITHUB_TOKEN` and a `cat` of the credentials file.
- inference: no for connector tokens. The docs say the key "goes to that page, not to AdaL", and the agent only gets the two connector tools. I could not check where the token lives, because the source is closed.
- inference: a 1Password connector (service account token) lets `connector_execute` run 1Password actions, so item values can come back to the model as tool results. The docs do not say which 1Password actions exist.

4. Hosts and who may use.
- verified: "A key is used only for requests to its provider — or to your endpoint when you set one." https://docs.sylph.ai/customize/bring-your-own-api-key. This is AdaL's own client; the agent's shell is not limited by it.
- verified: connectors are per AdaL account; several accounts per service; each action names one account. https://docs.sylph.ai/features/connectors
- inference: env vars and `.env` values have no host binding; any process can send them anywhere.

5. Redaction.
- verified: "The dialog shows keys masked (`sk-ant...gAA`)" and the BYOAK key "is not logged". https://docs.sylph.ai/customize/bring-your-own-api-key
- verified (absence): no transcript or tool-output redaction is documented. The only redaction in llms-full.txt is in what goes to the completion-check service: "Some recognizable credential formats are redacted, but this does not remove all possible secrets or personal information." https://docs.sylph.ai/getting-started/completion-checks

6. Connectors and integrations.
- verified: the connector catalog (Google, Slack, GitHub, Stripe, 1Password and others) is served by AdaL's backend ("The list is served by AdaL's backend, not built into the app"). Inference: the tokens are held there too, since connections follow the AdaL account to every surface; the source is closed. Connectors use OAuth with every permission the service offers, and "Disconnecting ... does not revoke the provider's authorization". https://docs.sylph.ai/features/connectors
- verified: MCP OAuth tokens are local files: "Token storage: `~/.adal/mcp-auth/`". https://docs.sylph.ai/features/mcp-support-proposed
- inference: so AdaL has two paths for the same service (a connector held by the backend, or a local MCP server with a local token), and only the first keeps the token away from the agent's shell.

### Cursor

Sources. site/about.html links Cursor only to https://cursor.com/blog/joining-spacex. I used the official docs at https://cursor.com/docs, through the Markdown pages listed in https://cursor.com/llms.txt (fetched 2026-10-13). The HTML pages answer 403 to curl (bot block), so I cite the `.md` URLs that I read. Cursor's client is closed source; no source was read.

1. Where the member enters a secret.
- verified: "The easiest way to manage secrets is through cursor.com ... These are exposed to the cloud agent as environment variables." Environment-scoped secrets "are not available to other environments". https://cursor.com/docs/cloud-agent/setup.md (section "Environment variables and secrets")
- verified: Secrets API with team, user and environment scopes; "Responses never include values. They list names, types, and repositories"; each version has `repos`, "The only repositories that get this version". Precedence: "values passed when the agent starts, such as `envVars` ... then the environment's secrets, then the user's personal secrets, then the team's secrets. A name set at one level hides that name at every level below it." https://cursor.com/docs/cloud-agent/api/endpoints.md (section "Secrets")
- verified: per-run `envVars`: "Session-scoped environment variables ... injected into the agent's shell, and deleted with the agent." Same page, "Create An Agent".
- verified: local agent: no secrets store in the docs index; "Cursor already ignores `.env` files, `.git/`, and lock files by default." https://cursor.com/help/customization/ignore-files.md. Default list includes `**/.env`, `**/.env.*`, `**/credentials.json`, `**/secrets.json`. https://cursor.com/docs/reference/ignore-file.md

2. How the agent uses it.
- verified: three types. "Environment Variable" is "visible to the cloud agent"; "Runtime Secret" values "are still loaded as environment variables, but their contents are redacted ... and replaced with the placeholder string `[REDACTED]`" ("Previously, Runtime Secrets were called Redacted Secrets"); "Build Secret" is "only available to the Docker build process ... and are not exposed to the running agent's environment", used through a Docker secret mount. https://cursor.com/docs/cloud-agent/security-network.md (section "Secret protection")
- verified: OIDC: "The agent mints a token over the Unix socket at the path in `CURSOR_AGENT_SOCKET`"; "Cursor signs an RS256 JWT bound to that agent and owner"; "Tokens are valid for 5 minutes"; "Cursor doesn't allowlist audiences." https://cursor.com/docs/cloud-agent/identity.md
- verified: AWS: a secret `CURSOR_AWS_ASSUME_IAM_ROLE_ARN`; "Cursor assumes the role with STS credentials that expire after 1 hour" and the AWS CLI and SDKs pick up the profile. https://cursor.com/docs/cloud-agent/setup.md (section "Using AWS IAM Roles")
- verified: self-hosted workers get secrets "as environment variables" only with `--sync-dashboard-secrets` and an admin's "Secret sync". https://cursor.com/docs/cloud-agent/self-hosted.md

3. Can the agent or model read the value?
- verified: Environment Variable type: yes ("visible to the cloud agent"). Runtime Secret: Cursor says the values are "stripped from the transcript, tool output, and commits and never reach the model" (https://cursor.com/docs/cloud-agent/security.md, "Redacted runtime secrets"), and also "they are still visible to users interacting with the agent's environment via the Terminal" (security-network.md).
- inference: a Runtime Secret is still readable by the agent's processes, because it is a plain env var in a VM where commands auto-run. Redaction of output hides the exact string; an encoded copy (base64, split) or a `curl` that sends it to another host is not stopped by redaction. The docs do not say which encodings the redaction knows. So for the threat model of isomux secrets-design (section 2), a Runtime Secret is redaction, not secrecy, like GitHub Actions masking in Appendix B.
- verified: OIDC tokens are readable by the agent but expire in 5 minutes (identity.md).

4. Hosts and who may use.
- verified: secrets are tied to scope and repos, not to hosts (`repos` field, endpoints.md). No per-secret host list is documented.
- verified: "When your team lets only admins change secrets, only team admins can set a team environment's secrets"; any member can list names. endpoints.md ("Set An Environment Secret", "List Team Secrets"). A team admin's own API key also lists "the other members' personal secrets" (names only). endpoints.md ("List Secrets").
- verified: egress control is per user, team or environment ("Default + allowlist", "Allowlist only"), not per secret. security-network.md ("Network access").

5. Redaction.
- verified: Runtime Secrets are redacted "from the agent's tool call results, chat transcript, commits, and commit messages". security-network.md.
- verified: MCP config "Sensitive fields are redacted and cannot be read back by any user after saving": `env`, `headers`, `CLIENT_SECRET`. https://cursor.com/docs/cloud-agent/capabilities.md ("Custom MCP servers")
- verified: the docs admit limits elsewhere: "Terminal commands and MCP tools run outside of Cursor's file access controls, so they may still be able to read ignored files" (help ignore-files.md), and "complete protection isn't guaranteed due to LLM unpredictability" (reference ignore-file.md).

6. Connectors and integrations.
- verified: "HTTP (recommended) — server configurations are never present in the cloud agent's VM environment. The agent does not have access to refresh tokens, headers, or other credentials. Tool calls are proxied through the backend." "Stdio — servers run inside the cloud agent's VM, so the agent has access to the server's configuration and environment variables." "OAuth is per-user, including for MCP servers shared at the team level." capabilities.md
- verified: in local `mcp.json`, credentials come from `${env:NAME}` interpolation or `envFile` (stdio only); static OAuth `CLIENT_ID`/`CLIENT_SECRET` may be set. https://cursor.com/docs/mcp.md
- verified: hooks can "Scan for PII or secrets", and 1Password ships a hooks integration that checks that "environment files from 1Password Environments are properly mounted before shell commands execute". https://cursor.com/docs/hooks.md ("Secrets management")
- Out of my scope but on cursor.com: Grok Bot has write-only secrets ("Saved values are write-only") and a secure card that fills a value into a web page while "Secret values were never shown to your Bot". https://cursor.com/help/grok-bot/secrets.md. Whoever covers Grok Bot should read it.

### Grok Bot

Sources. site/about.html links Grok Bot to https://x.ai/news/introducing-grok-bot. That page has no secrets content. The product is operated by Cursor ("The Grok Bot desktop and mobile apps send each request to Cursor's servers", cursor.com/docs/grok-bot/security.md:16), and its docs exist twice: on cursor.com (raw Markdown, `.md` URLs from https://cursor.com/llms.txt) and on docs.x.ai/grok-bot/ (HTML). The source is not public. I read both doc sets with curl on 2026-10-13; line numbers below are in the `.md` files as served on that date. Where the two sets differ, I say so.

1. Where the member enters a secret.
- verified, secure card: "Use the **secure secret card** when a Bot asks for one. The field is masked. Choose **Save securely**. ... The value is not written into the chat." https://cursor.com/help/grok-bot/secrets.md:7. "Secrets you save are yours." secrets.md:13.
- verified, Team Bot panel: "Open **Secrets**, choose **Add secret**, enter an environment variable name, a short description, and the value ... The description is visible to the Bot. The value is not." secrets.md:9. Write-only: "Saved values are write-only", with **Replace** to change. secrets.md:17-21. Limits: "A Team Bot holds up to 25 secrets. Each value is at least 8 characters, so it can be redacted reliably, and at most 4,096 bytes." https://docs.x.ai/grok-bot/team-bots#secrets. "Only the owner and the Bot's managers can change this setup" (https://docs.x.ai/grok-bot/team-bots); the cursor.com copy says "Only the owner can change a Team Bot." (https://cursor.com/help/grok-bot/team-bots.md:101), so the two doc sets differ here; "When the Bot needs a key it doesn't have, it sends a secret request in the owner's or a manager's own chat" (docs.x.ai team-bots#secrets).
- verified, Team Secrets (Enterprise): "Team-wide values that Team Setup scripts read as environment variables ... each secret is an environment variable name and a value. Cursor stores the value encrypted, and the dashboard never shows it again". https://cursor.com/docs/grok-bot/teams.md:157. Dashboard only, not the Admin API: teams.md:167.
- verified, logins: "The Bot hands you the computer for passwords, passkeys, two-factor codes, CAPTCHAs ... The Bot doesn't type credentials and doesn't see your password, and the signed-in session persists for future tasks, shared across your Bots." https://cursor.com/docs/grok-bot/work.md:116. For web forms the Bot "can show a form in the chat, one form per step, and fill your answers into the page" (https://docs.x.ai/grok-bot/approvals-security-and-privacy, section "Enter passwords and verification codes yourself").
- verified, scope of the computer: "One persistent Firecracker microVM per user. Every Bot that user runs shares that computer." teams.md:51.

2. How the agent uses it.
- verified: "It uses a secret by name, and the value is replaced with [REDACTED] in the output of the commands it runs, the files it reads, and its plugin calls." docs.x.ai/grok-bot/team-bots#secrets. "Add a secret when a plugin or a script the Bot runs needs a key that has no plugin sign-in." (same section).
- inference: the value reaches the commands as a plain environment variable and the protection is output masking. Reasons: names must be env var names, the 8-character minimum exists "so it can be redacted reliably", and a custom Command MCP server "that needs environment variables ... runs only in your own chat" because "Teammates can use the shell on those computers" (docs.x.ai team-bots#plugins). The docs do not state the mechanism. No proxy or placeholder is mentioned anywhere in either doc set.
- verified, card into a page: "**Filled into the page. Secret values were never shown to your Bot.**" secrets.md:23.
- verified, Team Secrets: "Secrets exist only in the script's process environment. Once the script finishes, the value is gone unless the script wrote it somewhere". teams.md:162. "They don't make a value available to Bots directly". teams.md:167.
- verified, plugins: "OAuth tokens are held on Cursor's connector backend, and the Bot invokes tools without receiving them." work.md:125.

3. Can the agent or model read the value?
- verified (claim): "The Bot can't see a value either." docs.x.ai team-bots#secrets. Card: "Stored securely, never shown to your Bot". secrets.md:19. Card in a supported connection: "masked, excluded from the transcript, and not shown to the model". work.md:118.
- inference: for Team Bot secrets the claim rests on string redaction of outputs, so `base64 <<<"$KEY"`, a reversed string, or a request to an echo endpoint would show the value. This is Appendix A item 5 of secrets-design.md ("fill in and mask").
- verified, shared computer: "Every Bot on your account uses the same computer: browser sessions, files, and command-line credentials are shared ... Don't place a credential on the computer if another of your Bots shouldn't be able to use it." work.md:108. inference: a `gh auth login` on the computer is therefore shared by all Bots of that user.

4. Hosts and who may use.
- verified: no host field on a secret (secrets.md and docs.x.ai team-bots#secrets list only name, description, value).
- verified: "The Bot can use every secret in any teammate's conversation, so treat a secret as access you are giving the whole team. Use scoped, read-only service-account keys instead of personal credentials." docs.x.ai team-bots#secrets.
- verified: network allowlist is per team (Enterprise), "Teams without a policy default to allow-all". security.md:22. "Blocking a plugin doesn't block that service's website." security.md:35.
- verified: Team Secrets go to a computer "only when its Team Setup comes from exactly one team ... since scripts from different teams share one computer user." teams.md:164.

5. Redaction.
- verified: Team Bot outputs, above. Setup scripts: "Script output is checked for secret values before it's logged, and matches are redacted." teams.md:163. Action Recording: "Shell commands are secret-scrubbed; browser navigations ... strip query strings and credentials". teams.md:189. Content export: "known credential shapes, PEM blocks, and email addresses are redacted before export, but pattern matching cannot catch every secret." https://docs.x.ai/grok-bot/security (section "Logging and audit"); the same point, worded differently, in https://docs.x.ai/grok-bot/teams-and-enterprises#logging-and-audit: "Pattern matching cannot recognize every secret or every piece of personal data, and your team owns that residual risk."

6. Connectors.
- verified: "Grok Bot supports the same MCP servers, plugins, and skills as Cursor." https://x.ai/bot/guides/grok-bot-101. "Your team's Cursor MCP (Model Context Protocol) policy applies in full ... OAuth tokens stay on Cursor's connector backend". teams.md:53. "Team-managed connectors are the one exception: they may use team or service-account credentials." security.md:70.
- verified, Team Bot plugin table: OAuth plugin uses "The person talking to the Bot"; "Configured with a key or token" uses "The Bot's own credential, the same for everyone"; "For a custom server that needs secrets, choose Remote HTTPS." docs.x.ai team-bots#plugins.
- verified, sharing: "Templates do not include secrets", and "This is especially important for templates and bots that need API keys or custom MCP servers." (about writing setup instructions) https://x.ai/bot/guides/templates-for-grok-bot.

### Muse

Sources. site/about.html links Muse to https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/. Its "How We Built Safety Into Muse" link (http://security.muse.ai) redirects to https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (Tarek Sheasha, 2026-09-08); I call it "the security post" below and cite its section headings. I also read two Meta Help Centre articles, cited below. The privacy article renders its body with JavaScript, so its quote was read through a fetch tool only. The source is not public.

1. Where the member enters a secret.
- verified, connectors: "Go to Settings, then tap Connectors. Tap Connect ... Tap Continue to authorise the connection. Follow any additional login or authorisation steps." Help Centre "How Muse works with Connectors", https://www.meta.com/help/artificial-intelligence/1687253048996149/.
- verified, custom connectors: "you can ask Muse to create a Custom Connector. Muse will guide you through the process, which can involve retrieving API information from the service. Muse stores these in its Secure Credentials Store." (same article).
- verified, website passwords: "we present a custom UI on the client to capture your username and password, route them directly to authd, and store them in the secure credentials store outside the runtime cell in the Muse VM." Security post, section "Browser". The same sentence opens with "Similar to how Muse handles API tokens", so a similar but separate client form exists for API tokens (inference from that phrase; I found no page that shows it).
- verified, scope: "You and your Muse share your own dedicated computer in the cloud. This is where your Muse lives and where all data and credentials for any service you connect are securely stored." Security post, "An agent in your own cloud computer". OAuth tokens "are stored in your VM, not in centralized Meta infrastructure" (section "Muse Secure VM").
- verified, planned: "1Password support so Muse can use logins a person already has." Announcement.

2. How the agent uses it.
- verified: "Sentinel also performs just-in-time credential insertion for any requests which need a secret or auth token. For all such requests, code in the runtime cell or a worker only ever sees a "surrogate" token, minted by authd. After the concrete network request is authorized, Sentinel will replace any surrogate tokens with the real credential, obtained from authd, at the network boundary." Security post, "Network egress".
- verified: "privsep workers execute built-in connector code with tightly scoped privileges, keeping the connected credentials out of scope of the agent." ... "Built-in connectors have CLIs which run in the runtime cell which simply parse their arguments ... and pass typed arguments and file descriptors over a Unix socket. A systemd sandboxed worker then executes the business logic". Security post, "Muse Secure VM" and "Least Privilege".
- verified, transport to the proxy: "Runtime traffic reaches Sentinel via a forward proxy configured with Linux networking controls (userns, veth boundaries and eBPF filtering)." Security post, "Network egress". How TLS is ended to swap the token (a CA or not) is not stated.
- verified, browser: "What you enter goes straight to secure storage and is not visible to your main agent, but gets injected into the browser window at the point of need." and "while secure credential storage is filling a form, the agent is paused and can't act at all." Security post, "Browser".

3. Can the agent or model read the value?
- verified: "the harness runs in its own isolated cell, it doesn't see real credentials". Security post, introduction. "The agent never sees real tokens". Security post, "Network egress". "Muse has no visibility into people's passwords or payment methods." Announcement.
- verified, browser: the sub-agent "sees an accessibility tree snapshot of the page — not the raw DOM. (This also means it can't read credentials entered from the credential store ...) It has no ability to run javascript in the page context". Security post, "Browser".
- inference: the echo risk of secrets-design.md 2.5 (a listed host that returns the request header) is not discussed; the swap happens at egress, so a reflected value would come back into the cell unless Sentinel scrubs responses, which the post does not say.

4. Hosts and who may use.
- verified, per request: "Sentinel can evaluate the destination at both layer 4 and layer 7: the hostname, the resolved and final destination IP address, the port, protocol, HTTP method, path, and the actual decoded request." and the swap comes "After the concrete network request is authorized". Security post, "Network egress".
- verified, per caller: "Each worker is identified by its cgroup and has explicit credential allowlists. A calendar worker cannot ask authd for an email credential simply by changing a request parameter." and "All communication between the runtime cell and other services in the VM happens via Unix domain sockets with SO_PEERCRED and peer ACLs." Security post, "Least Privilege" and "Muse Secure VM".
- inference: a binding of each surrogate to the hosts of its own service is likely but not stated; the post states that Sentinel authorizes the request, not that a surrogate for service A is refused at host B.
- verified, approvals: grants are "bound to the particular connector/destination and use case", and can be "one-time, session-scoped, task-scoped, time-bounded, or perpetual". Security post, "Human in the Loop". Help Centre "How Muse handles your privacy, safety and security" (https://www.meta.com/help/artificial-intelligence/1047255454427887/): "Before Muse uses your credentials, the request goes through checks designed to confirm that" ... "You gave Muse permission to perform that type of action." (not confirmed by a second read, as above; the security post backs the same point)
- verified, payments: "At launch, we've partnered with Stripe Link", and "a single-use card number is issued". Security post, "Purchases".
- verified, payments: "The credential is tied to that particular merchant, a particular dollar amount, and only valid for a limited period of time." Security post, "Purchases".

5. Redaction.
- verified, none found for secrets: the security post, the announcement and the three Help Centre articles do not describe redaction of credentials in transcripts or logs. The design keeps values out of the cell instead.
- verified, data that acts like a credential: "Muse's email connector filters out one-time tokens, password reset links, and login magic links via both deterministic filters and a classifier model." Security post, "Least Privilege".
- verified, training: "trajectories are sanitized to remove key personally identifiable information before being used in training". Security post, "Our Policy Around Data".

6. Connectors.
- verified: "We've built an initial set of connectors to third-party systems and to other Meta apps ... we've written and iterated on SKILLs ... Muse can also write its own custom connectors for other services you care about if they have their own APIs or CLIs." Security post, "Connectors". "Meta doesn't review custom connectors or how they use your information, so grant access with caution". Help Centre 1687253048996149.
- verified: finer than OAuth scopes: "if you grant Muse the Gmail read-access OAuth scope on the Gmail side, you can remove the ability to access Gmail settings that usually comes along with it". Security post, "Least Privilege".
- not verified: third-party guides (parallel.ai, composio.dev, blotato.com) say custom connectors take MCP server URLs and a bearer token through an "Add custom connector" sheet. The official pages I read do not mention MCP.

### Appendix B systems

#### Claude Code on the web

Source: https://code.claude.com/docs/en/claude-code-on-the-web and https://code.claude.com/docs/en/cloud-environments (read as Markdown at cloud-environments.md, 2026-10-13). Not in Related projects; this is the official Anthropic docs site.

Change since Appendix B: the docs now have "network secrets" (Pro and Max plans only), held outside the VM and attached by Anthropic's agent proxy for listed hosts. Appendix B says only "yes for variables"; that still holds for variables and for all Team and Enterprise plans.

1. Entry and scope. Verified, cloud-environments#set-environment-variables (".env format, one KEY=value pair per line") and #add-network-secrets ("Network secrets are available on Pro and Max plans. They aren't available on Team or Enterprise plans yet"; added in the Edit environment dialog; "You can't view the value again after saving"; needs the organization admin role). Scope: verified, #which-requests-get-the-credential ("The secret applies in every session that runs in the environment, whoever started it"). Org-shared environments (Owner-created) carry variables only: verified, #organization-shared-environments ("don't include secrets in them").
2. Use. Variables: verified, #set-environment-variables ("ordinary environment variables that any command Claude runs can read"). Network secrets: verified, #add-network-secrets ("Anthropic's agent proxy adds the key to requests for the hosts you list, after each request leaves the session's VM"); the form has Credential type (default Bearer), Allowed websites and Custom headers. Inference: there is no placeholder for network secrets; the proxy adds the header itself, and the agent sends nothing. GitHub: verified, #github-proxy ("the git client inside the VM uses a scoped credential, which the proxy verifies and swaps for your actual GitHub token") and #work-with-github-issues-and-pull-requests (`GH_TOKEN` and `GITHUB_TOKEN` "read as the placeholder string `proxy-injected`"). Appendix B's GitHub claim holds.
3. Readable? Variables: yes, verified, cloud-environments#set-environment-variables ("Anyone who uses the environment can read the values"). Network secrets: no, verified, #add-network-secrets ("the key doesn't appear in the session's environment variables or in any file"). GitHub token: no, verified, claude-code-on-the-web#github-authentication-options ("your GitHub credentials stay encrypted on Anthropic's servers and never enter a session's VM").
4. Hosts and users. Verified, #add-network-secrets (Allowed websites, "A leading `*.` matches every subdomain"; overlapping hosts: "the agent proxy sends only one of them"), #which-requests-get-the-credential (listed hosts are reachable even when the access level would not allow them), #requests-that-never-get-the-credential (never GitHub, `api.anthropic.com`, npm, jsr, PyPI, crates, Go proxy, setup-script requests, telemetry). GitHub proxy: attached repositories only, no tag pushes or branch deletions, no GraphQL: verified, #github-proxy.
5. Redaction. Inference: neither page documents masking of variables in transcripts or logs; the sharing section warns "Sessions may contain code and credentials from private GitHub repositories" (claude-code-on-the-web#share-from-a-max-or-pro-account).
6. Integrations. Verified, cloud-environments#network-access ("MCP connectors you enable … work without adding their hosts to Allowed domains, because connector traffic travels through Anthropic's servers rather than the session's network"). A repo's `.mcp.json` servers load in the session (#what-carries-over-from-your-setup). The credential types list is shared with Claude Tag connections: verified, #add-network-secrets.

#### Codex cloud

Sources: the Appendix B link https://learn.chatgpt.com/docs/environments/cloud-environment (Wayback snapshot 2026-10-01, id_ 20261001102934) and the current guide https://developers.openai.com/codex/environments/cloud-environments, which redirects to learn.chatgpt.com/docs/environments/cloud-environments (Wayback snapshot 2026-09-30, id_ 20260930054754). Some live pages blocked automated reads; the current guide loaded live in the re-check and matched its snapshot.

Change since Appendix B: the cited page is now titled "Codex Cloud (Legacy)" and covers only Code Review and the Linear and GitHub integrations; the Appendix B claim ("secrets only during the setup script") holds there. The current Codex Cloud has network secrets with placeholders and proxy substitution, and a Personal vault.

1. Entry and scope. Verified, current guide, section "Configure environment variables and network secrets" (select Manage beside Environment variables or Network secrets; a network secret has Key, Value, Allowed domains) and "Supply personal values" ("Use Personal vault to save your own environment variables and network secrets for cloud environments in your workspace"; Applies to All or Selected environments). Sharing: verified, "Share within an Enterprise workspace" (Who can use: Only me or the workspace). Legacy: verified, legacy page "Environment variables and secrets" (secrets "stored with an additional layer of encryption").
2. Use. Verified, current guide table: environment variable "Passed directly to programs in the environment"; network secret "Programs receive a placeholder; the proxy substitutes the real value for allowed destinations", HTTPS on port 443, "during setup and tasks". Legacy: verified, "They are only available to setup scripts. For security reasons, secrets are removed before the agent phase starts."
3. Readable? Variables: yes (inference from "passed directly to programs"); personal variables: verified, "Its value is visible to the task." Network secrets: no, verified, "it doesn't put the raw credential in a local process or file."
4. Hosts and users. Verified, current guide: Allowed domains per network secret; "Saving environment-owned network secrets adds their destinations to restricted internet access. Direct variables and personal values don't add destinations." "Personal network secrets use the environment's allowed destinations." "A shared environment can request values that each person supplies from their own account. Sharing the environment shares these requirements, not your personal credentials." "Only requested values reach a task."
5. Redaction. Inference: neither snapshot documents masking. The internet-access page (Wayback 2026-09-22, learn.chatgpt.com/docs/cloud/internet-access) lists "Code or secret exfiltration" as a risk of agent internet access and advises allowing only needed domains and HTTP methods.
6. Integrations. Verified, current guide, "Access cloud resources with OIDC" (short-lived credentials from a trust the organization sets up with the cloud provider; Enterprise, by request) and "Private networking (VPN)" (Tailscale; "Tasks in a shared environment use its configured VPN identity"). MCP in Codex Cloud: unchecked.

#### Devin

Sources: the Appendix B link https://docs.devin.ai/product-guides/secrets (Wayback 2026-10-01, id_ 20261001183042), https://docs.devin.ai/integrations/overview and https://docs.devin.ai/product-guides/security-profiles (Wayback 2026-09-21), https://docs.devin.ai/onboard-devin/environment/blueprint-reference (Wayback 2026-04-25, older). The write-up https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/ loads live. The Appendix B entry holds.

1. Entry and scope. Verified, secrets page: "Persisted Global Secrets" (Settings → Resources → Secrets, "apply to the entire organization … all members … will be able to use Global Secrets, but only admins will be able to view or edit"), "Personal Secrets" ("only accessible in sessions you create"), "Repo-Specific Secrets" (blueprint Secrets tab; members with ManageOrgSecrets can "search, reveal, edit"), "Session-Specific Secrets" (Devin asks in the conversation). Types: raw secret, site cookies, TOTP. Enterprise secrets merge with org secrets: verified, blueprint reference "Secrets".
2. Use. Verified, secrets page "Working With Secrets": "In the browser, Devin types the value directly. For shell commands, it binds secrets as environment variables whenever needed." Repo secrets as a file: verified, blueprint reference (`/run/repo_secrets/{owner/repo}/.env.secrets`, sourced before builds and when working in the repo; "scrubbed from the snapshot image").
3. Readable? Yes. Inference from the plain env binding; the write-up demonstrates it: "Users can define secrets and those will become available during runtime as environment variables" and "the third-party received the environment variables" (reported to Cognition 2025-04-06).
4. Hosts and users. No per-secret host binding on the secrets page (inference: no such field documented). Session-wide network allowlist: verified, security-profiles ("A network policy is an allowlist of destinations the session's machine is permitted to reach … applies to all network access from the session"); profiles also remove the GitHub CLI token and restrict MCP servers.
5. Redaction. Inference: none of the four pages documents masking of secret values in session output.
6. Integrations. Verified, integrations overview: three separate surfaces, native integrations (Settings → Connections), plugins and MCP servers (Customize → MCPs; "For OAuth servers, the Access setting determines whether members share one authenticated connection or each connect their own account"), and the Secrets Manager "for command-line tools or custom workflows".

#### Copilot coding agent

Source: the Appendix B link https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables (live, 2026-10-13), plus https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers and https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall. The product is now named "Copilot cloud agent"; secrets moved from the Actions `copilot` environment to a dedicated "Agents" type. The Appendix B entry holds.

1. Entry and scope. Verified, secrets page: "Copilot cloud agent has its own dedicated Agents secrets and variables"; organization level ("shared across any or all repositories") or repository level; repo admin or org owner; repo value overrides org value; the old `copilot` environment values "have been automatically migrated".
2. Use. Verified: "They are exposed to the agent as environment variables in its development environment", except `COPILOT_MCP_` names, "which are only available to MCP servers". "Copilot cloud agent does not have access to GitHub Actions, Codespaces, or Dependabot secrets and variables."
3. Readable? Yes for non-prefixed values (inference from plain env vars). `COPILOT_MCP_` values: inference, they reach the MCP server process on the same runner, and the firewall page says it "does not apply directly to Model Context Protocol (MCP) server processes", so a prefixed value is out of the agent's environment but not behind a process boundary.
4. Hosts and users. No per-secret host binding (inference: none documented). Verified, firewall page "Limitations": "The firewall only applies to processes started by the agent via its Bash tool. It does not apply directly to … MCP server processes or processes started in configured Copilot setup steps."
5. Redaction. Verified, secrets page: "Secret values are masked in Copilot cloud agent session logs."
6. Integrations. Verified, configure-mcp-servers page: "If your MCP server requires a variable, key, or secret, add an Agents secret or variable with a name prefixed with `COPILOT_MCP_`", referenced as `$COPILOT_MCP_API_KEY` in the server config; MCP tools run "autonomously, and will not ask for your approval".

## 4. What Isomux should take

### 4.1 The proxy in a single-user office

The OS-user split is on hold, so a secrets proxy would first run where an agent can read the server state. **The products show that the proxy is still worth it there.** What it buys is a value that is never in an agent's environment, its transcript, the model context or a printed environment. It does not stop an agent that reads the store on purpose, and the D3 sentence must say so.

- **Products that ship it with no OS boundary.** OpenClaw runs the same design (sentinel, loopback MITM proxy, and the trust variables of section 2.3 except `CARGO_HTTP_CAINFO`) for exec that its Gateway hosts, with the store in a plain SQLite file (0600). That exec runs as the Gateway's user (inference: the docs say "Gateway-hosted exec" and name no other user). Munder Difflin and Orca keep integration tokens out of agents with the same limit, and Orca's code says that, for a caller that can run code as the host's user, changing launch env "is therefore not a boundary".
- **The other side.** Omnigent's proxy refuses to start without a bwrap or Seatbelt sandbox that hides the source, and Claude Code on the web, Codex cloud and Muse put the agent in a VM. Their promise is stronger. Isomux gets it only with the split.
- **Redaction only** (Cursor Runtime Secrets, Grok Bot Team Bot secrets, Hermes, Copilot): this buys clean transcripts and logs for the exact string. The value is still in the process, so an agent can encode it or send it to any host. Cursor and Grok Bot still tell members that the agent cannot see the value. Grok Bot's own security page admits that "pattern matching cannot catch every secret". Isomux needs exact-value redaction anyway (section 6). It does not replace the proxy.
- **Per-command selection** (qm credential handles, Hermes passthrough): the variable is only in the commands that ask for it. This shrinks exposure, but those commands can print it.
- **A broker API** (qm, Munder Difflin; Orca and AdaL with fixed verbs): the value stays out of the agent's environment, as with the proxy, with no CA and no proxy for all HTTPS. But it covers only curl and code that learns the call shape. It does not cover `gh`, `git`, or SDKs and CLIs with no base-URL setting.
- **The pattern.** Products that let agents run any CLI chose the proxy (Claude Code on the web, Codex cloud, OpenClaw, Omnigent, Muse). Products with a fixed set of integrations chose a broker. Isomux agents run any CLI (`gh`, `fly`, `stripe`), so the proxy fits. A broker is the fallback if the CA cost is judged too high for the first release, with the same single-user promise and less coverage.

### 4.2 The secrets design (D1-D5)

- **D1, supports the recommendation.** Claude Code on the web, Codex cloud, OpenClaw, Omnigent and Muse all add the value on egress for listed hosts. OpenClaw sets the trust variables of section 2.3, except `CARGO_HTTP_CAINFO`.
- **D1, keep placeholders.** Omnigent's default and Claude Code's network secrets need no placeholder: the proxy adds the header to any request to the host. Isomux should not copy this. The placeholder is how the proxy knows the scope (office or member). Without one, every agent's request to that host would get the credential.
- **D1, add to appendix D:** never inject on TRACE or OPTIONS, because TRACE reflects the request (Omnigent). Also keep a fixed list of hosts that never get a secret: the model APIs and the package registries (Claude Code on the web).
- **Section 2.5, ahead of prior art.** No product found scrubs the value from responses: Omnigent, qm and Munder Difflin do not, OpenClaw does not (inference) and Muse does not document it. OpenClaw states the same limit as section 2.5: binding a host "does not make a host trustworthy". Keep the scrub, with the limit stated.
- **D2, supports the recommendation.** No product where agents share a machine has a per-agent grant. Scopes are environment, team or member: Claude Code applies a secret "in every session that runs in the environment", Grok Bot "in any teammate's conversation", OpenClaw has one team store and Munder Difflin gives every spawned worker all integrations. Only Muse checks the caller (cgroups, `SO_PEERCRED`), inside a VM where it controls every process. That is the per-agent future of section 3. One cheap addition, from Codex cloud: a shared scope names the secrets that it needs, and each member supplies their own value ("Sharing the environment shares these requirements, not your personal credentials").
- **D3, supports the recommendation** (see 4.1). For the copy: Pi and Orca state plainly that there is no boundary. Cursor and Grok Bot claim more than their mechanism gives. Claim only what the mechanism proves.
- **D4, the research argues against the recommendation** (a secret switch on each variable row). Most products enter a secret as a credential with its hosts and header form, in its own list: Munder Difflin (integration with base URL, auth type, secret), qm (host, header, methods, paths), Claude Code (credential type, allowed websites, custom headers), Codex (key, value, allowed domains), OpenClaw (a separate Secrets page). Only Cursor puts a type on an env-var row, and its non-plain types are redaction or build-only, not secrecy. This matches Nil's direction for the integrations page. Write-only values are common (Cursor's API, Grok Bot, Munder Difflin, Claude Code). Orca shows the trap: its editor is write-only, but an RPC returns the values. Check every read path (routes, export, agent reference), not only the UI.
- **D5, the research argues against the recommendation** (approved integrations only). No product limits secrets to vetted integrations. Claude Code, Codex, OpenClaw, Omnigent, qm and Munder Difflin accept any host that the member or admin names, and some state the limit. Prior art is the D5 alternative: any host, with presets, a never-list (above) and a plain statement. An optional path prefix (qm, Munder Difflin) and a method list (qm, default GET) narrow an over-scoped token. As section 2.5 says, they do not prove an operation safe.

### 4.3 The integrations page (task 911c9bbb)

Against the agreed direction: a secret is the credential entered when adding a connection, MCP servers are registered once for every engine, and engine-managed connectors show as "Managed in Claude".

- **The connection form holds the secret fields:** a write-only value, hosts (with presets), header form, optional path prefix, and the usage note for agents. Munder Difflin, qm, Claude Code and Codex ask for the same fields. Grok Bot shows the agent a description, never the value. The usage note does that job.
- **The agent asks and the member types.** An agent can start "add a connection", and the member enters the value in a masked form outside the chat: OpenClaw (masked prompt with hosts that the agent proposes and the member edits), qm (one-time secret-drop link), Grok Bot (secure secret card). Devin asks for secrets in the chat, which puts them in the transcript.
- **MCP servers.** A remote MCP server's credential can be a secret bound to the MCP host, so each engine's MCP configuration holds the placeholder and the proxy adds the value. This needs each engine's MCP client to honor the proxy and trust variables (unchecked). A stdio MCP server gets its credentials in its own environment, where agents can read them. The page should say so, as Cursor does ("the agent has access to the server's configuration and environment variables"). OpenClaw and Copilot also give MCP processes plain values.
- **One service, each member's own account.** qm's per-user MCP mode sends each caller's token only to the registered host, and Codex lets a shared environment ask each member for their own value. Both match "a member connects Gmail to their own user once, for every engine".
- **"Managed in Claude".** Claude Code on the web says connector traffic "travels through Anthropic's servers rather than the session's network". Grok Bot also keeps connector OAuth on its backend, and AdaL likely does (inference). The page can say the token is not in this office only after someone checks the same for the Claude Code CLI (unchecked here).
- **"Who gets it" copy.** Grok Bot: "treat a secret as access you are giving the whole team". This matches the rule that "Individual" means given by default, not locked.
