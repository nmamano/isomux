---
# Editors: one line per feature, what a member can do or gains. Never steps, mechanics or edge cases: they go on the area's docs page, in the agent reference or in the UI (internal-docs/documentation.md, section 4).
description: Every Isomux feature. Isomux runs Claude Code, Codex and OpenCode agents side by side, with agent messaging, a task board, human collaboration and a mobile UI.
navTitle: Full feature list
---

# Full feature list

Isomux is a meta-harness: it sits one level above Claude Code, Codex, and OpenCode and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration features, a mobile UI, and more.

## Multi-provider

- **Choose Claude, Codex, or OpenCode** when spawning an agent, and switch an agent between them whenever you want. The `/resume` list mixes chats from all three engines.
- **Claude Code, Codex and OpenCode ship bundled.** OpenCode offers Free, Pay-as-you-go and Subscription models.
- **New offices start with three welcome agents**, one each for Claude, Codex, and OpenCode. The Free Welcome Agent runs on a free OpenCode model and answers immediately.

## Multi-agent

### Agent coordination

- **Discovery** via a shared office manifest - every agent can look up who else is in the office (name, room, desk, cwd, model, topic), scoped to the rooms its manager can see.
- **Cross-conversation reads** - an agent can read the live conversation of any agent in the rooms its manager can see. Ask "what does Isomuxer3 think of this?"
- **Searchable conversation history** - agents can search and re-read past conversations (their own or other agents') through the office API.
- **Shared memory** - agents can record durable, attributed facts about people, projects, conventions, and the environment. Those notes outlive any one session and surface automatically in the relevant agents' context as notes, not rules. Memory can be office-wide, per-room, per-agent, or per-person, so something one agent learns can inform the others; humans can curate it by hand as plain text next to each level's instructions.
- **Agent-to-agent messages** - agents can message other agents directly, choosing between steering and queueing, and can stop another agent's turn. An agent trusts messages from agents with the same manager, and each message says whether its sender has the same manager.
- **Scheduled messages** - an agent can schedule a message to another agent, or to itself, for a future time: reminders, wake-ups, follow-up checks. Pending messages survive server restarts, can be listed and cancelled, and are clearly marked as scheduled when they arrive.
- **Mixed queue** - messages from any human (across devices) and any other agent share one queue per receiver. Queued messages survive isomux server shutdowns and restarts.
- **Room-scoped task board** - humans and agents can create, assign, claim, close, or shelve tasks to a backlog. Each task belongs to a room, or to an office-wide global board shared across everyone; you see the tasks in the rooms you can access plus all global tasks. Full interop via UI and HTTP API. Task details show who changed each field and its old and new values.
- **GitHub issues on the board** - an office owner links a GitHub repo to a room. Open issues with the chosen labels become tasks in that room, and closing or reopening an issue on GitHub updates its task. Agents read the issue text as outside data.
- **Privileged agents** run the office for you: they spawn and drive other agents, create and manage rooms, set office, room and agent instructions, manage schedules, post in members chat, and add and change integrations without reading their values. They cannot invite people or create sign-in links.

### Prompts, skills, and commands

- **Hierarchical system prompts** - office-wide, per-room, and per-agent instructions compose into one assembled system prompt for every agent, all editable from the UI.
- **Custom instructions per agent**, editable at spawn and later.
- **Agent-collaboration skills**: `/pair-programming`, `/peer-review`, `/soft-handoff`, `/second-opinion`, `/subagent-review`.
- **Other bundled skills**: `/grill-me` (based on the original by Matt Pocock), `/loose-ends` (recap what is in flight and what needs you, without ending the session), `/wrap-session` (check for loose ends and close a session cleanly), `/figure-it-out`, `/isomux-report-bug`.
- **Inspection commands**: `/isomux-all-hands`, `/isomux-system-prompt`, `/isomux-cronjob-system-prompt`, `/isomux-usage`, `/isomux-storage`.

## Multiple members

- **Real-time collaboration** - multiple authenticated members can chime in to the same conversation simultaneously.
- **Sign-in links** - an owner creates a member and sends them a one-use sign-in link. No passwords. Members add their own devices from Settings → You → Sign-in links.
- **Per-member room access** - owners pick which rooms each member sees: when they create the member (so they land in the right rooms from the first click) or any time from `Settings` → `Members`.
- **Per-member room display** - each member picks which of their accessible rooms actually show in their own view.
- **Live member presence** - other members and your other devices show as ghosts next to the agent they are viewing, and walk through the door when they change rooms. Click a ghost to open that member's settings.
- **Members chat** - a humans-only, office-wide chat in the lobby.
- **The receptionist** - an always-available agent in the office lobby for general Isomux questions, on a free OpenCode model. The receptionist helps new members settle into the office.
- **Agent managers** - an office owner can give an agent another manager in its settings.
- **Member roster** - office owners can see each member's signed-in sessions, with device name and last-active time, from the Members page.
- **Customizable ghosts** - each member picks a color and one of 8 ghost styles from `Settings` → `You` → `Profile`.

## Multi-device

- **Works on a headless server** - run it on an always-on Linux box or cloud server, and reach it over Tailscale or your own domain.
- **Open from your phone** - same server URL (VPN or public), touch-optimized UI.
- **Install as app** - put the office on a phone or computer, no app store.
- **Real-time updates** - every connected device (laptop, phone, others) sees the same conversations and the same filesystem in real time via WebSocket; no syncing headaches.

## Cute in a useful way

_The UI makes agent state spatial and glanceable, so you remember who is doing what._

- **Lobby** - a room every member can open; members with no other room land there.
- **Isometric rooms with 8 desks** - see all your agents at a glance.
- **Back room** - turn it on in a room's settings, and a basement behind a trap door holds up to 100 more agents. The front keeps the agents people talk to.
- **Room working directory** - set one in a room's settings, and new agents in the room start there.
- **Unique character per agent** - customize color, hat, shirt, hair, accessory, with live preview (or randomize).
- **Animated characters** - sleeping when idle, typing when working, waving when waiting for you.
- Desk monitors **glow based on agent state** (green / purple / red).
- Status light with **escalating hung-agent warnings**: amber at 2 min, red at 5 min.
- **Unread badge** on desk when an agent answers your message.
- **Sound notification** when an agent answers your message and the browser tab is unfocused.
- **Kaomoji face in the browser tab** for the agent you have open: `(-_-)zz` idle, `~(o_o)~` working, `(^_^)ﾉ` waiting for you.
- Auto-generated **conversation topic** below nametag.
- **Drag agents between desks or rooms** to rearrange, or onto the trap door to move them to the back room.
- **A pet in every room** - a cat by default; click it to pick a cat, dog, rabbit or tortoise and a coat for it. The choice is stored with the room, so everyone sees the same animal.
- **Room look** - customize each room in its settings (double-click its tab).
- **Skeuomorphic touches**: click the moon through the window to toggle dark mode, click doors to switch rooms, etc.
- **Color themes**: Dark, Light, Nord, Dracula, Solarized Dark/Light.

## Conversation

- **Input drafts preserved** when switching between agents and across page reloads.
- **Markdown rendering** for agent output.
- **Collapsible thinking and tool-call cards** with timing for each step (errors are expanded automatically).
- **Structured API-call cards**: when an agent curls the isomux API, the tool-call row says what the call does in plain language, plus its key payload fields.
- **Last user message pinned** at the top of the viewport, so you always see what you asked while the agent is working.
- **Copy buttons** on code blocks, user messages, full agent turns, and entire conversations.
- **Conversation lifecycle controls** - end the current conversation from its header, then resume it from the empty state or session picker.
- **Send now** to flush the message queue immediately while the agent is busy, via a button or Ctrl/Cmd+Enter.
- **Ctrl+C to interrupt** - cleanly aborts and lets you resume.
- **Conversation branching** - edit a past message to fork the conversation from that point, preserving the original.
- **Right-click context menu** - resume past sessions, edit agent, kill.
- **File attachments** - agents understand images and PDFs. Upload via button, drag-and-drop, or paste.
- **Media display** - agents can show images, video and audio inline in the conversation.
- **Office language** - each person picks a language, like Spanish or Chinese, under Settings → You → Language and the whole office reads in it.
- **Voice-to-text** prompting via the browser's `SpeechRecognition` API (HTTPS or localhost), or via OpenAI. Saying "submit" sends the message, "period" adds a '.', "question mark" adds a '?', and so on. This works across languages.
- **Text-to-speech** for agent replies via the browser's `SpeechSynthesis` API, or via OpenAI voices.
- **Voice settings** in Integrations > Voice: each member picks the browser or OpenAI for the mic and for read aloud. OpenAI gives better accuracy and voices, and a mic in Firefox.
- **Context check** - agents and humans (`/context`) can see how full a context window is, and a battery meter in the header drains as it fills.
- **Automatic handoff** - when an agent's context gets full, it writes a brief and continues in a fresh session. On by default; turn it off in the Edit agent menu.
- **Plan usage at a glance** - for subscriptions, a ring next to the context meter shows how much of the plan allowance the agent's account has burned. Hovering (or tapping) it lists every limit that can gate the agent, with when each resets and how old the reading is.
- **Resume after a usage limit** - a Claude or Codex agent that a usage limit stops continues by itself after the limit resets.

### Navigation and shortcuts

- **Number keys 1–8** jump to agents from office view.
- **Tab / Shift+Tab** cycle between agents in chat view.
- **Escape** closes the page on top and returns to what was under it.
- **b** goes between a room's front and its back room.
- **t**, **a**, **i** and **s** open Tasks, Apps, Integrations and Settings when no text field has focus. Press t, a or i again to close the page.
- **Built-in slash commands**: `/clear`, `/handoff` (continue on a fresh session), `/help`, `/context`, `/resume`, `/model`, `/effort`, `/plan`, `/reload-plugins`. Claude agents also run Claude Code's `/code-review` (or `/review`) and `/simplify`.
- **Spawn dialog**: pick model, permission mode, thinking effort, and working directory (with recent-CWD suggestions) when creating an agent.
- Start with a blank-canvas agent or choose from 13 templates like Side Project Builder, Money Planner, and Health Navigator, in your language.
- **Autocomplete dropdown** with keyboard navigation for slash commands.
- **Skills browser** - the "Sk" button in the input bar opens a list of commands and skills, with the most-used ones first; pick one to insert it into the input.
- **User skills** from `~/.claude/skills/` and project commands.
- **Skills page** - shared skills appear once in All agents; engine tabs show the differences. The read-only Commands tab lists office commands and their aliases with the same descriptions as /help. Open a preview or the full SKILL.md, edit or delete user and project skills, or create new ones for all agents.

## Developer tools

- **Embedded terminal** for direct shell access per agent. Copy/paste works with the usual shortcuts. Selecting text also surfaces a "Send to chat" button that drops the selection into the chat input as a code block, ready to discuss with the agent. Agents can read the output of the terminals in their rooms.
- **Built-in file editor**: syntax highlighting, file tabs, resizable alongside the chat. Open files via `/isomux-edit` (agents can offer this too via "[Open in editor]" cards, or open the file for you). Selecting text surfaces a "Cite" button that drops the selection into the chat input with its file path and lines.
- `/isomux-diff` - rich-rendered uncommitted changes. Agents can also choose to emit a diff card on their own.
- **Browser preview cards** - agents can screenshot a web page (their dev server, a dashboard) straight into the chat, so you see UI changes without alt-tabbing to a browser.
- **Agents use your browser** - they open pages, click, and fill forms in a Chrome tab you share with them. See [Browser use](browser-use.md).
- `/isomux-usage` - token spend per agent and per room, for the rooms you can see. Owners also see each schedule. Also in Settings → Housekeeping → Usage.
- `/isomux-storage` - disk usage by category; owners also see the biggest agents.

## Automations

- **Schedule recurring agent runs**: daily at HH:MM, weekly on a weekday, or every N minutes. A schedule can also run on demand only, from "Run now" or a webhook.
- Each run is a **fresh agent session** with the same configurability as a desk agent (model, effort, cwd, permission mode).
- **Browsable run history**: every run is preserved as a transcript.
- **Resume or fork** any past run, turning a daily summary into an interactive follow-up.
- **Manual "Run now"** for any schedule, independent of its timing.
- **Agents can make schedules** too, in Bypass mode (Never ask for Codex).
- **Webhooks** - an outside service such as GitHub can message an agent or start a schedule run through a signed webhook. Rules choose the events and the payload fields that reach the target. GitHub must reach the office from the internet.
- **Agent alerts** - a schedule can message an agent that its creator can see. The message is labeled as coming from the scheduled job, not a person or peer agent.
- OpenCode scheduled runs can read and edit the project and run commands. They cannot ask follow-up questions, hand work to another agent, or use Isomux actions such as messaging agents or posting files.

## Apps

- **Your personal app suite** - apps agents make for you or for other members of the office, available 24/7 from any device that can access the office. Room visibility decides which apps you see: share a room, share the apps.
- **Apps tab**: see all your apps and their links in one place.
- **Its own web address** - on an office with its own domain and wildcard DNS, an app can get a short address like `myoffice.com/myapp`, so it opens from any device ([setup](hosting-reference.md#app-hostnames)). When running locally, each app runs in a port.
- **Behind your sign-in** - only people signed in to your office can open an app's address.
- **Chat beside an app** - Chat with the agent who created the app from a widget in the app itself.
- **Install as app** - put an app on a phone's Home Screen or a computer's app list, as its own app with its own name.
- **Apps can do what the agent that built them can**, so an app can report an event or hand out work to other agents.
- **Deleting an app keeps its data** on the office's disk. Nothing is erased automatically.

## Inbox

- **Inbox**: a single place for everything the agents need from you. Agents can make _Asks_ or send you _Pages_. Asks are questions that can wait, and you answer them when you have time, or file one as a task for later. Pages are urgent: they reach you through the notifications you set up and repeat until someone acks them.

## Pager

- **Agents and apps page you** when a person must act: a blocked process, a failure they cannot fix, a decision only you can make.
- **Pages reach your Discord**, with an @mention so your phone rings. An open page repeats until someone acks or resolves it.
- **Device notifications**: pages and agents' answers to your messages can also show as notifications on your phone or browser.

## Safety

- **Built-in safety checks (Claude, Codex, and OpenCode agents)** - blocks `rm -rf`, `git reset --hard`, recognized process-kill commands, reading secret-bearing files like `.env`, reading another process's environment, and recognized commands that open outbound tunnels. These guards are an honest-agent safety layer, not OS isolation.
- **Secret leak prevention** - Isomux masks recognized secret patterns before they reach the logs or the chat.
- **Managed environment variables** - keep API tokens and other secrets out of prompts: set office-wide and personal variables on the Integrations page. Personal values override office-wide values. Values are not embedded in prompts or conversation logs.
- **Secrets** - save a credential with the hosts that may receive it. Agents get a stand-in, not the value. An agent that reads the office's files on purpose can still find the value. Show reveals a value to its own member, and an office value to an owner.
- **Integrations page** - everything your agents can use. The MCP tab also lists the claude.ai connectors of your Claude sign-in. Owners manage every member's items there. Test one to see whether it works and which account the service sees. A note on a variable, secret or MCP server tells your agents how to use it.
- **Remote MCP servers** - register a remote MCP server once, for the office or for your own agents, and Claude, Codex and OpenCode agents all get it. For a server that needs a sign-in (OAuth), you sign in once in the browser and Isomux keeps the access current.
- **Codex approvals** - when a Codex agent asks to run something its sandbox won't allow, you can approve that one command, or every command starting with a prefix you pick, for the rest of the session.
- **Personal API tokens** - drive the office from an external tool and receive the token’s sends and replies through the office WebSocket.
- **Reach your office over MCP** - add the office to Claude, Claude Code or Codex as an MCP server with a personal API token, and ask your agents from there. Claude on the web needs an office with a public address. [Setup](developer-api.md#reach-your-office-over-mcp).

## Running the office

- **Agents persist across server restarts**; auto-resume last conversation on restart.
- **Per-agent session history** with `/resume` support.
- **Kill** removes agent and frees desk.
- **Office address** - self-hosted owners can set the public URL and external access in Settings → Office → Access. Hosted offices show the Isomux-managed address read-only.
- **Survives a memory spike** - the office biases the out-of-memory kill toward the runaway agent or build, not itself. [One root command](hosting-reference.md#running-out-of-memory) adds box-wide protection and keeps SSH reachable. Linux only.
- **Office audit log:** Filter logs by actor, target, operation, or time. The log keeps task history and snapshots of memory and instructions. Owners can restore deleted tasks from their audit rows.
- **Terminal recording:** With **Record terminals** on in Settings → Housekeeping → Audit log, owners can replay each terminal session from its audit row: what the terminal showed and who typed when. Keystrokes are never saved. Off by default, and a recorded terminal tells everyone who opens it.
- **Local backups:** Isomux keeps seven daily office backups by default. Owners set how often, how many and the folder in Settings → Housekeeping → Storage.
- **Disk-usage breakdown and manual pruning** - `/isomux-storage` in any conversation splits the office footprint by category, with per-agent detail for the owner. Office owners also get Settings → Housekeeping → Storage to compress old transcripts without losing anything and to prune old data. [Data retention and deletion](data-retention.md) says what each delete keeps.
- **Update notice** - the header shows when a new release is out. On installer-managed hosts and AWS containers, the owner applies it from there.
