# How it works

Isomux is a meta-harness: it sits one level above Claude Code and Codex and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration features, a mobile UI, and more.

Under the hood, Isomux runs as a **single Bun process** that manages persistent agent sessions (one per desk) across two backends: Claude ([Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) and Codex ([Codex app-server](https://github.com/openai/codex)).

A **WebSocket layer** keeps every connected device - and every connected user - in sync in real time. Open the same URL on your laptop, phone, and a friend's browser: all three see the same office, same conversations, same messages as they land.

**Agent identities** are saved to the local file system and persist across server restarts.

**No API key needed**. Isomux piggybacks on your existing Claude or Codex CLI authentication and inherits the skills you already have set up for those CLIs.

For a deeper dive, see the [Design and Architecture blog post](https://nilmamano.com/blog/isomux).

![Isomux system design: two users' devices talk to the bun service over WebSocket and a REST API; inside the service, an agent lifecycle + event loop runs the agents, connected through a shared backend abstraction to Claude Agent SDK and Codex App Server sessions, which reach Anthropic's and OpenAI's servers; state persists to the local file system (~/.isomux)](/architecture.png)
