# Isomux

Isomux is a meta-harness: it sits one level above Claude Code and Codex and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration, a mobile UI, and more. See the README.md for a full feature overview and setup instructions.

## How to develop

The running server is on localhost:4000, managed by systemd as the user-level service `isomux`.

Server-side code changes always require a restart. Restarting the server is mildly disruptive: it stops every agent in the office until the user re-engages them.

For UI changes, run `bun run build:ui`. Outputs to `ui/dist/`, which the server reads per-request. No server restart needed, only a page refresh.

Proactively remind the user of what steps they need to take to do what they want: e.g., to test a front-end only change, or a server change in main, or a change in a worktree. Offer to do the steps yourself. After completing a feature or batch of fixes, offer to the user to commit.

If an action runs into permission issues because it's a destructive action, let the user know and give them the command they need to run to do it themselves.

Debug agent issues by reading logs at `~/.isomux/logs/<agentId>/<sessionId>.jsonl`.

Look at UI changes instead of assuming them. A box set up by `deploy/install.sh` normally has a headless Google Chrome at `/usr/bin/google-chrome` (the installer warns and carries on when it could not install one), and there are two ways to use it: the `preview-url` card, which screenshots a page straight into the chat, and Playwright launched with `channel: "chrome"`, which drives that same Chrome. Taking that route, Playwright needs no browser download of its own: no `npx playwright install`, and for Chromium no `playwright install-deps` either, since Chrome's package already pulls in the shared libraries it would install.

## Formatting and linting

Run prettier ONLY AFTER final human approval for commit. Do NOT format changes before human review. In particular, only run `prettier --write` after final approval; it changes files in disk which corrupts agent context and triggers file re-reads.

Run ESLint during development. A good time to do it is right before human review.

## Key decisions (do not revisit)

- Single Bun process. No Node, no separate API server, no database - flat-file state only.
- Agent = persistent identity. Conversation = resumable session.
- 8 desks per room.
- Subscription auth via the provider's own CLI - Isomux never handles API keys.
- Browser auth: invite-link cookie sessions. The first owner claims via a tokenless name-picker form served on loopback (the server binds 127.0.0.1 pre-claim); once an owner exists, only owners can mint further invites. By default agents inherit no special auth privileges; an opt-in per-agent `privileged` flag grants a curated subset of the spawning user's room-scoped operator capabilities (drive other agents' sessions + cron over its own jobs) while keeping agent scope (never impersonates the user, never reaches owner/user administration). See `docs/access-and-invites.md`.
- REST API to give agents extra affordances (like messaging other agents or showing a diff).
- Single Bun process means no caller-controlled CPU-bound work on the main thread. Conversation-log search is the one place that would otherwise break this (caller-supplied regexes plus JSON parsing over every session), so its scan runs in a short-lived child process the parent can SIGKILL - `server/log-search-child.ts`. A Worker was tried first and is NOT sufficient: `terminate()` does not preempt running JavaScript, so a scan with no interruption point cannot be stopped at all. Only a killable process gives a real deadline. The invariant is architectural, not a benchmark: aggregate caller-controlled matching cost is unbounded, belongs off the event loop, and must be stoppable. Measurements live in that module's header and its test, not here.
- Agent-built apps run as systemd **user** units that isomux generates; `server/app-supervisor.ts` is the only runtime module that manages those units. The registry owns names and ports: both are fixed for an app's whole life, and deleting an app frees both for reuse. A name's hostname is stable across reuse; a separate registration identity binds and retires all server-held sessions, credentials and routes before the name or port becomes free. `server/app-hosts.ts` classifies an incoming Host before URL parsing, authentication, and route dispatch, and diverts an app hostname into its own arm (`app-auth.ts`, `app-proxy.ts`, `app-ws-relay.ts`), which can never reach an office route. `tls-ask.ts` is the certificate-admission route the terminator calls over loopback; it is an office route, refused at the public edge. An app is also an identity: `server/app-tokens.ts` mints it a token whose one capability reaches one route - messaging the agent that registered it. The token store keeps only the hash; the raw value lives in the app's 0600 systemd EnvironmentFile, which is what lets the token survive an isomux restart without bouncing the app.
- Codex integration uses the App Server, not `@openai/codex-sdk`. App Server is OpenAI's first-class integration for UI clients.
- React/SVG for rendering. Bun's bundler, no Vite.

## Project layout

- `site/` - Landing page and demo, deployed to isomux.com via Vercel. Demo is built from `ui/demo-entry.tsx` + `ui/demo.html` into `site/demo/` (see `vercel.json`). `site/docs/**` and `site/demo/index.html` are build outputs (gitignored, regenerated by `bun run build:docs` and the Vercel build) - editing them directly looks like it works, then vanishes on the next deploy. Edit `scripts/build-docs.ts` and `ui/demo.html` instead.
- `internal-docs/` - Design documents, plans, and reference material. `documentation.md` is the index of every user-facing copy surface to update when features change.
- `deploy/` - Unattended VPS installer (`install.sh`), documented in `docs/vps-install.md`. Its helper scripts (`harden-ssh.sh`, `oom-protect.sh`, installed on the box as `isomux-harden-ssh` / `isomux-oom-protect`) are also **embedded verbatim inside `install.sh`**, which is downloaded and run on its own and cannot read repo files. Edit the helper, then run `bun run scripts/embed-deploy-scripts.ts`; `deploy/install-sh.test.ts` fails if the copies drift.
- `control-plane/` - Provisioning for hosted isomux: the provider adapter (Contabo) and the SSH driver that turns a provider API call into a live HTTPS office, then removes our own access and proves it is gone. An operator CLI, not part of the server - nothing here runs in an office. Its `README.md` records what the Contabo API actually does, which differs from its documentation in several load-bearing ways. Design: `internal-docs/control-plane-design.md`.
- `scripts/` - Build and release tooling: `build.sh` (UI bundle), `release.sh` (tag a CalVer release), `update.sh` (customer-box updater; installed as `isomux-update`), `embed-deploy-scripts.ts` (sync the copies above). Release process: `internal-docs/release-design.md`.
- `skills/` - Skills bundled with the project, available to every isomux agent.
- `shared/` - TypeScript types shared between server and UI.
- `server/` - Bun HTTP + WebSocket server, agent lifecycle, provider backends.
- `ui/` - React frontend.

### Key paths

- `~/.isomux/` - all persisted state: agent configs, conversation logs, cronjobs, tasks, office prompt, user profiles.
- `ui/dist/` - UI build output (gitignored).
- `server/isomux-office.ts` - the server entry point, named so the office's command line is recognizable. `server/index.ts` remains as a shim for systemd units written before the rename - don't delete it.
