---
name: isomux-pair-programming
alias: pair-programming
description: Pair-program a feature with another agent in the office. You drive (scope, design, implement); they review at design and code stages. Optionally takes the peer's name and a feature prompt as arguments.
---

Pair-program a feature with another agent. You drive, they review.

Syntax: `/isomux-pair-programming {peer-agent-name} {feature prompt}`

Setup: if a peer name was supplied, look up their agent ID via the agent manifest: `curl -s localhost:4000/agents -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"` (4000 is the default isomux server port; adjust if your office runs on a different one). Match the name case-insensitively. Otherwise try to infer the peer from context - e.g., an agent the boss and you have already paired or consulted with in this session. If there's a clear inference, use it (and briefly confirm who you picked). Otherwise, list candidates (prefer agents whose `cwd` matches yours) and ask the boss to pick. You need the peer's agent ID to POST messages to them. Work in the current cwd unless the boss explicitly asks for a worktree.

**Every time you message the peer, include an explicit instruction telling them they must reply by POSTing back to your agent endpoint, not just by writing in their own chat.** Replies that only appear in their own chat never reach you, so the iteration stalls.

### Phase 1: scope (solo)

Scope the feature end-to-end by yourself. Read the relevant code, understand what touches what, and gather the context needed to design it. Don't loop in the peer yet. When done, auto-advance to Phase 2.

### Phase 2: design (with peer)

Before writing any code, send the peer a short plan: files touched, approach, key edge cases. Ask for feedback.

Iterate. Stop and escalate to the boss with both positions summarized if either:

- you reach 5 rounds without convergence, or
- the decision involves architectural tradeoffs that affect other parts of the system.

Otherwise, once aligned, auto-advance to Phase 3.

### Phase 3: implementation (with peer review)

Implement the feature. Then ask the peer to review the diff (point them at the cwd if they share it, or share the diff inline). Tell them their goal is to uphold code quality and principled architecture.

Iterate under the same escalation rule.

When you're both satisfied, present to the boss:

1. What you built and why.
2. Key decisions and alternatives considered.
3. Open questions, if any.

Pair programming is for end-to-end autonomous feature development. Don't rope the boss in at any point that's not one of the two indicated checkpoints: after design (ONLY if needed) and after implementation.
