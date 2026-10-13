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

## Decision protocol

- Worker and reviewer settle implementation choices inside a slice.
- The Lead settles anything that changes scope, a public interface (route shape, state layout) or a ruling. Ask the Lead; do not pick.
- A product tradeoff with no clear answer goes into the slice report as PARKED FOR NIL with a recommendation first; the loop continues on the rest.
- Anything that would change a ruling above, or touch the OS-user split, is PARKED FOR NIL.

## Gates (every hand-off)

The room prompt gates: `bun run build:ui` (plus `bun run build:demo` when the diff touches ui/demo-server.ts or shared/storage-labels.ts), scoped tests on the touched area, eslint on touched files, `bunx tsc --noEmit` (inside a MemoryMax=2G scope: `NODE_OPTIONS=--max-old-space-size=1700`). Add server/test-support/routes-table.test.ts and routes-agents-manifest.test.ts when a route changes, server/test-support/identity-tokens.test.ts when a scope's capabilities change, and server/backends/opencode/authority-broker.prompt-routes.test.ts when an agent-reference page or the system prompt names a route. A new agent-facing route also goes in ROUTE_LABELS in ui/log-view/isomux-curl.ts. Update the doc surfaces in internal-docs/documentation.md that the slice makes stale.

UI slices show the page in headless Chrome (internal-docs/ui-verification.md), desktop and mobile width, in the report.

## Prohibitions

- Never restart the running office server; never use sudo; never print a credential (verify secrets with grep -q, ls and wc only).
- Never read, scan or archive ~/.claude/projects.
- Real-engine checks use a throwaway ISOMUX_HOME and a spare port, never the live office.

## Slices

- [ ] A1: the page lists every connection, read-only
- [ ] A2: remote MCP servers registered once for every engine (waits for the probe report)
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
Locked: rulings 1-10.
