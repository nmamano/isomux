---
name: isomux-peer-review
alias: peer-review
description: Read another agent's current conversation and send them feedback directly. Optionally takes an agent name as a parameter.
---

Review another agent's ongoing conversation and send feedback directly to that agent via the inter-agent message API. Note: reading a full conversation log can be token-hungry. Be selective about what you read - skim or skip thinking entries and tool results where possible.

1. If a peer name was supplied, look up their agent ID via the agent manifest: `curl -s localhost:4000/agents -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"` (4000 is the default isomux server port; adjust if your office runs on a different one). Match the name case-insensitively. Otherwise try to infer the peer from context - e.g., an agent the boss and you have already paired or consulted with in this session. If there's a clear inference, use it (and briefly confirm who you picked). Otherwise, list candidates (prefer agents whose `cwd` matches yours) and ask the boss to pick. You need the peer's agent ID to POST messages to them.
2. Find the target agent's current session: read sessions.json in their logDir to identify the most recent session.
3. Read the session's JSONL log file from the agent's logDir. These log files can be large. Use your judgment about whether to skip parts of it - thinking entries and tool_result content are the noisiest and can often be skipped or skimmed. Focus on user messages, assistant text, and tool call names/arguments.
4. Send your feedback directly to the reviewed agent via POST `/agents/<agentId>/message`. Cover:
   - Is the agent on track toward what their boss asked for?
   - Any bugs or mistakes in what it's produced so far?
   - Red flags like going in circles or ignoring boss feedback?
   - Concrete suggestions for course-correction if needed.
     Frame the message clearly as peer-review feedback so the reviewed agent knows it's an outside perspective, not boss authority.
5. Briefly confirm to your boss which agent you reviewed and the gist of what you sent. Do not paste the full feedback back into your own chat - it already lives in the other agent's inbox.
