---
navTitle: Full feature list
---

# Full feature list

Isomux is a meta-harness: it sits one level above Claude Code and Codex and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration features, a mobile UI, and more.

## Multi-provider

- **Choose Claude or Codex** when spawning an agent, and switch an agent between them whenever you want. The `/resume` list for an agent mixes Claude and Codex chats.
- **Codex ships bundled** — no separate install. The first time you message a Codex agent, isomux prompts you to sign in via a one-click terminal card. (Claude CLI is still a separate user install for now.)

## Multi-agent

### Agent coordination

- **Discovery** via a shared office manifest — every agent can look up who else is in the office (name, room, desk, cwd, model, topic), scoped to the rooms its manager can see.
- **Cross-conversation reads** — each agent has access to the live conversation logs of every other agent. Ask "what does Isomuxer3 think of this?" and it just works.
- **Shared memory** — agents can record durable, attributed facts about people, projects, conventions, and the environment. Those notes outlive any one session and surface automatically in the relevant agents' context as notes, not rules. Memory can be office-wide, per-room, per-agent, or per-person, so something one agent learns can inform the others; humans can curate it by hand as plain text next to each level's prompt.
- **Agent-to-agent messages** — one agent can drop a message into another agent's chat.
- **Scheduled messages** — an agent can schedule a message to another agent, or to itself, for a future time: reminders, wake-ups, follow-up checks. Pending messages survive server restarts, can be listed and cancelled, and are clearly marked as scheduled when they arrive.
- **Mixed queue** — messages from any human (across devices) and any other agent share one queue per receiver. If the receiver is busy, queued messages coalesce into a single follow-up turn.
- **Shared task board** — humans and agents can create, assign, claim, close, or shelve tasks to a backlog. Full interop via UI and HTTP API.
- **Privileged agents**: agent can be granted operator access, allowing them to drive other agents the way you do from the UI, like resuming or starting conversations, jumping the queue, aborting a stuck turn, and managing cron jobs.
- **Reflection**: privileged agents can tweak every office feature, like creating rooms, spawning agents, setting room/agent prompts, etc.

### Prompts, skills, and commands

- **Hierarchical system prompts** — office-wide, per-room, and per-agent prompts compose into one assembled system prompt for every agent, all editable from the UI.
- **Custom instructions per agent**, editable at spawn and later.
- **Agent-collaboration skills**: `/pair-programming`, `/peer-review`, `/soft-handoff`, `/second-opinion`, `/subagent-review`.
- **Other bundled skills**: `/grill-me` (based on the original by Matt Pocock), `/isomux-report-bug`.
- **Inspection commands**: `/isomux-all-hands`, `/isomux-system-prompt`, `/isomux-cronjob-system-prompt`, `/isomux-usage`.

## Multi-user

- **Multi-user real-time collaboration** — multiple authenticated users can chime in to the same conversation simultaneously.
- **Invite-link access** — owner mints a URL per device, sends it out-of-band, the invitee clicks and is signed in. No accounts, no passwords.
- **Per-member room access** — owners pick which rooms each member sees: on the member's invite (so they land in the right rooms from the first click) or any time from their user settings.
- **Live user presence** — other connected people (and your other devices) appear as small floating ghosts in the office, parked next to the agent they're viewing. The name tag above each ghost shows username and device. Click a ghost to open that user's settings.
- **Customizable ghosts** — each user picks a color and one of 8 ghost styles from User Settings.

## Multi-device

- **Works on a headless server** — run on a Mac Mini or Linux box, access from your VPN or publicly via Tailscale Funnel / reverse proxy.
- **Open from your phone** — same server URL (VPN or public), touch-optimized UI.
- **Agent list view** as an alternative to the isometric office on small screens.
- **Installable as a PWA** for a native-app feel: on iPhone, use Safari's "Add to Home Screen"; on Android, Chrome prompts you to install on first visit (HTTPS or localhost).
- **Real-time updates** — every connected device (laptop, phone, others) sees the same conversations and the same filesystem in real time via WebSocket; no syncing headaches.

## Cute in a useful way

_The UI makes agent state spatial and glanceable, so you remember who is doing what._

- **Isometric rooms with 8 desks** — see all your agents at a glance.
- **Unique character per agent** — customize color, hat, shirt, hair, accessory, with live preview (or randomize).
- **Animated characters** — sleeping when idle, typing when working, waving when waiting for you.
- Desk monitors **glow based on agent state** (green / purple / red).
- Status light with **escalating hung-agent warnings**: amber at 2 min, red at 5 min.
- **Activity badge** on desk when an agent needs attention.
- **Sound notification** when an agent finishes and the browser tab is unfocused.
- Auto-generated **conversation topic** below nametag.
- **Drag agents between desks or rooms** to rearrange.
- **Skeuomorphic touches**: click the moon through the window to toggle dark mode, click doors to switch rooms, etc.
- **Color themes**: Dark, Light, Nord, Dracula, Solarized Dark/Light.

## Quality-of-life

### Conversation controls

- **Input drafts preserved** when switching between agents.
- **Markdown rendering** for agent output.
- **Collapsible thinking and tool-call cards** with timing for each step (errors are expanded automatically).
- **Structured API-call cards**: when an agent curls the isomux API, the tool-call row says what the call does in plain language, plus its key payload fields.
- **Last user message pinned** at the top of the viewport, so you always see what you asked while the agent is working.
- **Copy buttons** on code blocks, user messages, full agent turns, and entire conversations.
- **Send now** to flush the message queue immediately while the agent is busy, via the button or by sending your message with Ctrl/Cmd+Enter.
- **Ctrl+C to interrupt** — cleanly aborts and lets you resume.
- **Conversation branching** — edit a past message to fork the conversation from that point, preserving the original.
- **Right-click context menu** — resume past sessions, edit agent, kill.
- **File attachments** — agents understand images and PDFs. Upload via button, drag-and-drop, or paste.
- **Image display** — agents can show images inline in the conversation.
- **Voice-to-text** prompting via the browser's `SpeechRecognition` API (HTTPS or localhost).
- **Text-to-speech** for agent replies via the browser's `SpeechSynthesis` API.

### Developer tools

- **Embedded terminal** for direct shell access per agent. Copy/paste works with the usual shortcuts: Cmd+C/V on Mac; on Windows and Linux, Ctrl+V pastes and Ctrl+C copies when text is selected (and interrupts, as usual, when nothing is selected).
- **Built-in file editor**: syntax highlighting, file tabs, resizable alongside the chat. Open files via `/isomux-edit` (agents can offer this too via "[Open in editor]" cards).
- `/isomux-diff` — rich-rendered uncommitted changes. Agents can also choose to emit a diff card on their own.
- **Browser preview cards** — agents can screenshot a local web page (their dev server, a dashboard) straight into the chat, so you see UI changes without alt-tabbing to a browser. Needs a Chrome-family browser installed on the server (runs headless, so no display is needed); everything else works without one.
- `/isomux-usage` — per-agent / per-room / per-cron-job token spend.
- **Plugin system**: add memory, audit, or other turn-aware behavior. Reference [mem0 plugin](https://github.com/nmamano/isomux-mem0) gives agents long-term memory across sessions.

### Navigation and shortcuts

- **Number keys 1–8** jump to agents from office view.
- **Tab / Shift+Tab** cycle between agents in chat view.
- **Escape** returns to office.
- **Built-in slash commands**: `/clear`, `/help`, `/context`, `/resume`, `/model`, `/effort`.
- **Spawn dialog**: pick model, permission mode, thinking effort, and working directory (with recent-CWD suggestions) when creating an agent.
- **Autocomplete dropdown** with keyboard navigation for slash commands.
- **User skills** from `~/.claude/skills/` and project commands.

### Cron jobs

- **Schedule recurring agent runs**: daily at HH:MM, weekly on a weekday, or every N minutes.
- Each run is a **fresh agent session** with the same configurability as a desk agent (model, effort, cwd, permission mode).
- **Browsable run history**: every run is preserved as a transcript.
- **Resume or fork** any past run, turning a daily summary into an interactive follow-up.
- **Manual "Run now"** for any cron job, independent of the schedule.
- Per cron job token usage rolled into `/isomux-usage`.

### Lifecycle and safety

- **Agents persist across server restarts**; auto-resume last conversation on restart.
- **Per-agent session history** with `/resume` support.
- **Kill** removes agent and frees desk.
- **Built-in safety hooks (Claude agents)** — blocks `rm -rf`, `git reset --hard`, and other footguns out of the box. Codex agents don't have equivalent hooks (Codex doesn't expose a programmatic hook surface).
- **Secrets via env files** — keep API tokens and other secrets out of prompts: point the office (or each user, from their user settings) at an env file, and its variables are loaded into agents' environment at spawn time, with per-user values overriding office-wide ones. Secrets are injected into the agent's environment without embedding their values in prompts or conversation logs.
- **Daily local backup and restore**: `~/.isomux/` (agents, conversations, settings, cron history, every agent's session logs) is snapshotted once a day to `~/isomux-backups/isomux-YYYY-MM-DD.tar.gz` (override path with `ISOMUX_BACKUP_DIR`). Last seven tarballs kept; older ones pruned. Snapshots are live and atomic so they can't capture half-written state. Restore is manual: stop the service, move `~/.isomux` aside, `tar -xzf` the chosen tarball into `~`, restart. Current backup state is at `GET /backup/status`. SDK session transcripts (`~/.claude/projects/`) are not in scope — prefer starting fresh sessions after a restore rather than resuming.
