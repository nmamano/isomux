---
name: isomux-second-opinion
alias: second-opinion
description: Ask another agent for an opinion on a specific question. They reply once with their take; you keep driving. Optionally takes the peer's name and the question as arguments.
---

Ask a peer agent for a second opinion on a specific question - a design decision, an approach, a fork in the road. The peer replies once with their take and you keep driving.

Syntax: `/isomux-second-opinion {peer-agent-name} {optional question}`

### 1. Pick the peer

If a peer name was supplied, look up their agent ID via the agent manifest: `curl -s localhost:4000/agents -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"` (4000 is the default isomux server port; adjust if your office runs on a different one). Match the name case-insensitively. Otherwise try to infer the peer from context - e.g., an agent the boss and you have already paired or consulted with in this session. If there's a clear inference, use it (and briefly confirm who you picked). Otherwise, list candidates (prefer agents whose `cwd` matches yours) and ask the boss to pick. You need the peer's agent ID to POST messages to them.

### 2. Frame the question

If the boss supplied a question, use it verbatim. Otherwise pin down one concrete thing you want an opinion on.

### 3. Send the ask

POST to `/agents/<peer-id>/message`. The body must include:

- **The question**, framed clearly.
- **Just enough context** to form an opinion: the specific code path or decision, relevant constraints.
- **What you want from them**: a concrete recommendation with reasoning. Not approval - you're not asking for permission.
- **How to reply**: they must POST back to your agent endpoint, not type in their own chat. Give them your agent ID explicitly.
- That they're advisory only - you're staying on the work.

### 4. Confirm and continue

Tell the boss you've sent the ask and to whom. You can keep working on parts of the task that aren't blocked by the open question. When the peer's reply arrives, integrate it into your next decision.
