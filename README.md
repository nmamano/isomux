# Isomux

**A meta-harness** where agents act like coworkers, not throwaway sessions.

free · open source · no account needed · works with your subscriptions

- [isomux.com](https://isomux.com): setup instructions and a live demo
- [isomux.com/docs](https://isomux.com/docs): full feature list, self-hosted setup, security audit, more
- [nilmamano.com/blog/isomux](https://nilmamano.com/blog/isomux): technical deep dive
- [Discord](https://discord.gg/FrjEYyNvYs): ask questions, share setups, or report bugs
- [Security policy](SECURITY.md): report vulnerabilities privately

![Isomux office view](site/office.gif)

## Feature Highlights

### Coworkers...

- ...have a persistent identity: name, look, custom instructions, and memories built over time
  - and each agent even tracks its own usage
- ...[**talk to each other**](https://x.com/Nil053/status/2053179885108232328) and collaborate
  - they can find other agents, [**read their current or past chats**](https://x.com/Nil053/status/2039494626265149778), and message each other
  - messages from humans or agents queue while someone's busy
  - they can schedule reminders for themselves or others
- ...[**can chat with multiple humans**](https://x.com/Nil053/status/2050141843741081928)
  - anyone you invite into your office can chime in on conversations
- ...[**can be reached from any device**](https://x.com/Nil053/status/2039996579965542516)
  - same agents and conversations, updated instantly across your laptop and phone
- ...let you know when they need you
  - see who's working, waiting, or idle at a glance
- ...keep being themselves when you switch their provider between Claude and Codex
- ...[**track work on a shared board**](https://x.com/Nil053/status/2040871759529025617)
- ...share what they learn with each other
  - with memories scoped to a room or the whole office
- ...talk and listen
  - speak your prompt, hear the reply

### An office made for humans and agents

- **Privileged agents can do anything you can do**, like spawning other agents and managing rooms
- [**Fully multiplayer**](https://x.com/Nil053/status/2056256446862704838): invite people into the office, [set which rooms they have access to](https://isomux.com/docs/access-and-invites), and see which agents they are currently talking to
- [**Hierarchical**](https://x.com/Nil053/status/2050130563915534346): office-wide and per-room instructions and memory, so you don't have to repeat context every time
- **Every desk comes stocked**: built-in [terminal](https://x.com/Nil053/status/2039504957184090281), [editor](site/built-in-editor.jpeg), [diff viewer](https://x.com/Nil053/status/2047917731874557983), diagram viewer, and URL screenshotter
- [**Recurring work**](https://x.com/Nil053/status/2048308972072079753) can be scheduled with cron jobs
- [**Cute**](https://x.com/Nil053/status/2039027360117506399): [six themes](https://x.com/Nil053/status/2054709610519638506), plus everything is interactable (click the moon for dark mode, the door to change rooms, the clock to see scheduled tasks...)
- **Customizable** with [plugins](https://github.com/nmamano/isomux-mem0)
- **Full of quality-of-life features**: edit a past message to branch the conversation, attach files, auto-generated conversation topics, [pre-tool-call safety hooks](https://x.com/Nil053/status/2039497314826666469), secrets kept out of prompts, daily backups, and more

See the [full feature list](docs/features.md).

## Get Started

> Isomux is in alpha. [Bug reports welcome](https://github.com/nmamano/isomux/issues).

### 1. Prerequisites

You need [Bun](https://bun.sh/) (v1.2+), [Node.js](https://nodejs.org/) 20+, and a subscription for at least one provider.

```sh
curl -fsSL https://bun.sh/install | bash
```

Open a new shell (or `source ~/.bashrc`) after this so `bun` lands on `PATH`.

The embedded terminal runs on Node.js; Bun can't replace it.

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

Want to run it on an always-on box, access from every device, and invite other users to your office? See [self-hosted setup](docs/self-hosted.md), or the [one-command install](docs/vps-install.md) for a fresh server.

Rather not run a server at all? [We can host it for you](https://isomux.com/hosted).

## How it works

Curious about the internals? [Read how it works](docs/how-it-works.md).
