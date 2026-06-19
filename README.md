# Isomux

**A meta-harness** for multi-device, multi-user, multi-agent collaboration in a cute office.

free · open source · no account needed

- [isomux.com](https://isomux.com): setup instructions and a live demo
- [isomux.com/docs](https://isomux.com/docs): full feature list, self-hosted setup, security audit, more
- [nilmamano.com/blog/isomux](https://nilmamano.com/blog/isomux): technical deep dive
- [Discord](https://discord.gg/FrjEYyNvYs): ask questions, share setups, or report bugs

![Isomux office view](site/office.gif)

## Feature Highlights

### Multi-provider

- Mix Claude and Codex agents in the same office
- **Works with your subscriptions**: if `claude` or `codex` works in your terminal, isomux works in your browser

### Multi-agent

- Agents [**check on each other**](https://x.com/Nil053/status/2039494626265149778) and [**message each other**](https://x.com/Nil053/status/2053179885108232328): all messages (human and agent) get queued while agents are busy
- [**Shared task board**](https://x.com/Nil053/status/2040871759529025617): humans and agents can create, assign, claim, and close tasks
- [**Hierarchical system prompts**](https://x.com/Nil053/status/2050130563915534346): office-wide, per-room, and per-agent prompts
- [**Custom commands**](https://x.com/Nil053/status/2057153876332331507) in addition to your own: `/pair-programming`, `/peer-review`, etc.

### Multi-user

- [**Collaborate in agent conversations**](https://x.com/Nil053/status/2050141843741081928): anyone you've invited to your office can chime in
- [**Live user presence**](https://x.com/Nil053/status/2056256446862704838): other users (and your other devices) appear as small ghosts next to the agent they're talking to
- [**Invite-link access**](https://isomux.com/docs/access-and-invites): owner mints a URL per device, sends it out-of-band, the invitee clicks and is signed in. No accounts, no passwords

### Multi-device

- Run on `localhost:4000` for local use, or as a **self-hosted persistent server** reachable **from any device** (see [how](https://isomux.com/docs/self-hosted))
- [**Mobile UI**](https://x.com/Nil053/status/2039996579965542516): continue on your phone with a touch-optimized UI
- **Real-time updates**: same conversations, same filesystem, no syncing headaches between devices

### Cute in a useful way

- Visual office: see what every agent is doing at a glance
- **Animated characters**: sleeping when idle, typing when working, waving when waiting for you
- [**Skeuomorphic touches**](https://x.com/Nil053/status/2039027360117506399): click the moon to toggle dark mode, click doors to switch rooms, etc.
- [**6 color themes**](https://x.com/Nil053/status/2054709610519638506)
- **Auto-generated topic** below each nametag, so you remember what each agent is working on

### QoL

- Built-in [**terminal**](https://x.com/Nil053/status/2039504957184090281), [**editor**](site/built-in-editor.jpeg), and [**diff tool**](https://x.com/Nil053/status/2047917731874557983)
- **Voice-to-text** prompting and **text-to-speech** responses
- [**Cron jobs**](https://x.com/Nil053/status/2048308972072079753): schedule recurring agent runs; each run is a fresh chat (that can be resumed)
- **Image/PDF attachments**: agents understand images and PDFs and can show images inline
- **Conversation branching**: edit any past message to fork the conversation
- **Notifications**: get pinged (and waved at) when an agent finishes
- [**Pre-tool-call safety hooks**](https://x.com/Nil053/status/2039497314826666469)
- **Plugin system**: add memory, audit, or other turn-aware behavior. Reference [mem0 plugin](https://github.com/nmamano/isomux-mem0) gives agents long-term memory across sessions.

See the [full feature list](docs/features.md).

## Get Started

> Isomux is in alpha. [Bug reports welcome](https://github.com/nmamano/isomux/issues).

### 1. Prerequisites

You need [Bun](https://bun.sh/) (v1.2+) and a subscription for at least one provider.

```sh
curl -fsSL https://bun.sh/install | bash
```

Open a new shell (or `source ~/.bashrc`) after this so `bun` lands on `PATH`.

### 2. Install & Run

```sh
git clone https://github.com/nmamano/isomux.git
cd isomux
bun install
bun run dev
```

### 3. Open

Visit **http://localhost:4000** in your browser.

- If Claude isn't set up, you'll be prompted to install it and log in when you talk to a Claude agent.
- Codex is bundled with isomux. You'll be prompted to log in when you talk to a Codex agent.

Want to run it on an always-on box, access from every device, and invite other users to your office? See [self-hosted setup](docs/self-hosted.md).

## How it works

Curious about the internals? [Read how it works](docs/how-it-works.md).
