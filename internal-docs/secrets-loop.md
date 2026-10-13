# Slice loop B: the secrets proxy

Board task b38ddd02. Design: internal-docs/secrets-design.md. Prior art: internal-docs/secrets-prior-art.md. Worktree `loop-secrets` (`~/nil/isomux-worktrees/loop-secrets`). Read this whole file at the start of every slice. A second loop (integrations page, `internal-docs/integrations-loop.md`) runs at the same time in its own worktree; the Lead merges both into main.

## North star

A member saves a credential once, with the hosts that may receive it. Agents get a placeholder, never the value: `echo`, `printenv`, transcripts and the model context show only the placeholder. A proxy run by the server puts the value into requests to the listed hosts only.

## Rulings (final)

1. Nil, 2026-10-13: the secrets proxy is in this build. Scopes are office and member, as today (D2). No per-agent limits: those would need per-agent sandboxing. Never name per-agent OS users as a blocker or a plan.
2. Secrets get their own list next to the variables list. No secret switch on a variable row (D4).
3. The OS-user split is on hold, so secrets ship on single-user offices, with one honest sentence saying an agent that reads the office's files on purpose can read the store (D3). Nothing in this loop depends on the split or touches it.
4. References: Omnigent for the proxy, OpenClaw for the member side (internal-docs/secrets-prior-art.md has both). Copy their design and their failure-case tests, not their code.
5. Design for the general case. No copy in terms of "IT", no design tied to one customer.
6. Website logins through browser control are not in this build.
7. Mechanism (D1): placeholders per scope, an office CA, and a proxy that swaps a placeholder only in the secret's named header and only for a listed host. It never injects on TRACE or OPTIONS, keeps a fixed list of hosts that never get a secret (model APIs, package registries), scrubs the value from responses, and logs each use in the audit log.
8. The repo is public and has self-hosters: state layouts stay backward compatible; offices without secrets do not change at all; no host, user, path or IP of this office's machines in a commit.
9. Nil, 2026-10-13 (D5): a secret may go to any host, with presets for common services and a plain statement that the member vouches the host does not send the credential back.
10. Nil, 2026-10-13: office secrets are owner-only, the same as office variables.
11. Nil, 2026-10-13: variables, secrets and integrations are one UI. The integrations page (loop A) is where today's Office-wide and Individual connections settings go; its variables list and the secrets list sit there side by side, next to the connections. Loops A and B build into that one page, not two.

## Decision protocol

- Worker and reviewer settle implementation choices inside a slice.
- The Lead settles anything that changes scope, a public interface (route shape, state layout) or a ruling. Ask the Lead; do not pick.
- A product tradeoff with no clear answer goes into the slice report as PARKED FOR NIL with a recommendation first; the loop continues on the rest.
- Anything that would change a ruling above, or touch the OS-user split, is PARKED FOR NIL.

## Gates (every hand-off)

The room prompt gates: `bun run build:ui` (plus `bun run build:demo` when the diff touches ui/demo-server.ts or shared/storage-labels.ts), scoped tests on the touched area, eslint on touched files, `bunx tsc --noEmit` (inside a MemoryMax=2G scope: `NODE_OPTIONS=--max-old-space-size=1700`). Add server/test-support/routes-table.test.ts and routes-agents-manifest.test.ts when a route changes, server/test-support/identity-tokens.test.ts when a scope's capabilities change, and server/backends/opencode/authority-broker.prompt-routes.test.ts when an agent-reference page or the system prompt names a route. A new agent-facing route also goes in ROUTE_LABELS in ui/log-view/isomux-curl.ts. A new audited write route also goes in ui/audit-operations.ts, and ui/audit-operations.test.ts joins the scoped tests (B1 missed it, 2026-10-13). A slice that changes what the connections settings render also runs ui/App.settings-*.dom.test.tsx: their API stubs answer unknown routes with {} (A1 crashed them, 2026-10-13). Update the doc surfaces in internal-docs/documentation.md that the slice makes stale.

## Prohibitions

- Never restart the running office server; never use sudo; never print a credential or a secret value, in logs, tests output or reports (verify with grep -q, ls and wc only). Test values are obvious fakes.
- Never read, scan or archive ~/.claude/projects.
- Proxy and engine checks use a throwaway ISOMUX_HOME, a spare port and stub hosts, never the live office and never a real provider account.

## Slices

- [x] B1: design doc to the rulings; the secret store and the Secrets list; read-path audit. Approved by Reviewer 3 at 3c796ed1, merged as e3e68cd7. Carried to B4: a recursive search rooted at STATE_ROOT or an ancestor (Grep, grep -r) still reads the store; the variables hint still suggests GH_TOKEN as a variable; until B2 a saved secret does nothing for agents.
- [x] B2: the proxy. Approved by Reviewer 4 at 145730a0, merged as 1d87d8ce. Supervised child on a loopback port, office CA in-process (node:crypto), own strict HTTP/1.1 reader, scrub with gzip/deflate/br decoding, secrets.use audit rows (actor secret_proxy), company HTTPS_PROXY chained, restart marking per scope, MCP headers carry placeholders. Known limits: design appendix F. Parked for Nil: refuse secret values under 8 characters (the scrub and log masking skip them).
- [x] B3: each preset proven end to end. Approved by Reviewer 3 at 14ffd0e9, merged as 16df1297. curl, git, gh, stripe, Node and Bun fetch, Node https, Python requests work through the proxy (stub hosts); flyctl cannot (it drops a FLY_API_TOKEN that is not a macaroon; not installed here, from source). Added the git credential helper the design promised. Parked for Nil: install flyctl to confirm.
- [ ] B4: an agent asks for a secret and the member types it in a masked form; the honest sentence; docs

## SLICE-B1 PICKUP: design to the rulings, the store, the Secrets list

Goal: the member can save, list, rotate and delete secrets, and nothing ever returns a value. No proxy yet: agents get nothing new in this slice.

Step 1, design doc (plan-gate it with the reviewer before code): update internal-docs/secrets-design.md to rulings 1-11. Mark D1-D5 decided, drop "secrets after split slice 7", state the single-user promise, and add from the prior art: no injection on TRACE or OPTIONS (Omnigent), a never-list of hosts (Claude Code on the web), and Codex cloud's "a shared scope names the secrets it needs, each member supplies their own value" as a later option, not built now. Fix Appendix B's out-of-date rows (Codex cloud and Claude Code on the web now have network secrets). Keep it short: the doc is the spec for B2-B4.

Step 2, store and routes: per design section 1. Office secrets (owner-only) and member secrets, each with name, value (write-only), hosts, the form the credential is sent in, and timestamps; a generation number for placeholders (B2 uses it). Stored in server state as the design says, 0600 in a 0700 directory, written atomically like the env files. Routes: create, list (no values), rotate value, edit hosts and form, delete. Audit log entries for each change (no values).

Step 3, the Secrets list in the UI: next to the variables list, on both the office and the individual half of the connections settings (ui/components/ConnectionsPane.tsx), which loop A grows into the integrations page (ruling 11). Write-only value field; host presets for common services (GitHub, Stripe, Fly, with their hosts and header forms; no presets for model APIs, which are on the never-list of ruling 7: the create and edit routes refuse a never-listed host with a clear error. Lead ruling, 2026-10-13); the D5 vouch sentence where hosts are entered. The integrations loop adds a list to the same pane: keep your change to ConnectionsPane to one mount point for a new component.

Step 4, read-path audit (Orca's bug: a write-only editor while an RPC returns the values): enumerate every path that could return a secret value - routes, the export and backup paths (server/backup.ts excludes the env files today; secrets must be excluded too), the agent reference, logs, the audit log, the demo server - and add a test per path that a known fake value never appears in its output.

Acceptance: a member saves a secret, sees it listed with its hosts and form and "set" with a date, rotates and deletes it, and no route, export, backup or log contains the value (tests prove each path); a member cannot see or change office secrets beyond what office variables allow today; the design doc matches the rulings; screenshots desktop and mobile. The reviewer re-runs the scoped tests and the read-path tests on the approved hash.

Decide with the reviewer: the store file format; the route shape; the preset table's location (shared with B2 and B3).
Locked: rulings 1-11.

## Probe facts (Worker 5, 2026-10-13; full report in internal-docs/private/engine-mcp-proxy-probe-20261013.md, not in git)

- All three engines (Claude Code CLI, Codex app-server, OpenCode serve) send both their MCP traffic and their model API traffic through `HTTPS_PROXY`/`https_proxy`, and honor `NO_PROXY`.
- CA variables: Claude and OpenCode accept `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`. Codex ignores `NODE_EXTRA_CA_CERTS`; it needs `SSL_CERT_FILE` (use the CA plus system-roots bundle) or `CODEX_CA_CERTIFICATE`. No engine needs `NODE_USE_ENV_PROXY`, but Node 24 tools that agents run do (`fetch` ignores `HTTPS_PROXY` without it).
- Hosts the engines reach at start or per turn, which must stay plain tunnels (never-list): `api.anthropic.com`, `mcp-proxy.anthropic.com` (claude.ai connector traffic, carries the sign-in token), `api.openai.com`, `chatgpt.com`, `models.opencode.ai`, `registry.npmjs.org`. Codex also reaches `github.com` and `api.github.com` at start: those are preset hosts for GitHub secrets, so the proxy ends TLS for them only when an agent in scope has a GitHub secret, and must pass Codex's own requests through unchanged (no placeholder, no injection).
- If the proxy stops, every agent with a secret in scope loses model traffic too. The server supervises and restarts it.

## SLICE-B2 PICKUP: the proxy

Starts after B1 is merged into main.

Goal: agents with at least one secret in scope get placeholders and the proxy; the proxy puts the value into requests to listed hosts only. Design sections 2.1-2.3 and appendix D are the spec, with ruling 7 and the probe facts.

Mechanics and traps:
- First, check that Bun can end TLS with a certificate per host name (design S1 says unchecked); if it cannot, stop and report before building on it.
- Placeholders per scope (HMAC of scope, name and generation, keeping the value's well-known prefix). Environment for agents, terminals and scheduled runs with a secret in scope: the placeholders, `HTTPS_PROXY`, `https_proxy`, `NO_PROXY` for loopback, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `CODEX_CA_CERTIFICATE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_USE_ENV_PROXY=1`. Agents with no secret in scope get nothing new (ruling 8).
- The proxy: plain tunnel for every host no secret lists and for the never-list; for a listed host, end TLS, swap a placeholder only in the secret's named header (Basic decoded first), 403 for a placeholder of a secret that does not list this host, 421 on any CONNECT/SNI/Host mismatch, no injection on TRACE or OPTIONS, never follow redirects, scrub the raw, Basic and URL-encoded value from responses, one audit entry per use (no value).
- Omnigent's failure-case tests are the reference: copy the cases (secrets-prior-art.md), not the code.
- If integrations slice A2 has landed, switch its MCP credentials from the real value to the placeholder.
- The OpenCode profile identity rule (appendix D) so a change of secrets replaces the right server.

Acceptance: in a throwaway office with stub HTTPS hosts, an agent-side curl with a placeholder reaches a listed stub host that receives the value; every appendix D boundary case passes; a Claude, a Codex and an OpenCode process reach their model host (a stub on the never-list) through the proxy untouched; the agent's environment, transcript and printenv hold only placeholders. The reviewer re-runs the boundary tests on the approved hash.

Decide with the reviewer: the proxy's process model (in the server or a supervised child); how values reach it.
Locked: rulings 1-11.

## SLICE-B3 PICKUP: each preset proven end to end

Time box (Lead, 2026-10-13): the office restarts before Nil's morning report, which needs every agent idle. Hand off for review by 15:30 UTC. If the slice is not approved by 16:00 UTC, commit the work in progress on the branch, report where it stands, and stop: it stays for the next night and is not merged.

Starts after B2 is merged into main.

Goal: prove, in a throwaway office with stub hosts that stand in for the real services, that an agent's ordinary tools use a secret through the proxy with no extra setup: curl, git over HTTPS with the credential helper, gh, stripe, fly, a Node SDK call (fetch, and an SDK that uses its own HTTP client if one is easy) and a Python SDK call (requests). Fix what fails.

Mechanics and traps:
- The stub hosts answer as the real ones would for one read call each (for example GitHub GET /user) and check the header. Map the preset host names to the stubs in the throwaway office only (the proxy's upstream resolution or /etc/hosts in a container), never by changing what a real agent resolves.
- git over HTTPS: the design's credential helper and Basic swap (design 2.4). gh, stripe and fly read their token from the environment: confirm each sends the placeholder in the form the preset names, and that each honors HTTPS_PROXY and the CA variables (Go CLIs read SSL_CERT_FILE).
- A tool that cannot be made to work is a finding, not a failure: report which, why, and what the member sees.
- No real service is contacted and no real credential is used.
- Fly (Worker 1, A3, 2026-10-13, unchecked against real Fly): a Fly token's value is "FlyV1 fm2_..." (the space is part of it), and credentialHeader sends "Authorization: Bearer <value>". Check what fly and the Fly API expect for that token, and fix the Fly preset's form (and the A3 identity test, which uses credentialHeader) if the scheme must not be added.

Acceptance: a table per tool (works / does not, with the evidence command) in the report; tests for what the repo can run in CI (stub-based); the reviewer re-runs the stub run on the approved hash.

Decide with the reviewer: which checks live in CI and which stay a recorded manual run.
Locked: rulings 1-11.

## SLICE-B4 PICKUP: the agent asks, the member types; the honest sentence; docs

Time box (Lead, 2026-10-13): hand off for review by 15:35 UTC; if not approved by 16:00 UTC, commit the work in progress on the branch, report where it stands, and stop (not merged). The honest sentence already shipped in the Secrets list hint (f9f579ae); B4 keeps it and adds it to the docs. Parked for Nil, do not decide: a minimum secret length.

Starts after B2 is merged into main (B3 may run before or after).

Goal: an agent that needs a credential can ask for it, and the member enters the value in a masked form outside the chat, so the value never enters the transcript. The single-user promise is stated once, honestly. Docs cover secrets for members and agents.

Scope:
- The ask: an agent-facing route that opens a request for a secret (name, hosts, form, a reason), shown to the member as a card in the chat with a masked form (OpenClaw's member side is the reference (ruling 4): the agent proposes hosts, the member edits them). Saving creates the secret in the member's scope; the agent gets only the placeholder and a confirmation. A member can decline. An office secret request goes to owners.
- Reissue a placeholder (B2 deferred it): a route and a button; the generation goes up and the agents in scope get the new placeholder at their next start.
- The honest sentence (ruling 3), in the Secrets list and the docs: on this office, an agent that reads the office's files on purpose can read the store. One sentence, no more.
- Carried from B1 and B2: a recursive search rooted at STATE_ROOT or an ancestor (Grep, grep -r) still reads the store, so the safety hooks refuse such a search unless it excludes secrets/ (accident protection); the variables hint that suggests GH_TOKEN as a variable points at secrets instead; the Secrets list says that a member variable named HTTPS_PROXY is not chained (B2 ruling 4).
- Docs: docs/ for members (one short section), the agent reference page `connections` (A4 adds it; B4 extends it, no second page: Lead ruling 2026-10-13), internal-docs/documentation.md surfaces. Copy is customer-facing and goes to Nil for sign-off: draft it short.

Acceptance: an agent asks, the member saves in the masked form, the agent's next command uses the placeholder, and the transcript never holds the value (fake-value test); reissue changes the placeholder; the search refusal works; screenshots desktop and mobile. The reviewer re-runs the tests on the approved hash.

Decide with the reviewer: the card's shape (reuse the existing interaction cards if they fit); the agent route.
Locked: rulings 1-11.
