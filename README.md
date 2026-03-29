# Isomux

An isometric office for managing multiple concurrent Claude Code agents. Each agent sits at a desk, has a unique outfit, and visually reflects its current state.

![Isomux office view](screenshot.png)

## Prerequisites

- [Bun](https://bun.sh/) (v1.2+)
- [Claude Code](https://claude.ai/code) CLI installed and authenticated with a Claude Pro or Max subscription

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Verify Claude Code is installed and logged in
claude --version
```

## Setup

```bash
bun install
bun run dev
```

Then open http://localhost:4000.

## How it works

- Click an empty desk to spawn a new agent
- Click an agent to open the conversation view
- Send messages to give agents tasks
- Right-click an agent for actions (new conversation, resume, kill)
- Agents persist across restarts with conversation history
- Press Escape to return to the office view
- Sound notification plays when an agent finishes and the tab is unfocused

Agents use your Claude subscription via the Agent SDK — no API key or per-token billing required.

## Deployment

Isomux runs as a systemd user service with automatic restart.

```bash
# Start/stop/restart the service
systemctl --user start isomux
systemctl --user stop isomux
systemctl --user restart isomux

# Check status
systemctl --user status isomux

# View logs
journalctl --user -u isomux -f
```

The service automatically rebuilds the UI before each start. Agents survive restarts — they are persisted to `~/.isomux/agents.json` and sessions resume automatically.
