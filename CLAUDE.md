# Isomux

An isometric 2D office UI for managing multiple concurrent Claude Code agents. Each agent sits at a desk in a browser-based office. The core abstraction separates the **agent** (persistent human) from the **conversation** (ephemeral task).

See [isomux.com](https://isomux.com) for a full feature overview and setup instructions.

## How to develop

- **Rebuild UI after changes:** `bun run build:ui`. If `ui/index.html` was modified, also `cp ui/index.html ui/dist/index.html`. The server reads from `ui/dist/` on each request — no restart needed. **Do NOT build to `ui/index.js`; that path is not served.**
- **Restart server:** `systemctl --user restart isomux`. This kills the process all agents run on — every active agent session is interrupted. The user will need to proactively continue any in-progress conversations afterward.
- **URL:** http://localhost:4000 (server machine) or http://TAILSCALE_SERVER_ALIAS:4000 (laptop, phone, etc.)
- **Debug agent issues** by reading logs at `~/.isomux/logs/<agentId>/<sessionId>.jsonl` — don't ask the user to copy-paste.
- **Don't ask the user to run commands — just do it.**
- After completing a feature or batch of fixes, offer to the user to commit and push.

## Key decisions (do not revisit)

- Single Bun process (no Node) — serves UI, manages agents in-process via SDK, talks to browser over WebSocket.
- Agent SDK V2 (`unstable_v2_createSession`) with subscription auth. High risk tolerance on alpha API.
- WebSocket only — no HTTP/REST API.
- React/SVG for rendering. No Vite. Bun's bundler, manual refresh.
- No database. In-memory state, flat file logs, `agents.json` for persistence.
- 8 desks max. Agent = persistent identity (name, desk, outfit, cwd). Conversation = ephemeral SDK session.
- Agents persist across restarts. Auto-resume last conversation on startup.
- Default model: Opus 4.6. No per-agent model selection.
- SDK spawns CLI subprocesses which inherit the user's global Claude skills and MCP config.
- `reference_ui.jsx` (in `docs/`) is a visual spec, not code to refactor.
- Not in scope: agent-to-agent communication (but they can see each other's logs), remote agents (we support remote connections via Tailscale instead), a CLI isomux tool.

## Project layout

- `server/` — Bun HTTP + WebSocket server, agent lifecycle, SDK integration
- `ui/` — React frontend
- `shared/` — TypeScript types shared between server and UI
- `site/` — Landing page deployed to isomux.com via Vercel
- `docs/` — Design documents, plans, and reference material
- `skills/` — Claude Code skills bundled with the project, available to any isomux agent

### Key paths

- `~/.isomux/agents.json` — persisted agent configs
- `~/.isomux/logs/` — agent conversation logs
- `~/.isomux/launchers/` — launcher scripts (cwd workaround for SDK - details in docs/sdk-investigation.md)
- `ui/dist/` — UI build output (gitignored)
