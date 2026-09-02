---
navTitle: Full feature list
---

# Full feature list

Isomux is a meta-harness: it sits one level above Claude Code, Codex, and OpenCode and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration features, a mobile UI, and more.

## Multi-provider

- **Choose Claude, Codex, or OpenCode** when spawning an agent, and switch an agent between them whenever you want. The `/resume` list mixes chats from all three engines.
- **OpenCode ships bundled and pinned**. Choose a connected model, or connect Anthropic or OpenAI from the model picker. Isomux gives you a login command for the shared OpenCode profile used by that environment.
- **New offices start with three welcome agents**, one each for Claude, Codex, and OpenCode. The Free Welcome Agent runs on a free OpenCode model and answers immediately without a provider sign-in.

## Multi-agent

### Agent coordination

- **Discovery** via a shared office manifest - every agent can look up who else is in the office (name, room, desk, cwd, model, topic), scoped to the rooms its manager can see.
- **Cross-conversation reads** - each agent has access to the live conversation logs of every other agent. Ask "what does Isomuxer3 think of this?" and it just works.
- **Shared memory** - agents can record durable, attributed facts about people, projects, conventions, and the environment. Those notes outlive any one session and surface automatically in the relevant agents' context as notes, not rules. Memory can be office-wide, per-room, per-agent, or per-person, so something one agent learns can inform the others; humans can curate it by hand as plain text next to each level's prompt. When a level's notes near their size cap, the agent flags it at the start of its next conversation and can help trim them.
- **Agent-to-agent messages** - agents can message other agents directly, choosing between steering and queueing.
- **Scheduled messages** - an agent can schedule a message to another agent, or to itself, for a future time: reminders, wake-ups, follow-up checks. Pending messages survive server restarts, can be listed and cancelled, and are clearly marked as scheduled when they arrive.
- **Mixed queue** - messages from any human (across devices) and any other agent share one queue per receiver. If the receiver is busy, queued messages coalesce into a single follow-up turn. Queued messages survive isomux server shutdowns and restarts.
- **Room-scoped task board** - humans and agents can create, assign, claim, close, or shelve tasks to a backlog. Each task belongs to a room, or to an office-wide global board shared across everyone; you see the tasks in the rooms you can access plus all global tasks. Full interop via UI and HTTP API.
- **Privileged agents**: agent can be granted operator access, allowing them to drive other agents the way you do from the UI, like resuming or starting conversations, jumping the queue, aborting a stuck turn, and managing cron jobs.
- **Reflection**: privileged agents can tweak every office feature, like creating rooms, spawning agents, setting room/agent prompts, etc.

### Prompts, skills, and commands

- **Hierarchical system prompts** - office-wide, per-room, and per-agent prompts compose into one assembled system prompt for every agent, all editable from the UI.
- **Custom instructions per agent**, editable at spawn and later.
- **Agent-collaboration skills**: `/pair-programming`, `/peer-review`, `/soft-handoff`, `/second-opinion`, `/subagent-review`.
- **Other bundled skills**: `/grill-me` (based on the original by Matt Pocock), `/handoff` (continue an unfinished task on a fresh session: the agent writes a short brief of what's left, you approve it, and it restarts clean on just that brief), `/isomux-report-bug`.
- **Inspection commands**: `/isomux-all-hands`, `/isomux-system-prompt`, `/isomux-cronjob-system-prompt`, `/isomux-usage`, `/isomux-storage`.

## Multi-user

- **Multi-user real-time collaboration** - multiple authenticated users can chime in to the same conversation simultaneously.
- **Invite-link access** - the owner mints an invite URL per new user, sends it out-of-band, the invitee clicks and is signed in. No accounts, no passwords. Existing users add their own devices with device links from My devices; if someone is signed out of every device, the owner can mint them a recovery link.
- **Per-member room access** - owners pick which rooms each member sees: on the member's invite (so they land in the right rooms from the first click) or any time from their user settings.
- **Per-user room display** - each user picks which of their accessible rooms actually show in their own view, from the Users page.
- **Live user presence** - other connected people (and your other devices) appear as small floating ghosts in the office, parked next to the agent they're viewing. The name tag above each ghost shows username and device. Click a ghost to open that user's settings.
- **User roster** - owners can see each user's signed-in sessions, with device name and last-active time, from the Users page.
- **Customizable ghosts** - each user picks a color and one of 8 ghost styles from User Settings.

## Multi-device

- **Works on a headless server** - run on a Mac Mini or Linux box, access from your VPN or publicly via Tailscale Funnel / reverse proxy.
- **Open from your phone** - same server URL (VPN or public), touch-optimized UI.
- **Agent list view** as an alternative to the isometric office on small screens.
- **Installable as a PWA** for a native-app feel: on iPhone, use Safari's "Add to Home Screen"; on Android, Chrome prompts you to install on first visit (HTTPS or localhost).
- **Real-time updates** - every connected device (laptop, phone, others) sees the same conversations and the same filesystem in real time via WebSocket; no syncing headaches.

## Cute in a useful way

_The UI makes agent state spatial and glanceable, so you remember who is doing what._

- **Isometric rooms with 8 desks** - see all your agents at a glance.
- **Unique character per agent** - customize color, hat, shirt, hair, accessory, with live preview (or randomize).
- **Animated characters** - sleeping when idle, typing when working, waving when waiting for you.
- Desk monitors **glow based on agent state** (green / purple / red).
- Status light with **escalating hung-agent warnings**: amber at 2 min, red at 5 min.
- **Activity badge** on desk when an agent needs attention.
- **Sound notification** when an agent finishes and the browser tab is unfocused.
- **Kaomoji face in the browser tab** for the agent you have open: `(-_-)zz` idle, `~(o_o)~` working, `(^_^)ﾉ` waiting for you.
- Auto-generated **conversation topic** below nametag.
- **Drag agents between desks or rooms** to rearrange.
- **Skeuomorphic touches**: click the moon through the window to toggle dark mode, click doors to switch rooms, etc.
- **Color themes**: Dark, Light, Nord, Dracula, Solarized Dark/Light.

## Quality-of-life

### Conversation controls

- **Input drafts preserved** when switching between agents and across page reloads.
- **Markdown rendering** for agent output.
- **Collapsible thinking and tool-call cards** with timing for each step (errors are expanded automatically).
- **Structured API-call cards**: when an agent curls the isomux API, the tool-call row says what the call does in plain language, plus its key payload fields.
- **Last user message pinned** at the top of the viewport, so you always see what you asked while the agent is working.
- **Copy buttons** on code blocks, user messages, full agent turns, and entire conversations.
- **Send now** to flush the message queue immediately while the agent is busy, via a button or Ctrl/Cmd+Enter.
- **Ctrl+C to interrupt** - cleanly aborts and lets you resume.
- **Conversation branching** - edit a past message to fork the conversation from that point, preserving the original.
- **Right-click context menu** - resume past sessions, edit agent, kill.
- **File attachments** - agents understand images and PDFs. Upload via button, drag-and-drop, or paste.
- **Image display** - agents can show images inline in the conversation.
- **Voice-to-text** prompting via the browser's `SpeechRecognition` API (HTTPS or localhost). Spoken punctuation is typed as punctuation: say "question mark", "comma", "period", "new line", and so on.
- **Text-to-speech** for agent replies via the browser's `SpeechSynthesis` API.

### Developer tools

- **Embedded terminal** for direct shell access per agent. Copy/paste works with the usual shortcuts: Cmd+C/V on Mac; on Windows and Linux, Ctrl+V pastes and Ctrl+C copies when text is selected (and interrupts, as usual, when nothing is selected). Selecting text also surfaces a "Send to chat" button that drops the selection into the chat input as a code block, ready to discuss with the agent.
- **Built-in file editor**: syntax highlighting, file tabs, resizable alongside the chat. Open files via `/isomux-edit` (agents can offer this too via "[Open in editor]" cards).
- `/isomux-diff` - rich-rendered uncommitted changes. Agents can also choose to emit a diff card on their own.
- **Browser preview cards** - agents can screenshot a web page (their dev server, a dashboard) straight into the chat, so you see UI changes without alt-tabbing to a browser. Needs a Chrome-family browser on the server, which the [VPS install](self-hosted.md#vps-install) sets up for you (runs headless, so no display is needed); everything else works without one.
- `/isomux-usage` - per-agent / per-room / per-cron-job token spend, scoped to the rooms you can access. The same report is available under Office Settings.
- `/isomux-storage` - disk usage by category; owners also see the biggest agents.
- **Plugin system**: add memory, audit, or other turn-aware behavior. Reference [mem0 plugin](https://github.com/nmamano/isomux-mem0) gives agents long-term memory across sessions.

### Navigation and shortcuts

- **Number keys 1–8** jump to agents from office view.
- **Tab / Shift+Tab** cycle between agents in chat view.
- **Escape** returns to office.
- **Built-in slash commands**: `/clear`, `/help`, `/context`, `/resume`, `/model`, `/effort`.
- **Spawn dialog**: pick model, permission mode, thinking effort, and working directory (with recent-CWD suggestions) when creating an agent.
- Start with a blank-canvas agent or choose from 12 templates like Side Project Builder, Money Planner, and Health Navigator.
- **Autocomplete dropdown** with keyboard navigation for slash commands.
- **Skills browser** - the "Sk" button in the input bar opens a list of commands and skills, with the most-used ones first; pick one to insert it into the input.
- **User skills** from `~/.claude/skills/` and project commands.

### Cron jobs

- **Schedule recurring agent runs**: daily at HH:MM, weekly on a weekday, or every N minutes.
- Each run is a **fresh agent session** with the same configurability as a desk agent (model, effort, cwd, permission mode).
- **Browsable run history**: every run is preserved as a transcript.
- **Resume or fork** any past run, turning a daily summary into an interactive follow-up.
- **Manual "Run now"** for any cron job, independent of the schedule.
- **Agent alerts** - a cron job can message an agent that its creator can see. The message is labeled as coming from the scheduled job, not a person or peer agent.
- Per cron job token usage rolled into `/isomux-usage` (for owners).
- OpenCode scheduled runs can read and edit the project and run commands. They cannot ask follow-up questions, hand work to another agent, or use Isomux actions such as messaging agents or posting files.

### Apps

- **Your personal app suite** - apps agents make for you or for other members of the office, available 24/7 from any device that can access the office. Room visibility decides which apps you see: share a room, share the apps.
- **Apps tab**: see all your apps and their screenshot previews in one place.
- **Its own web address** - on an office with its own domain and wildcard DNS, an app can get an address like `myapp.myoffice.com`, so it opens from any device ([setup](self-hosted.md#app-hostnames)). When running locally, each app runs in a port.
- **Behind your sign-in** - only people signed in to your office can open an app's address.
- **Apps can message the agent that built them**, so an app can report an event and have an agent act on it.

### Lifecycle and safety

- **Agents persist across server restarts**; auto-resume last conversation on restart.
- **Per-agent session history** with `/resume` support.
- **Context self-check** - every agent can ask how full its own context window is (an API documented in its system prompt), so instructions like "start wrapping up past 80% of context" have something real to check against. A reading is the latest sample from the backend and may lag the in-flight turn (roughly the last turn boundary); humans get the same view with `/context`, plus a battery-style meter in the conversation header that drains and shifts from dim to orange to red as the window fills. The server also nudges the agent as its window fills - a one-line notice on its next message the first time the conversation passes roughly 50% and then 75% - so wrap-up suggestions fire even when the agent never thinks to check.
- **Plan usage at a glance** - for subscriptions, a ring next to the context meter shows how much of the plan allowance the agent's account has burned. Hovering (or tapping) it lists every limit that can gate the agent, with when each resets and how old the reading is.
- **Searchable conversation history** - agents can search and re-read past conversations (their own or other agents') through an API documented in their system prompt.
- **Kill** removes agent and frees desk.
- **Codex approvals** - when a Codex agent asks to run something its sandbox won't allow, you can approve that one command, or every command starting with a prefix you pick, for the rest of the session.
- **Built-in safety checks (Claude, Codex, and OpenCode agents)** - blocks `rm -rf`, `git reset --hard`, killing processes created by others, reading secret-bearing files like `.env`, and recognized commands that open outbound tunnels. These guards are an honest-agent safety layer, not OS isolation.
- **Managed environment variables** - keep API tokens and other secrets out of prompts: each user can edit variables in User Settings, and Isomux stores them in a private per-user file under `~/.isomux/`. The variables load into agents' environment at session start, with per-user values overriding the office env file. Their values are not embedded in prompts or conversation logs.
- **Personal API tokens** - drive the office from an external tool and drain durable replies from agents while the web UI shows the work and messages live. The raw token is shown once; you can review its approximate last authenticated request and revoke it at any time.
- **Survives a memory spike** - the office biases the out-of-memory kill toward the runaway agent or build, not itself. [One root command](self-hosted.md#running-out-of-memory) adds box-wide protection and keeps SSH reachable. Linux only.
- **Daily local backups:** Isomux keeps seven daily office backups.
- **Disk-usage breakdown and manual pruning** - `/isomux-storage` in any conversation, or `GET /api/storage/usage`, splits the office footprint by conversation transcripts, attachments, codex home, cron history, backups, and update snapshots, with per-agent detail for the owner. Office owners also get a panel under Office Settings to see a breakdown of isomux disk storage and manage it. `POST /api/storage/prune` removes old transcripts, and attachments once no surviving transcript references them: a dry run unless you ask it to apply, never scheduled, and it always spares live sessions, each agent's newest sessions, and any session another was branched from.
- **Update notice** - the office header shows when a new release is out. On a [VPS install](self-hosted.md#vps-install), the owner can apply it from there, and a failed update rolls back on its own. On a source checkout, the notice shows what you're running, the latest release, and how far main is ahead; it stays quiet if you're ahead of main.
