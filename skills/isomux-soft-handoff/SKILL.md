---
name: isomux-soft-handoff
alias: soft-handoff
description: Hand off your current task to a peer agent. You write a thorough brief, message it to them directly, then stay around as a reference for follow-up questions. Optionally takes the peer's name as an argument.
---

Hand off your current task to a peer agent so they can carry it forward. Use this when your context is getting full but the work isn't done. After the handoff, you stay around as a reference — the peer can come back with clarifying questions, but they own the work from here.

Syntax: `/isomux-soft-handoff {peer-agent-name}` (or omit the name to be prompted)

### 1. Pick the peer

If a peer name was supplied, look up their agent ID in `~/.isomux/agents-summary.json` (match name case-insensitively). Otherwise try to infer the peer from context — e.g., an agent the boss and you have already paired or consulted with in this session. If there's a clear inference, use it (and briefly confirm who you picked). Otherwise, list candidates (prefer agents whose `cwd` matches yours) and ask the boss to pick. You need the peer's agent ID to POST messages to them.

Flag to the boss before proceeding if:

- The peer's `cwd` differs from yours — they may need to switch directories before they can pick up the work.
- The peer already has an active `topic` — they're mid-task and the handoff might collide.

### 2. Write the brief

Write a brief detailed enough that the boss doesn't have to re-explain anything. Long is fine. Cover:

- **The task** as the boss originally framed it (quote them when possible).
- **What's been done so far** — specific file paths, commits, branches.
- **What's left** — the next concrete steps you'd be taking if you continued.
- **Working state** — dirty files, active worktrees, anything not in git yet.
- **Decisions made along the way** that aren't obvious from the diff.
- **Open questions / unconfirmed assumptions** so they know what to revisit with the boss.
- **Pointers to context** — relevant files, internal-docs pages, related skills. As a backstop, mention that the peer can read your session log via the path in `agents-summary.json` if they need deeper context.

### 3. Send the brief

POST the brief to `/agents/<peer-id>/message` with your own `senderAgentId` so the peer knows who's handing off. The body MUST also tell the peer:

- That they own the work from here — they don't need to check in with you unless they're blocked.
- **If they have clarifying questions, they must POST back to your agent endpoint, not just type in their own chat.** Replies that only land in their own chat never reach you. Give them your agent ID explicitly.

### 4. Confirm and stand by

Tell the boss which peer you handed off to and a one-line gist of what you sent. Suggest they switch to that agent's chat to continue.

Then go idle. Don't start new work and don't check on the peer. If they POST you a question, answer concisely from the context you already have, then go idle again. The boss will tell you when it's safe to `/clear`.
