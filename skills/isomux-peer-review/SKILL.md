---
name: isomux-peer-review
description: Read another agent's current conversation and send them feedback directly. Optionally takes an agent name as a parameter.
---

Review another agent's ongoing conversation and send feedback directly to that agent via the inter-agent message API. Note: reading a full conversation log can be token-hungry. Be selective about what you read — skim or skip thinking entries and tool results where possible.

1. Read ~/.isomux/agents-summary.json to see all agents in the office.
2. If a name was provided in the user context, find that agent. If no name was provided, list all agents that have a topic (i.e. are not idle), excluding yourself, and ask the user to select one.
3. Find the target agent's current session: read sessions.json in their logDir to identify the most recent session.
4. Read the session's JSONL log file from the agent's logDir. These log files can be large. Use your judgment about whether to skip parts of it — thinking entries and tool_result content are the noisiest and can often be skipped or skimmed. Focus on user messages, assistant text, and tool call names/arguments.
5. Send your feedback directly to the reviewed agent via POST localhost:4000/agents/<agentId>/message (include your own senderAgentId so they can see who's reviewing). Cover:
   - Is the agent on track toward what their boss asked for?
   - Any bugs or mistakes in what it's produced so far?
   - Red flags like going in circles or ignoring boss feedback?
   - Concrete suggestions for course-correction if needed.
   Frame the message clearly as peer-review feedback so the reviewed agent knows it's an outside perspective, not boss authority.
6. Briefly confirm to your boss which agent you reviewed and the gist of what you sent. Do not paste the full feedback back into your own chat — it already lives in the other agent's inbox.
