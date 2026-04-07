# Isomux

Friction going from 1 Claude Code to 4+? Isomux is your agent office. *Cute in a useful way.*

Free · open source · no cloud · no account

See [isomux.com](https://isomux.com) for setup instructions and a live demo. Read the [blog post](https://nilmamano.com/blog/isomux) for a deeper dive.

![Isomux office view](site/screenshot.png)

## Feature Highlights

- Manage multiple agents **with your existing Claude subscription** (a visual alternative to tmux)
- Visual office metaphor: see what every agent is doing at a glance
  - **Animated characters**: sleeping when idle, typing when working, waving when waiting for you
  - [**Skeuomorphic touches**](https://x.com/Nil053/status/2039027360117506399): click the moon to toggle dark mode, click doors to switch rooms, etc.
- [**Mobile UI**](https://x.com/Nil053/status/2039996579965542516): continue conversations on your phone with a touch-optimized interface
- Works locally or as a **self-hosted persistent server** (Mac Mini style):
  - Run at home, access **from any device** in your [Tailscale](https://tailscale.com/) network
  - No syncing headaches: same conversations, same filesystem, every device updates **in real time**
- [**Embedded terminal**](https://x.com/Nil053/status/2039504957184090281) per agent
- **Voice-to-text** prompting and **text-to-speech** responses
- [**Pre-tool-call safety hooks**](https://x.com/Nil053/status/2039497314826666469): blocks dangerous commands like `rm -rf`
- [**Custom commands**](https://x.com/Nil053/status/2040018957453918431) in addition to your own, all with autocomplete: e.g. `/isomux-peer-review` to review another agent's work, or `/isomux-all-hands` to see what everyone is up to
- [**Agents can check on each other**](https://x.com/Nil053/status/2039494626265149778): inter-agent discovery via shared manifest
- [**Shared task board**](https://x.com/Nil053/status/2040871759529025617): humans and agents can create, assign, claim, and close tasks — full interop via UI and HTTP API
- **Image/PDF attachments**: agents understand images and PDFs. Agents can show images inline in the conversation
- **Sound notifications**: get pinged when an agent finishes

## Get Started

### 1. Prerequisites

You need [Bun](https://bun.sh/) (v1.2+) and the [Claude Code](https://claude.ai/code) CLI installed and authenticated with a Claude Pro or Max subscription.

```sh
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Launch Claude Code, then type /login to authenticate
claude
```

### 2. Install & Run

```sh
git clone https://github.com/nmamano/isomux.git
cd isomux
bun install
bun run dev
```

### 3. Open

Visit **http://localhost:4000** in your browser. Click an empty desk to spawn your first agent.

For persistent server setup (systemd + Tailscale) and voice input configuration, see [isomux.com](https://isomux.com).

## Full Feature List

### Office View
- **Isometric office with 8 desks** — see all your agents at a glance
- **Name your agents** — each gets a nametag on their desk
- **Unique character per agent** — customize hat, shirt, hair, accessory, or randomize
- **Animated characters** — sleeping when idle, typing when working, waving when waiting for you
- Desk monitors **glow based on agent state** (green / purple / red)
- Status light with **escalating warnings**: amber at 2 min, red at 5 min
- Auto-generated **conversation topic** below nametag
- **Drag agents between desks** to rearrange
- Light / dark theme toggle

### Agent Creation & Editing
- **Click empty desk to spawn** — name, working directory, permission mode, custom instructions
- Working directory input with **recent CWD suggestions**
- **Outfit customization**: color swatches, hat, accessory, randomize with live preview
- **Custom instructions** per agent, editable at spawn and later

### Conversation View
- **Input drafts preserved** when switching between agents
- **Markdown rendering** for agent output
- **Collapsible thinking and tool-call cards** with timing for each step
- **Copy buttons** on code blocks, user messages, full agent turns, and entire conversations
- **Send disabled while agent is busy** — type ahead freely, send when ready
- **File attachments**: agents understand images and PDFs. Upload them via button, drag-and-drop, or paste
- **Image display**: agents can show images inline in the conversation
- **Embedded terminal** for direct shell access per agent
- **Right-click context menu** — resume past sessions, edit agent, kill

### Keyboard Shortcuts
- **Number keys 1–8** jump to agents from office view
- **Tab / Shift+Tab** cycle between agents in chat view
- Escape returns to office
- **Ctrl+C to interrupt** — cleanly aborts and lets you resume

### Slash Commands & Autocomplete
- Built-in commands: /clear, /help, /cost, /context
- User skills from ~/.claude/skills/ and project commands
- **Bundled skills** like /grill-me — available to every agent out of the box
- **Autocomplete dropdown** with keyboard navigation

### Persistence & Lifecycle
- **Agents persist across server restarts**
- **Auto-resume last conversation** on restart
- Agent manifest for **inter-agent discovery**
- **Resume past conversations** from session files
- Kill removes agent and frees desk

### Mobile Support
- **Open from your phone** — same Tailscale URL, touch-optimized UI
- **Instant sync** — laptop and phone see the same state in real time over WebSocket
- **Agent list view** replaces isometric office on small screens
- **Full conversation view** with readable font sizes and two-row header
- **Send & abort buttons** for touch input
- Safe area insets for notch/home bar devices

### Notifications
- **Sound notification** when agent finishes and tab is unfocused
- **Activity badge** on desk when attention needed

### System & Backend
- **Real-time sync via WebSocket** — every connected device stays in lockstep
- **Single Bun process** — no bundler, no database, minimal deps
- Uses **Claude subscription via CLI auth** — no API key needed
- **Built-in safety hooks** — blocks `rm -rf`, `git reset --hard`, and other footguns out of the box
- **Works on a headless server** — run on a Mac Mini or Linux box, access from anywhere via Tailscale
