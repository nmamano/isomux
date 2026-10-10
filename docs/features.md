---
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
- **Shared memory** - agents can record durable, attributed facts about people, projects, conventions, and the environment. Those notes outlive any one session and surface automatically in the relevant agents' context as notes, not rules. Memory can be office-wide, per-room, per-agent, or per-person, so something one agent learns can inform the others; humans can curate it by hand as plain text next to each level's prompt. When a level's notes near their size cap, the agent flags it at the start of its next conversation and can help trim them.
- **Agent-to-agent messages** - agents can message other agents directly, choosing between steering and queueing, and can stop another agent's turn.
- **Scheduled messages** - an agent can schedule a message to another agent, or to itself, for a future time: reminders, wake-ups, follow-up checks. Pending messages survive server restarts, can be listed and cancelled, and are clearly marked as scheduled when they arrive.
- **Mixed queue** - messages from any human (across devices) and any other agent share one queue per receiver. If the receiver is busy, queued messages coalesce into a single follow-up turn. Queued messages survive isomux server shutdowns and restarts.
- **Room-scoped task board** - humans and agents can create, assign, claim, close, or shelve tasks to a backlog. Each task belongs to a room, or to an office-wide global board shared across everyone; you see the tasks in the rooms you can access plus all global tasks. Full interop via UI and HTTP API.
- **Privileged agents** run the office for you: they spawn and drive other agents, create and manage rooms, set room and agent prompts, and manage their own schedules. Office settings, invites and sign-in links stay with owners.

### Prompts, skills, and commands

- **Hierarchical system prompts** - office-wide, per-room, and per-agent prompts compose into one assembled system prompt for every agent, all editable from the UI. The Spawn and Edit agent menus keep instructions and memory together; Show full system prompt previews unsaved settings without saving them.
- **Custom instructions per agent**, editable at spawn and later.
- **Agent-collaboration skills**: `/pair-programming`, `/peer-review`, `/soft-handoff`, `/second-opinion`, `/subagent-review`.
- **Other bundled skills**: `/grill-me` (based on the original by Matt Pocock), `/handoff` (continue an unfinished task on a fresh session: the agent writes a short brief of what's left, you approve it, and it restarts clean on just that brief), `/wrap-session` (check for loose ends and close a session cleanly), `/figure-it-out`, `/isomux-report-bug`.
- **Inspection commands**: `/isomux-all-hands`, `/isomux-system-prompt`, `/isomux-cronjob-system-prompt`, `/isomux-usage`, `/isomux-storage`.

A privileged agent can edit its manager's special instructions. If the manager is an office owner, the agent can edit any member's special instructions. Concurrent edits are checked; a settings save conflict keeps the draft and shows the current text.

## Multiple members

- **Real-time collaboration** - multiple authenticated members can chime in to the same conversation simultaneously.
- **Sign-in links** - an owner creates a member and sends them a one-use sign-in link. No passwords. Members add their own devices from Settings → You → Sign-in links.
- **Per-member room access** - owners pick which rooms each member sees: when they create the member (so they land in the right rooms from the first click) or any time from `Settings` → `Members`.
- **Per-member room display** - each member picks which of their accessible rooms actually show in their own view.
- **Live member presence** - other members and your other devices show as ghosts next to the agent they are viewing, and walk through the door when they change rooms. Click a ghost to open that member's settings.
- **Members chat** - a humans-only, office-wide chat in the lobby.
- **The receptionist** - an always-available agent in the office lobby for general Isomux questions, on a free OpenCode model. The receptionist helps new members settle into the office. The first owner manages it; it is an ordinary agent with that owner's access.
- **Member roster** - office owners can see each member's signed-in sessions, with device name and last-active time, from the Members page.
- **Customizable ghosts** - each member picks a color and one of 8 ghost styles from `Settings` → `You` → `Profile`.

## Multi-device

- **Works on a headless server** - run it on an always-on Linux box or cloud server, and reach it over Tailscale or your own domain.
- **Open from your phone** - same server URL (VPN or public), touch-optimized UI.
- **Installable as a PWA** for a native-app feel: on iPhone, use Safari's "Add to Home Screen"; on Android, Chrome prompts you to install on first visit (HTTPS or localhost).
- **Real-time updates** - every connected device (laptop, phone, others) sees the same conversations and the same filesystem in real time via WebSocket; no syncing headaches.

## Cute in a useful way

_The UI makes agent state spatial and glanceable, so you remember who is doing what._

- **Lobby** - a room every member can open; members with no other room land there.
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
- **A pet in every room** - a cat by default; click it to pick a cat, dog, rabbit or tortoise and a coat for it. The choice is stored with the room, so everyone sees the same animal.
- **Room look** - pick Office or Hospital, then the walls, curtains, plants, wall art and more.
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
- **Image display** - agents can show images inline in the conversation.
- **Voice-to-text** prompting via the browser's `SpeechRecognition` API (HTTPS or localhost). Saying "submit" sends the message, "period" adds a '.', "question mark" adds a '?', and so on. This works across languages.
- **Text-to-speech** for agent replies via the browser's `SpeechSynthesis` API.
- **Context check** - agents and humans (`/context`) can see how full a context window is, and a battery meter in the header drains as it fills. Isomux nudges the agent at about 50% and 75%.
- **Plan usage at a glance** - for subscriptions, a ring next to the context meter shows how much of the plan allowance the agent's account has burned. Hovering (or tapping) it lists every limit that can gate the agent, with when each resets and how old the reading is.

### Navigation and shortcuts

- **Number keys 1–8** jump to agents from office view.
- **Tab / Shift+Tab** cycle between agents in chat view.
- **Escape** returns to office.
- **Built-in slash commands**: `/clear`, `/help`, `/context`, `/resume`, `/model`, `/effort`.
- **Spawn dialog**: pick model, permission mode, thinking effort, and working directory (with recent-CWD suggestions) when creating an agent.
- Start with a blank-canvas agent or choose from 13 templates like Side Project Builder, Money Planner, and Health Navigator, in your language.
- **Autocomplete dropdown** with keyboard navigation for slash commands.
- **Skills browser** - the "Sk" button in the input bar opens a list of commands and skills, with the most-used ones first; pick one to insert it into the input.
- **User skills** from `~/.claude/skills/` and project commands.
- **Skills page** - shared skills appear once in All agents; engine tabs show the differences. The read-only Commands tab lists office commands and their aliases with the same descriptions as /help. Open a preview or the full SKILL.md, edit user and project skills, or create new ones for all agents. Saves require valid YAML front matter with a name and description. Broken files stay listed for repair; legacy command files keep their existing format. Delete user or project skills after confirmation: the whole skill folder is removed. Legacy commands delete one file. Linked targets remain.

## Developer tools

- **Embedded terminal** for direct shell access per agent. Copy/paste works with the usual shortcuts: Cmd+C/V on Mac; on Windows and Linux, Ctrl+V pastes and Ctrl+C copies when text is selected (and interrupts, as usual, when nothing is selected). Selecting text also surfaces a "Send to chat" button that drops the selection into the chat input as a code block, ready to discuss with the agent.
- **Built-in file editor**: syntax highlighting, file tabs, resizable alongside the chat. Open files via `/isomux-edit` (agents can offer this too via "[Open in editor]" cards). Selecting text surfaces a "Cite" button that drops the selection into the chat input with its file path and lines.
- `/isomux-diff` - rich-rendered uncommitted changes. Agents can also choose to emit a diff card on their own.
- **Browser preview cards** - agents can screenshot a web page (their dev server, a dashboard) straight into the chat, so you see UI changes without alt-tabbing to a browser. Needs a Chrome-family browser on the server, which the [VPS install](hosting-vps.md) sets up for you (runs headless, so no display is needed); everything else works without one.
- **Agents use your browser** - they open pages, click, and fill forms in a Chrome tab you share with them. See [Desktop Chrome extension](#desktop-chrome-extension).
- `/isomux-usage` - token spend per agent and per room, for the rooms you can see. Owners also see each schedule. Also in Settings → Office → Usage.
- `/isomux-storage` - disk usage by category; owners also see the biggest agents.

### Desktop Chrome extension

In **Settings → You → Browser Use**, download the extension ZIP and extract it. In desktop Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted folder. Pin **Isomux Browser** to the toolbar.

Create a pairing code in Settings → You → Browser Use. Open the extension and enter the office HTTPS address and code. Codes expire after five minutes. Each member pairs their own browsers: one code per computer, and every paired browser stays paired. Name each browser when you create its code; Settings → You → Browser Use lists them, and Unpair removes one. Agents use their manager's browsers. Another chat speaker does not change the browser owner.

Chrome warns **Read your browsing history**. The extension uses this permission to bind site-opened popups to the agent's tab. It does not collect browsing history. Chrome also shows its own debugger warning during control.

Open an HTTP(S) tab, choose **All** (the default) or an agent in the extension popup, and turn on **Agent control**. The agent can read the page immediately and navigate that same tab. An individual agent can have one exclusive offered tab across all paired browsers. Any number of tabs can be offered to All eligible agents managed by the paired member. An individual offer takes precedence; with several All tabs, agents use `tabs` and an explicit `target` to choose. Actions on each grant run one at a time, including timeout recovery. Before offering it, choose when control expires: **Never** (the default), **15 minutes**, **1 hour** or **4 hours**. Timed control starts when the offer succeeds; the popup shows its local expiry time. Agent actions do not extend the deadline. Turn control off before changing its expiry or assigning the tab to another agent.

Agents can attach one office-server file to an exact file input with the browser `upload` action. The file must be a regular file up to 4 MiB; sensitive files are refused. The office sends the bytes to Chrome, so the path refers to the server, not the desktop. Upload replaces the input’s selection. Sites may upload as soon as a file is selected; the action does not press Submit or Publish.

The **ON** badge marks offered tabs and their site-opened popups. Other tabs have no badge. The popup separates the Office connection from Agent control and names All or the assigned agent. Stopping control leaves pages open. The popup can also disconnect or unpair. Disconnect stays off until Reconnect. To revoke a browser that is offline, unpair it in Settings → You → Browser Use. If an unpair acknowledgement is lost, the popup reports an unknown result; check Settings → You → Browser Use. Pairing a Chrome again adds a new browser; unpair its old, offline entry in Settings → You → Browser Use.

Chrome mode uses the desktop viewport. Desktop `localhost` refers to the member's computer; preview cards still run on the server. A lost connection releases tab offers. Offer the tab again after reconnecting or reloading the extension. Chrome mode never creates a replacement tab or repeats a command. Check the page before repeating an action with an unknown outcome. An action timeout keeps control ON. If Chrome is still completing a command, the agent must wait for it to settle before another action can run.

Office installs and updates build the ZIP automatically. To update an unpacked extension, download the new ZIP, extract it over its existing folder, and select **Reload** in `chrome://extensions`. Keep that folder in place. The server refuses an extension with an older protocol, so update the server and the extension together. Reloading releases offers, so offer tabs again. Saved pairing remains, but a terminal version refusal can require pairing again. No Web Store installation is available.

## Automations

- **Schedule recurring agent runs**: daily at HH:MM, weekly on a weekday, or every N minutes. A schedule can also run on demand only, from "Run now" or a webhook.
- Each run is a **fresh agent session** with the same configurability as a desk agent (model, effort, cwd, permission mode).
- **Browsable run history**: every run is preserved as a transcript.
- **Resume or fork** any past run, turning a daily summary into an interactive follow-up.
- **Manual "Run now"** for any schedule, independent of its timing.
- **Webhooks** - an outside service such as GitHub can message an agent or start a schedule run through a signed webhook. Rules choose the events and the payload fields that reach the target. The Webhooks tab of the Automations page shows the GitHub settings, the delivery log and a rule test. GitHub must reach the office from the internet.
- **Agent alerts** - a schedule can message an agent that its creator can see. The message is labeled as coming from the scheduled job, not a person or peer agent.
- OpenCode scheduled runs can read and edit the project and run commands. They cannot ask follow-up questions, hand work to another agent, or use Isomux actions such as messaging agents or posting files.

## Apps

- **Your personal app suite** - apps agents make for you or for other members of the office, available 24/7 from any device that can access the office. Room visibility decides which apps you see: share a room, share the apps.
- **Apps tab**: see all your apps and their links in one place.
- **Its own web address** - on an office with its own domain and wildcard DNS, an app can get a short address like `myoffice.com/myapp` that redirects to `myapp.myoffice.com`, so it opens from any device ([setup](hosting-reference.md#app-hostnames)). When running locally, each app runs in a port.
- **Behind your sign-in** - only people signed in to your office can open an app's address.
- **Apps can message the agent that built them**, so an app can report an event and have an agent act on it.
- **Deleting an app keeps its data** - the data directory moves to `.retired` next to the other apps' data, on the office's disk. Nothing is erased automatically.

## Pager

- **Agents and apps page you** when a person must act: a blocked process, a failure they cannot fix, a decision only you can make.
- **Pages reach your Discord**, with an @mention so your phone rings. An open page repeats until someone acks or resolves it.
- **Pager view**: every page you can see, open pages first, with ack and resolve. A badge on the Pager button counts your open pages.

## Safety

- **Built-in safety checks (Claude, Codex, and OpenCode agents)** - blocks `rm -rf`, `git reset --hard`, recognized process-kill commands, reading secret-bearing files like `.env`, and recognized commands that open outbound tunnels. These guards are an honest-agent safety layer, not OS isolation.
- **Secret leak prevention** - Isomux masks recognized secret patterns before they reach the logs or the chat.
- **Managed environment variables** - keep API tokens and other secrets out of prompts: edit office-wide variables in Settings → Office → Office-wide connections and personal ones in Settings → You → Individual connections, and Isomux stores them in private files under `~/.isomux/`. Personal values override office-wide values. Other per-user variables work the same way, for example, each member can set `GH_TOKEN` so their agents use their own GitHub credentials. Values are not embedded in prompts or conversation logs.
- **Codex approvals** - when a Codex agent asks to run something its sandbox won't allow, you can approve that one command, or every command starting with a prefix you pick, for the rest of the session.
- **Personal API tokens** - drive the office from an external tool and receive the token’s sends and replies through the office WebSocket.

## Running the office

- **Agents persist across server restarts**; auto-resume last conversation on restart.
- **Per-agent session history** with `/resume` support.
- **Kill** removes agent and frees desk.
- **Office address** - self-hosted owners can set the public URL and external access in Settings → Office → Access. Hosted offices show the Isomux-managed address read-only.
- **Survives a memory spike** - the office biases the out-of-memory kill toward the runaway agent or build, not itself. [One root command](hosting-reference.md#running-out-of-memory) adds box-wide protection and keeps SSH reachable. Linux only.
- **Daily local backups:** Isomux keeps seven daily office backups.
- **Disk-usage breakdown and manual pruning** - `/isomux-storage` in any conversation, or `GET /api/storage/usage`, splits the office footprint by conversation transcripts, attachments, codex home, cron history, backups, and update snapshots, with per-agent detail for the owner. Office owners also get Settings → Office → Storage to see a breakdown of isomux disk storage and manage it. `POST /api/storage/prune` removes old transcripts, and attachments once no surviving transcript references them: a dry run unless you ask it to apply, never scheduled, and it always spares live sessions, each agent's newest sessions, and any session another was branched from.
- **Update notice** - the header shows when a new release is out. On installer-managed hosts and AWS containers the owner applies it from there, and a failed direct-host update rolls back. On Render and Kubernetes the owner deploys the new image. A source checkout shows how far main is ahead.
