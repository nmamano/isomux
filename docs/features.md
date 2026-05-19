---
navTitle: Full feature list
---

## Office View

- **Isometric office with 8 desks** — see all your agents at a glance
- **Name your agents** — each gets a nametag on their desk
- **Unique character per agent** — customize hat, shirt, hair, accessory, or randomize
- **Animated characters** — sleeping when idle, typing when working, waving when waiting for you
- Desk monitors **glow based on agent state** (green / purple / red)
- Status light with **escalating warnings**: amber at 2 min, red at 5 min
- Auto-generated **conversation topic** below nametag
- **Drag agents between desks** to rearrange
- **Color themes**: Dark, Light, Nord, Dracula, Solarized Dark/Light. Click the moon through the window to switch between dark and light
- **Live user presence**: other connected people (and your other devices) appear as small floating ghosts in the office, parked next to the agent they're viewing. Each user picks a color and one of 8 ghost styles from User Settings. The name tag above each ghost shows username and device. Click a ghost to open that user's settings.

## Agent Creation & Editing

- **Click empty desk to spawn** — name, provider (Claude/Codex), working directory, model, permission mode, custom instructions. Provider is fixed for the agent's lifetime.
- Working directory input with **recent CWD suggestions**
- **Outfit customization**: color swatches, hat, accessory, randomize with live preview
- **Hierarchical system prompts** — office-wide, per-room, and per-agent prompts compose into one assembled system prompt for every agent, all editable from the UI
- **Custom instructions** per agent, editable at spawn and later

## Conversation View

- **Input drafts preserved** when switching between agents
- **Markdown rendering** for agent output
- **Collapsible thinking and tool-call cards** with timing for each step
- **Copy buttons** on code blocks, user messages, full agent turns, and entire conversations
- **Message queueing**: messages sent while the agent is busy are queued. Click **Send now** to flush the queue immediately
- **File attachments**: agents understand images and PDFs. Upload them via button, drag-and-drop, or paste
- **Image display**: agents can show images inline in the conversation
- **Embedded terminal** for direct shell access per agent
- **Built-in file editor**: syntax highlighting, file tabs. Resizable alongside the chat. Open files via `/isomux-edit`, or click "[Open in editor]" cards that agents emit
- **Conversation branching** — edit a past message to fork the conversation from that point, preserving the original
- **Right-click context menu** — resume past sessions, edit agent, kill

## Keyboard Shortcuts

- **Number keys 1–8** jump to agents from office view
- **Tab / Shift+Tab** cycle between agents in chat view
- Escape returns to office
- **Ctrl+C to interrupt** — cleanly aborts and lets you resume

## Slash Commands & Autocomplete

- Built-in commands: `/clear`, `/help`, `/context`, `/resume`, `/model`, `/effort` (thinking effort), `/usage` (per-agent / per-room / per-cron-job token spend)
- Isomux additions: `/isomux-all-hands`, `/isomux-system-prompt`, `/isomux-cronjob-system-prompt`, `/isomux-diff` (rich-rendered uncommitted changes; agents can also choose to show a diff card on their own), `/isomux-edit` (open a file in the side-panel editor; agents can offer this on their own too)
- **Bundled skills** like `/isomux-grill-me` (based on the original `/grill-me` by Matt Pocock), `/isomux-peer-review`, `/isomux-pair-programming`, `/isomux-soft-handoff`, `/isomux-subagent-review`, `/isomux-report-bug` — available to every agent out of the box
- User skills from `~/.claude/skills/` and project commands
- **Autocomplete dropdown** with keyboard navigation

## Cron jobs

- **Schedule recurring agent runs**: daily at HH:MM, weekly on a weekday, or every N minutes
- Each run is a **fresh agent session** with the same configurability as a desk agent (model, effort, cwd, permission mode)
- **Browsable run history**: every run is preserved as a transcript
- **Resume or fork** any past run, turning a daily summary into an interactive follow-up
- **Manual "Run now"** for any cron job, independent of the schedule
- Per cron job token usage rolled into `/usage`

## Inter-agent Communication

- **Discovery**: every agent reads the shared `agents-summary.json` for who else is in the office (name, room, desk, cwd, model, topic)
- **Cross-conversation reads**: each agent has access to the live conversation logs of every other agent. Ask "what does Isomuxer3 think of this?" and it just works
- **Agent-to-agent messages**: one agent can drop a message into another's chat
- **Mixed queue**: messages from any human (across devices) and any other agent share one queue per receiver. If the receiver is busy, queued messages coalesce into a single follow-up turn
- **Shared task board**: humans and agents can create, assign, claim, close, or shelve tasks to a backlog. Full interop via UI and HTTP API

## Persistence & Lifecycle

- **Agents persist across server restarts**
- **Auto-resume last conversation** on restart
- Agent manifest for **inter-agent discovery**
- **Resume past conversations** from session files
- Kill removes agent and frees desk

## Mobile Support

- **Open from your phone** — same server URL (tailnet or public), touch-optimized UI
- **Instant sync** — laptop and phone see the same state in real time over WebSocket
- **Agent list view** as an alternative to the isometric office on small screens
- **Full conversation view** with readable font sizes and two-row header
- **Send & abort buttons** for touch input
- Safe area insets for notch/home bar devices
- **Installable as a PWA** for a native app feel: on iPhone, use Safari's "Add to Home Screen"; on Android, Chrome prompts you to install on first visit (HTTPS or localhost)

## Notifications

- **Sound notification** when agent finishes and tab is unfocused
- **Activity badge** on desk when attention needed

## System & Backend

- **Real-time sync via WebSocket** — every connected device stays in lockstep
- **Multi-user real-time collaboration** — multiple authenticated users can chime in to the same conversation simultaneously
- **Single Bun process** — no bundler, no database, minimal deps
- **Reuses CLI auth from the underlying provider** — your Claude or ChatGPT subscription works out of the box; no separate API key needed
- **Built-in safety hooks** — blocks `rm -rf`, `git reset --hard`, and other footguns out of the box
- **Works on a headless server** — run on a Mac Mini or Linux box, access from your tailnet or publicly via Tailscale Funnel / reverse proxy
- **Daily local backup and restore**: `~/.isomux/` (agents, conversations, settings, cron history, every agent's session logs) is snapshotted once a day to `~/isomux-backups/isomux-YYYY-MM-DD.tar.gz` (override path with `ISOMUX_BACKUP_DIR`). Last seven tarballs kept; older ones pruned. Snapshots are live and atomic so they can't capture half-written state. Restore is manual: stop the service, move `~/.isomux` aside, `tar -xzf` the chosen tarball into `~`, restart. Current backup state is at `GET /backup/status`. SDK session transcripts (`~/.claude/projects/`) are not in scope — prefer starting fresh sessions after a restore rather than resuming.
