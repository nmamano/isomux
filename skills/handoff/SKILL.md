---
name: handoff
alias: isomux-handoff
description: Continue an unfinished task on a fresh session. The agent writes a short forward-looking brief of what's left, the boss approves it, and the agent then schedules that brief as a wake-up to itself and resets its session.
---

Continue your unfinished task on a fresh session. Use this when your context is
getting full but the work isn't done: you distil what's LEFT (not what happened)
into a brief, schedule it as a wake-up to yourself, and reset your session so a
clean copy resumes.

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

Show the boss the exact brief you intend to schedule and wait for their
confirmation.

### 3. Schedule the wake-up, then reset

1. Schedule the approved brief as a wake-up to yourself 5s out (it just queues
   until this turn ends):

   ```
   curl -s -X POST localhost:4000/api/agents/<your-own-id>/messages \
     -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"text":"<the approved brief>","deliverAt":"<5s from now>"}'
   ```

2. Once step 1 returns a `scheduledId`, reset your session:

   ```
   curl -s -X POST localhost:4000/api/agents/<your-own-id>/new-conversation \
     -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" -d '{}'
   ```
