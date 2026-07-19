---
name: isomux-handoff
alias: handoff
description: Continue an unfinished task on a fresh session. The agent writes a short forward-looking brief of what's left, the boss approves it, and the agent then hands off to a fresh copy of itself that resumes on just that brief.
---

Continue your unfinished task on a fresh session. Use this when your context is
getting full but the work isn't done: you distil what's LEFT (not what happened)
into a brief and hand off to a fresh copy of yourself that resumes on just that
brief.

### 1. Write the handoff brief

The brief is FORWARD-LOOKING: only what the next session needs to carry the work
forward. It is NOT a summary of this conversation.

Include:

- The goal: what still needs to be accomplished, as concretely as you can.
- The next concrete steps: what you'd do next if you kept going.
- Working state that isn't obvious from disk: dirty files, active
  worktrees/branches, paths, commits, anything uncommitted, in-flight commands.
- Decisions already made that the fresh session shouldn't relitigate, and any
  open questions or unconfirmed assumptions to revisit with the boss.
- Pointers: the specific files, docs, or task IDs the work touches.

Deliberately leave OUT:

- A narrative recap of what happened this session ("first I did X, then Y...").
- Anything already in your system prompt, your custom instructions, or isomux
  memory. The fresh session reloads all of that automatically.
- Generic advice the fresh you would already know.

Keep it tight.

### 2. Get the boss's approval

Show the boss the exact brief you intend to hand off and wait for their
confirmation.

### 3. Hand off

Hand off to a fresh copy of yourself with the approved brief. This resets your
session and delivers the brief into the fresh session in one step, so a clean
copy resumes on the brief - instantly, with no wait:

```
curl -s -X POST localhost:4000/api/agents/<your-own-id>/handoff \
  -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"<the approved brief>"}'
```

Your current turn ends as the reset takes effect; the fresh session picks up the
brief on its own. (For a genuine FUTURE reminder or wake-up instead of an
immediate handoff, use the scheduled-message path - a POST to your own
`/messages` with a `deliverAt` - rather than this endpoint.)
