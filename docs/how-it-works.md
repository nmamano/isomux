# How it works

Isomux is a meta-harness: it sits one level above Claude Code, Codex, and OpenCode and manages multiple agents, adding inter-agent messaging, a shared task board, human collaboration features, a mobile UI, and more.

Under the hood, Isomux runs as a **single Bun process** that manages persistent agent sessions (one per desk) across three backends: Claude ([Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)), Codex ([Codex app-server](https://github.com/openai/codex)), and a pinned OpenCode server shared by agents with the same environment source.

A **WebSocket layer** keeps every connected device - and every connected user - in sync in real time. Open the same URL on your laptop, phone, and a friend's browser: all three see the same office, same conversations, same messages as they land.

**Agent identities** are saved to the local file system and persist across server restarts.

Isomux uses each backend's own login state. Claude and Codex can use their existing CLI sign-ins. OpenCode uses a shared profile for each environment and reads provider API keys from its environment. To use your own Anthropic or OpenAI API key with OpenCode, add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` under User Settings → Connections.

For a deeper dive, see the [Design and Architecture blog post](https://nilmamano.com/blog/isomux).
