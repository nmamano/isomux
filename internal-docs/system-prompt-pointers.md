# System prompt API pointers

Design approved on 2026-09-16, implemented on 2026-09-22, and rebased onto main on 2026-10-03.

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

On 2026-10-03, after the rebase onto current main, the same arguments render:

| Engine | Agent | Characters | Bytes | Whitespace-separated words |
| --- | --- | ---: | ---: | ---: |
| Claude | Ordinary | 4,252 | 4,256 | 656 |
| Claude | Privileged | 4,858 | 4,862 | 749 |
| Codex | Ordinary | 3,541 | 3,545 | 539 |
| Codex | Privileged | 4,147 | 4,151 | 632 |
| OpenCode | Ordinary | 3,872 | 3,876 | 590 |
| OpenCode | Privileged | 4,478 | 4,482 | 683 |

The manager section's two arrow characters make bytes exceed characters by four. The privileged block adds 606 bytes. Main renders 37,302 to 53,228 bytes for the same six cases on that date.

On 2026-10-05 the index became one situation per line (Nil, 2026-10-04: an agent that does not think of a feature never fetches its page), and the privileged page split into five. The same arguments render:

| Engine | Agent | Characters | Bytes | Whitespace-separated words |
| --- | --- | ---: | ---: | ---: |
| Claude | Ordinary | 6,137 | 6,141 | 1,021 |
| Claude | Privileged | 7,174 | 7,178 | 1,196 |
| Codex | Ordinary | 5,426 | 5,430 | 904 |
| Codex | Privileged | 6,463 | 6,467 | 1,079 |
| OpenCode | Ordinary | 5,757 | 5,761 | 955 |
| OpenCode | Privileged | 6,794 | 6,798 | 1,130 |

The privileged block adds 1,037 bytes. The 75-run check above predates this wording; task 73b70f84 holds the situation-coverage method and its check.

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
- Rules for every reply: a normal reply reaches members only, and a literal dollar sign needs escaping.
- How to read an Isomux note that another agent interrupted or stopped the turn.
- Where to read about Isomux itself, and the trigger to run `/wrap-session` when the session goal is complete.

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
| Privileged agent, room, cronjob, members-chat, and member operations | A privileged agent fetches `agent-management`, `rooms`, `cronjob-management`, `members-chat`, or `members`, one page per situation. |
| Session closeout | The agent invokes the built-in `/wrap-session` skill when the session goal is complete. |

Each topic holds the current route, method, parameters, response shape, scope, error cases, and one safe example. Long operating procedures remain skills. `/wrap-session` and `/handoff` are examples: the prompt lists them as features, and the skill carries the workflow.

## Reference storage and retrieval

Store the source text as checked-in Markdown under `server/agent-reference/<topic>.md`. A server route reads only known topic names from that directory:

```text
GET /api/agent-reference
GET /api/agent-reference/<topic>
```

The index returns topic names, one-line descriptions, and a content version. A topic response returns its Markdown and the same version. The routes accept `agent`, `api`, and `user` identities and return only topics that apply to that identity. They refuse `cron-run` and `app` identities. A cron run receives a separate prompt from `server/cronjob-manager.ts`; changing that prompt is outside this design. The server owns the allowlist; caller input never becomes a filesystem path.

Claude and Codex agents fetch a topic with the local HTTP route and their injected bearer token:

```sh
curl -s localhost:<port>/api/agent-reference/<topic> -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"
```

An OpenCode agent has no bearer token. It fetches the same route through the authority proxy. The prompt builder emits a placeholder. `OpenCodeTransport` replaces it once with the authority binding's stable per-transport handle; the rendered system prompt stays byte-identical across turns while the binding is activated and deactivated for each turn:

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
- Log the session id, topic fetch, and feature route category. The session id is sampled before the call, so a handoff is logged under the session that made it. A feature call also lists every topic that pins its exact route, and a send with `deliverAt` is in the scheduled-messages category. The primary metric is the share of agent sessions where the first call to a feature route comes before a fetch of any topic it lists in the same session.
- Before release, run five representative tasks five times on each of Claude, Codex, and OpenCode with the new prompt (75 runs). Use isolated office state and no customer actions. Report per-engine feature use, reference-fetch ordering, and task success; the check must test behavior, not only reference presence.
- After release, measure the same ordering metric from server request logs. If more than 5% of sessions call a feature first, move the minimum rule for that feature back inline.

The pointer design trades guaranteed injection for retrieval on demand. The implementation should ship only with tests for pointer coverage and telemetry that can show whether the trade works.
