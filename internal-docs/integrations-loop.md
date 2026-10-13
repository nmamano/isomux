# Slice loop A: the integrations page

Board task 911c9bbb (read its whole record: the agreed direction is at the top). Worktree `loop-integrations` (`~/nil/isomux-worktrees/loop-integrations`). Read this whole file at the start of every slice. A second loop (secrets proxy, `internal-docs/secrets-loop.md`) runs at the same time in its own worktree; the Lead merges both into main.

## North star

One page lists every connection an agent in this office can use: what it is, the account the service sees, who gets it, where it is set, whether it works, and how agents should use it. Today's Office-wide and Individual connections settings grow into this page; there is no second place to set things.

A connection is anything that lets an agent act on an outside service: an API token, a signed-in CLI, an MCP server, an engine-managed connector. The account is the identity the service sees.

## Rulings (final)

1. Nil, 2026-10-13: the direction at the top of task 911c9bbb is agreed. Today's Office-wide and Individual connections settings grow into the page; variables stay there.
2. Wording: "Individual" means given to that member's agents by default, not locked to them. All agents run as one OS user; the page never presents a per-member or per-agent choice as a security control.
3. No per-agent limits: they would need per-agent sandboxing. Never name per-agent OS users as a blocker or a plan.
4. Engine-managed connectors (for example Gmail connected in claude.ai) show as "Managed in Claude" with a link to where they are managed, and say every Claude agent in the office can use them. Never imply they work for other engines.
5. Isomux does not run MCP servers. It registers a remote MCP server once and gives it to Claude, Codex and OpenCode, at office or member scope.
6. A secret is the credential entered when adding a connection, not a variable with a switch (secrets loop, ruling 2 there). Until the secrets loop lands its store, this loop does not store credentials of its own.
7. Design for the general case. No copy in terms of "IT", no design tied to one customer.
8. Website logins through browser control are not in this build.
9. The OS-user split is on hold. Nothing in this loop depends on it or touches it.
10. The repo is public and has self-hosters: state layouts stay backward compatible; no host, user, path or IP of this office's machines in a commit.
11. Nil, 2026-10-13: variables, secrets and integrations are one UI. This page is where today's Office-wide and Individual connections settings go; its variables list and the secrets list (loop B) sit there side by side, next to the connections. Loops A and B build into that one page, not two.
12. Nil, 2026-10-13 (secrets loop rulings 9-10): a secret may go to any host, with presets and a plain statement that the member vouches for the host; office secrets are owner-only.

## Decision protocol

- Worker and reviewer settle implementation choices inside a slice.
- The Lead settles anything that changes scope, a public interface (route shape, state layout) or a ruling. Ask the Lead; do not pick.
- A product tradeoff with no clear answer goes into the slice report as PARKED FOR NIL with a recommendation first; the loop continues on the rest.
- Anything that would change a ruling above, or touch the OS-user split, is PARKED FOR NIL.

## Gates (every hand-off)

The room prompt gates: `bun run build:ui` (plus `bun run build:demo` when the diff touches ui/demo-server.ts or shared/storage-labels.ts), scoped tests on the touched area, eslint on touched files, `bunx tsc --noEmit` (inside a MemoryMax=2G scope: `NODE_OPTIONS=--max-old-space-size=1700`). Add server/test-support/routes-table.test.ts and routes-agents-manifest.test.ts when a route changes, server/test-support/identity-tokens.test.ts when a scope's capabilities change, and server/backends/opencode/authority-broker.prompt-routes.test.ts when an agent-reference page or the system prompt names a route. A new agent-facing route also goes in ROUTE_LABELS in ui/log-view/isomux-curl.ts. A new audited write route also goes in ui/audit-operations.ts, and ui/audit-operations.test.ts joins the scoped tests (B1 missed it, 2026-10-13). A slice that changes what the connections settings render also runs ui/App.settings-*.dom.test.tsx: their API stubs answer unknown routes with {} (A1 crashed them, 2026-10-13). Update the doc surfaces in internal-docs/documentation.md that the slice makes stale.

UI slices show the page in headless Chrome (internal-docs/ui-verification.md), desktop and mobile width, in the report.

## Prohibitions

- Never restart the running office server; never use sudo; never print a credential (verify secrets with grep -q, ls and wc only).
- Never read, scan or archive ~/.claude/projects.
- Real-engine checks use a throwaway ISOMUX_HOME and a spare port, never the live office.

## Slices

- [x] A1: the page lists every connection, read-only. Approved by Reviewer 1 at 6b529a7c, merged as 0122b4d3. GET /api/me/connections; claude.ai connectors kept in memory per sign-in (init message + status read after each turn, source "claudeai" only). With streaming input the init message comes on every turn (Worker 1, 2026-10-13). Codex Apps and OpenCode: none shown.
- [x] A2: remote MCP servers registered once for every engine. Approved by Reviewer 2 at 384b8856, merged as ec337cb2. Static credentials only; OAuth is A2b (plan below, Isomux as the OAuth client: Lead ruling, it is the only design that keeps "once, for every engine"). Claude holds the first message of a session until setMcpServers answers (about 1.5 s, 10 s bound). A credential needs port 443. B2 switch point: credentialFor in server/mcp-servers.ts.
  - For B2: `credentialFor` in server/mcp-servers.ts is where the header gets the placeholder instead of the value.
- [ ] A2b: OAuth MCP servers (after A4, if time allows)
- [ ] A3: Test button and diagnostics per connection
- [ ] A4: a usage note per connection that agents read

## SLICE-A1 PICKUP: the page lists every connection

Goal: today's Office-wide and Individual connections settings (ui/components/ConnectionsPane.tsx, mounted twice in ui/components/UserSettingsView.tsx) grow into the integrations page. This slice adds the read-only list; the existing editors stay where they are under it.

Each entry shows:
- what it is (variable, engine sign-in, engine-managed connector),
- the account the service sees, where Isomux knows it (for a sign-in: the account email or org it already shows; for a variable: nothing, say so),
- who gets it ("Office-wide": every agent; "Individual": that member's agents by default, not locked to them),
- where it is set, with a link to that place (this page's editor, the engine's own settings).

Sources:
- Variables: names only, never values, from the existing office and personal env routes.
- Engine sign-ins: the provider accounts the pane already loads.
- Engine-managed connectors: Claude's claude.ai connectors. A claim to verify, not a conclusion: the Claude SDK's system init message lists the session's MCP servers with names and status, and claude.ai connectors appear with a "claude.ai " name prefix. If that holds, record the latest list per Claude sign-in from sessions the server already runs; do not start a session only to probe. Show each as "Managed in Claude" with a link to claude.ai's connector settings and the sentence that every Claude agent in the office can use it. Check whether Codex or OpenCode expose engine-managed connectors the same cheap way; if not, show none for them and say so in the report.

Traps:
- The secrets loop adds a Secrets list next to the variables list in the same pane. Keep your change to ConnectionsPane to one mount point for a new component, and do not restructure the variables section, so the two loops merge cleanly.
- Members see the office half read-only today; keep the same access rules for the list.
- Copy: short; Nil strips the obvious. Every new string in all four catalogs (en, es, ca, zh).

Acceptance: the page shows a variable, a sign-in and (where the box has one) a claude.ai connector correctly for an owner and a member, desktop and mobile; no route returns a variable value; tests cover the list's data shape and the access rules; the reviewer re-runs the scoped tests on the approved hash.

Decide with the reviewer: the component and route shape for the list; where the connector list is recorded.
Locked: rulings 1-12.

## Probe facts (Worker 5, 2026-10-13; full report in internal-docs/private/engine-mcp-proxy-probe-20261013.md, not in git)

- Claude: register with `q.setMcpServers({...})` on the live Query after start, on create and every resume. The `mcpServers` option puts headers on the CLI's argv (visible in `ps`), and `${VAR}` headers put the value in the environment. An SDK server replaces a same-name user or project server, but on the `setMcpServers` path the project's server connects briefly first. `q.mcpServerStatus()` lists every server with scope (`dynamic`, `user`, `project`, `claudeai`) and status, with no model turn.
- Codex: the per-thread `config` map already sent on `thread/start` and `thread/resume` (`CODEX_THREAD_CONFIG_OVERRIDES`), keys `mcp_servers.<name>` with `url` and `http_headers`. Not `-c` (argv), and not `env_http_headers` or `bearer_token_env_var` (environment). The merge with `config.toml` is per key, so a same-name entry mixes. Status: `mcpServerStatus/list`. Streamable HTTP only.
- OpenCode: the per-member `OPENCODE_CONFIG` file, `mcp.<name> = {type:"remote", url, headers, oauth:false, enabled:true}`. A change needs the config revision and a server restart (the supervisor already does this). The merge is deep: a project entry that changed only `url` inherited Isomux's Authorization header. Production is safe only because `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `--pure` and the per-profile XDG directories block other layers; keep them and pin them with a test. Status: `GET /mcp`.
- Every Isomux-registered server gets a reserved name prefix (`isomux-`) so it never clashes with a user's own server.

## SLICE-A2 PICKUP: remote MCP servers, registered once for every engine

Starts after A1 and secrets slice B1 are merged into main (it uses B1's secret store).

Goal: an owner registers a remote MCP server for the office, or a member for their own agents, once: a name, a URL and, if the server needs one, a credential. Claude, Codex and OpenCode agents in that scope all get it, through the mechanisms in "Probe facts". The integrations page lists it with the A1 fields, and the engine's own servers (user and project `.mcp.json` for Claude) show beside it with where they are set.

Mechanics and traps:
- The credential is a secret from the secrets loop's store (ruling 6): the member picks an existing secret or creates one in the same form, bound to the MCP server's host. Until secrets slice B2 lands, Isomux passes the real value through the channels above (never argv, never environment); B2 switches it to the placeholder.
- Office servers are owner-only to add and change, like office variables and secrets.
- A change reaches running agents on their next session start (Claude and Codex) or profile restart (OpenCode); say so on the page.
- OAuth servers (for example Gmail): decide with the reviewer whether the MCP authorization flow (Isomux as the OAuth client, the refresh token stored as a secret) fits in A2. If it does not, A2 ships static-credential servers and writes the plan for A2b, and the report says so.
- Tests: each engine's adapter gets the server in the right shape; no value on argv or in an agent's environment (check the spawn arguments and env the tests already capture); the OpenCode lock stays pinned; the name prefix.

Acceptance: a stub remote MCP server registered once at office scope and once at member scope reaches a Claude, a Codex and an OpenCode agent in a throwaway office (status from each engine's status call, no model turn), and the page shows both with their scope. The reviewer re-runs it on the approved hash.

Decide with the reviewer: the route and store shape for registrations; OAuth in A2 or A2b.
Locked: rulings 1-12.

## SLICE-A2b PLAN: OAuth MCP servers (Worker 2 and Reviewer 2, 2026-10-13; not started)

A2 ships servers with a static credential only. A server that needs the MCP authorization flow (for example a hosted Gmail or Notion server) is A2b. The flow needs, at least: discovery of the server's authorization metadata, dynamic client registration (or a client id the member pastes), PKCE, a callback route on the office origin, a refresh loop, and storage of the refresh token. The access token expires about every hour, so a B2 placeholder for it would change at each refresh.

Two designs. The Lead chooses before code:

1. Isomux is the OAuth client. Isomux runs the flow once per registration and stores the refresh token as a secret of the registration's scope (bound to the server's host). Isomux refreshes the access token and gives it to each engine as the A2 header, so it reaches Claude, Codex and OpenCode the same way and fits B2: the proxy can put the current access token in for a fixed placeholder. Costs: a callback route and a refresh loop in the server, and the office must be reachable at its own origin from the member's browser (it is, for sign-in).
2. Each engine's own MCP OAuth. Claude reports a server that needs it as `needs-auth` (`mcpServerStatus`) and keeps the tokens in the sign-in's config directory; Codex has `mcpServer/oauth/login` on the app-server and keeps them under CODEX_HOME; OpenCode keeps them in `mcp-auth.json` per profile (backup.ts already leaves that file out). Isomux registers the server without a header and asks the member to sign in once per engine and per sign-in or profile. Costs: up to three sign-ins for one server, tokens on disk in three formats, no B2 placeholder, and a per-engine login UI. From the generated types and the probe report only; not run.

Recommendation: 1, because it keeps "register once, every engine gets it" (ruling 5) and the B2 promise.



## SLICE-A3 PICKUP: Test button and diagnostics per connection

Goal: each row of the All connections list that Isomux can check gets a Test button. A test says whether the connection works now, and when it can, which account the service sees. A failure shows a short reason a member can act on. A row that Isomux cannot test says so; it has no dead button.

Per kind (decide the details with the reviewer):
- Engine sign-in: reuse the existing provider account check (the refresh the sign-in card already does).
- Secret with a preset: the server itself makes one read-only call to the preset's identity endpoint (for example GitHub GET https://api.github.com/user, Stripe GET https://api.stripe.com/v1/account, Fly's viewer query) with the value, and shows the account the service names (login, account id or email). The call goes only to a host the secret lists. A secret on a custom host: no test.
- Remote MCP server: the server connects to it the way an engine does (initialize, then tools/list) with its credential, and shows the server's name and the number of tools, or the error. Use a client the repo already ships if there is one; the probe's stub rig in /tmp/b1022/probe/ shows the protocol.
- Claude connectors and MCP servers set in Claude: show the status the record already has (connected, failed, pending); no extra test.
- Variable: no test (Isomux does not know which service it is for).

Traps:
- A test result and its error text never hold a credential, a URL path or a query (hosts only), in the response, the page, the audit log or the server log. Fake-value tests per kind, as B1 did.
- Rate: one test at a time per connection; a timeout (10 s) per test.
- A member can test only what they can see in the list; office secrets and office MCP servers: owners.
- The secrets proxy (loop B) may land during this slice. Tests run in the server, not through the proxy.
- Run ui/App.settings-*.dom.test.tsx and ui/audit-operations.test.ts (gates).

Acceptance: in a throwaway office with stub HTTPS hosts for a GitHub-preset secret and an MCP server, Test shows the account and the tool count; a wrong credential shows a short reason; nothing holds the fake value. Screenshots desktop and mobile. The reviewer re-runs the tests and the stub run on the approved hash.

Decide with the reviewer: the route shape (one test route per kind or one generic); where results are kept (memory is fine).
Locked: rulings 1-12.
