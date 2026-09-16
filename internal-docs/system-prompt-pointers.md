# System prompt API pointers

Design status: proposed on 2026-09-16. This document does not implement the change.

## Goal

Replace the office API manual in `server/system-prompt.ts` with a short capability index. Each capability names one stable place where an agent can fetch the exact contract when it needs it. Keep rules that must affect every turn inline.

## Size

On 2026-09-16, `buildSystemPrompt()` with no office, room, member, memory, or custom text produces:

| Engine | Agent | Characters and bytes | Whitespace-separated words |
| --- | --- | ---: | ---: |
| Claude | Ordinary | 33,335 | 4,898 |
| Claude | Privileged | 43,270 | 6,024 |
| Codex | Ordinary | 31,619 | 4,627 |
| Codex | Privileged | 41,554 | 5,753 |
| OpenCode | Ordinary | 34,352 | 4,706 |
| OpenCode | Privileged | 46,651 | 5,874 |

The measurement rendered each `agentType` with the arguments from `server/test-support/system-prompt.test.ts`, then used JavaScript string length, `Buffer.byteLength`, and a whitespace split. Every measured character is ASCII, so characters and UTF-8 bytes are equal. Dynamic office text is excluded. No tokenizer is checked into this repo, so this design does not claim a token count.

The after-size budget is 9,000 bytes for an ordinary Claude or Codex agent, 11,000 bytes for an ordinary OpenCode agent, and 2,000 added bytes for a privileged agent. These are acceptance budgets, not estimates. The implementation must measure the final rendered strings for all six engine and privilege combinations before it lands.

## What stays inline

The prompt keeps information that the agent must apply before it knows that it needs a reference:

- Its identity, agent id, room, manager, message labels, language, and hosted-office identity.
- The office purpose and a short list of available features.
- Authorization boundaries, credential handling, content-as-data rules, and the rule for another member's credentials.
- When an action requires member approval or explicit authorization.
- The rule to use the bearer token only with the local office API and never expose it.
- The rule to reply to remote members at their reply handle.
- The rule to consult a feature reference before the first call, including one generic fetch example.
- Office, room, member, and agent instructions and memory. These are deployment data, not API documentation.
- Engine-specific facts that change how the agent can read a reference.

The privileged block becomes a short list of added capabilities and human-only exclusions. It does not keep route catalogs or request examples.

## What becomes a pointer

The prompt lists these features with a topic name beside each one:

| Feature | Actor and exact reference |
| --- | --- |
| Agent and member discovery | The agent fetches `GET /api/agent-reference/discovery`. |
| Task board | The agent fetches `GET /api/agent-reference/tasks`. |
| Files, diffs, editor, terminal, and page preview | The agent fetches `GET /api/agent-reference/chat-affordances`. |
| Browser control | The agent fetches `GET /api/agent-reference/browser`. |
| Agent-built apps | The agent fetches `GET /api/agent-reference/apps`. |
| Context and subscription readings | The agent fetches `GET /api/agent-reference/usage`. |
| Conversation logs and sessions | The agent fetches `GET /api/agent-reference/conversation-history`. |
| Inter-agent and API-token messaging | The agent fetches `GET /api/agent-reference/messaging`. |
| Scheduled messages | The agent fetches `GET /api/agent-reference/scheduled-messages`. |
| New conversation and handoff | The agent fetches `GET /api/agent-reference/conversation-lifecycle`; the `/handoff` skill carries the longer workflow. |
| Cronjob inspection | The agent fetches `GET /api/agent-reference/cronjobs`. |
| Shared memory | The agent fetches `GET /api/agent-reference/memory`. |
| Inline diagrams | The agent fetches `GET /api/agent-reference/visuals`. |
| Privileged agent, room, and cron operations | A privileged agent fetches `GET /api/agent-reference/operator`. |
| Session closeout | The agent invokes the built-in `/wrap-session` skill. |

Each topic holds the current route, method, parameters, response shape, scope, error cases, and one safe example. Long operating procedures remain skills. `/wrap-session` and `/handoff` are examples: the prompt lists them as features, and the skill carries the workflow.

## Reference storage and retrieval

Store the source text as checked-in Markdown under `agent-reference/<topic>.md`. A server route reads only known topic names from that directory:

```text
GET /api/agent-reference
GET /api/agent-reference/<topic>
```

The index returns topic names, one-line descriptions, and a content version. A topic response returns its Markdown and the same version. The routes accept `agent`, `api`, and `user` identities and return only topics that apply to that identity. They refuse `cron-run` and `app` identities. A cron run receives a separate prompt from `server/cronjob-manager.ts`; changing that prompt is outside this design. The server owns the allowlist; caller input never becomes a filesystem path.

Claude and Codex agents fetch a topic with the local HTTP route and their injected bearer token:

```sh
curl -s localhost:<port>/api/agent-reference/<topic> -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"
```

An OpenCode agent has no bearer token. It fetches the same route through the authority proxy, with the per-turn handle that Isomux substitutes into its prompt:

```sh
curl -s http://isomux/api/agent-reference/<topic> --unix-socket <authority-socket> -H "X-Isomux-Turn: __ISOMUX_OPENCODE_TURN__"
```

The system prompt renders the one inline fetch example in the syntax for that agent's engine. The route works when the agent's current directory is outside the Isomux checkout.

The checked-in Markdown remains readable to maintainers and testable without starting a provider. Built-in skills may link to topic names, but they do not copy route details. Public product documentation remains in the surfaces listed by `internal-docs/documentation.md`; the reference is the agent-facing operational contract.

## Keeping references correct

- Add the two reference routes to the typed route table and the agent route manifest.
- Contract-test the topic allowlist, identity filtering, unknown-topic response, and path traversal refusal.
- Make the route-table test fail when an agent-facing route has no reference topic or an explicit exemption.
- Make system-prompt tests require every advertised topic to exist and forbid detailed office route examples outside the single generic fetch example.
- Update the reference and route behavior in the same commit.

## Risk: the agent does not follow a pointer

An agent can guess an endpoint from prior knowledge or skip retrieval to save time. That can cause a wrong method, stale scope, or unsafe request. The current long prompt lowers this risk for routes that the model notices, but its size also makes details easy to miss.

Mitigations:

- Put the topic beside each feature instead of in a separate appendix.
- Say inline that the agent must fetch the topic before its first call in a session.
- Keep each topic short and return it in one call.
- Return structured errors that name the relevant topic when a request has the wrong method or shape.
- Keep identity, authorization, approval, and secret rules inline because a missed pointer must not bypass them.
- Log the session id, topic fetch, and feature route category. The primary metric is the share of agent sessions where the first call to a feature route comes before a fetch of that feature's topic in the same session.
- Before release, run ten scripted tasks per topic against both the current prompt and the pointer prompt on Claude, Codex, and OpenCode. The pointer prompt must fetch the matching topic before the first feature call in at least 95% of runs, and its task success rate must be no more than five percentage points below the current prompt for any engine.
- After release, measure the same ordering metric from server request logs. If more than 5% of sessions call a feature first, move the minimum rule for that feature back inline.

The pointer design trades guaranteed injection for retrieval on demand. The implementation should ship only with tests for pointer coverage and telemetry that can show whether the trade works.
