---
name: isomux-peer-review
description: Read another agent's current conversation and give feedback on how they're doing. Optionally takes an agent name as a parameter.
---

Review another agent's ongoing conversation and provide feedback. Note: reading a full conversation log can be token-hungry. Be selective about what you read — skim or skip thinking entries and tool results where possible.

1. Read ~/.isomux/agents-summary.json to see all agents in the office.
2. If a name was provided in the user context, find that agent. If no name was provided, list all agents that have a topic (i.e. are not idle), excluding yourself, and ask the user to select one.
3. Find the target agent's current session: read sessions.json in their logDir to identify the most recent session.
4. Read the session's JSONL log file from the agent's logDir. These log files can be large. Use your judgment about whether to skip parts of it — thinking entries and tool_result content are the noisiest and can often be skipped or skimmed. Focus on user messages, assistant text, and tool call names/arguments.
5. Provide feedback to the user focused on:
   - Is the agent on track toward what the user asked for?
   - Are there any bugs or mistakes in what it's produced so far?
   - Any red flags like going in circles or ignoring user feedback?
6. If appropriate, give the user advice on how they can help the agent (e.g. clarify instructions, unblock it, correct course).
