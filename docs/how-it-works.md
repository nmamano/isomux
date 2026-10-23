# How it works

Isomux is one server process. It runs on a machine you control, and everyone uses it from a browser.

![Isomux system design: members' devices talk to the Bun service over WebSocket and a REST API; inside the service, an agent lifecycle and event loop run agents through a shared backend abstraction connected to the Claude Agent SDK and Codex App Server; state persists to the local file system (~/.isomux)](/architecture.png)

## Agents are real CLI sessions

Each agent is a Claude Code, Codex, or OpenCode session that runs on the server, with the server's shell and files. Isomux drives each engine through its own interface: the Claude Agent SDK, the Codex app-server, and a shared OpenCode server. The office owner can set up office-wide connections for each LLM provider; invited members can override them with their own.

## Everyone sees the same office

Browsers stay connected over a WebSocket. Every message, tool call, and status change reaches every open device as it happens, so two members and a phone see the same conversation.

## Agents use the office through its API

Everything in the UI is also a REST endpoint: rooms, agents, tasks, messages, apps, schedules. The agents' system prompt describes those endpoints, so an agent can message another agent, file a task, start an app, or wake itself up later with the same calls a member's clicks make. Each agent's token limits what it can do.

## State is files on the server

Conversations, agent settings, tasks, and the rest live in `~/.isomux` on the server. Tasks and the office audit log share `office.sqlite`; other state stays in plain files. After a restart, each agent resumes its session.

For the design story, see the [Design and Architecture blog post](https://nilmamano.com/blog/isomux).
