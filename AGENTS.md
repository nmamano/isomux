# Isomux

Isomux is an agent management system. See the README.md for a full feature overview and setup instructions.

## How to develop

The running server is on localhost:4000, managed by systemd as the user-level service `isomux`.

Server-side code changes always require a restart. Restarting the server is mildly disruptive: it stops every agent in the office until the user re-engages them.

For UI changes, run `bun run build:ui`. Outputs to `ui/dist/`, which the server reads per-request. No server restart needed, only a page refresh.

Proactively remind the user of what steps they need to take to do what they want: e.g., to test a front-end only change, or a server change in main, or a change in a worktree. Offer to do the steps yourself. After completing a feature or batch of fixes, offer to the user to commit.

If an action runs into permission issues because it's a destructive action, let the user know and give them the command they need to run to do it themselves.

Debug agent issues by reading logs at `~/.isomux/logs/<agentId>/<sessionId>.jsonl`.

## Formatting and linting

Run prettier ONLY AFTER final human approval for commit. Do NOT format changes before human review. In particular, only run `prettier --write` after final approval; it changes files in disk which corrupts agent context and triggers file re-reads.

Run ESLint during development. A good time to do it is right before human review.

## Key decisions (do not revisit)

- Single Bun process. No Node, no separate API server, no database — flat-file state only.
- Agent = persistent identity. Conversation = resumable session.
- 8 desks per room.
- Subscription auth via the provider's own CLI — Isomux never handles API keys.
- Browser auth: invite-link cookie sessions. The first boot prints a one-time owner-bootstrap URL; once an owner exists, only owners can mint further invites. Agents inherit no special auth privileges. See `docs/access-and-invites.md`.
- REST API to give agents extra affordances (like messaging other agents or showing a diff).
- Codex integration uses the App Server, not `@openai/codex-sdk`. App Server is OpenAI's first-class integration for UI clients.
- React/SVG for rendering. Bun's bundler, no Vite.

## Project layout

- `site/` — Landing page and demo, deployed to isomux.com via Vercel. Demo is built from `ui/demo-entry.tsx` + `ui/demo.html` into `site/demo/` (see `vercel.json`).
- `internal-docs/` — Design documents, plans, and reference material. `documentation.md` is the index of every user-facing copy surface to update when features change.
- `skills/` — Skills bundled with the project, available to every isomux agent.
- `shared/` — TypeScript types shared between server and UI.
- `server/` — Bun HTTP + WebSocket server, agent lifecycle, provider backends.
- `ui/` — React frontend.

### Key paths

- `~/.isomux/` — all persisted state: agent configs, conversation logs, cronjobs, tasks, office prompt, user profiles.
- `ui/dist/` — UI build output (gitignored).
