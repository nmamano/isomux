# How it works

Isomux runs as a **single Bun process** that manages persistent agent sessions — one per desk — across two backends:

- **Claude agents** speak directly to the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), running in-process.
- **Codex agents** talk to a long-lived [Codex](https://github.com/openai/codex) app-server subprocess over stdio.

Either way, sessions are persistent — no per-turn process juggling.

A **WebSocket layer** keeps every connected device — and every connected user — in sync in real time. Open the same URL on your laptop, phone, and a friend's browser: all three see the same office, same conversations, same messages as they land.

**Agent sessions persist** across server restarts. Your agents pick up right where they left off.

There's **no database, no cloud dependency, no API key**. Isomux piggybacks on your existing Claude or Codex CLI authentication and inherits the skills you already have set up for those CLIs.

For a deeper dive — including how Claude and Codex sessions differ under the hood, the agent lifecycle, and the WebSocket layer — see the [Design and Architecture blog post](https://nilmamano.com/blog/isomux).

![Isomux system design: browser clients connect over WebSocket to the Bun service, which runs persistent agents backed by Claude Agent SDK sessions and Codex app-server processes, and persists state to the local file system](/architecture.png)
