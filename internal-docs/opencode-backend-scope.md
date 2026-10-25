# OpenCode third-backend scope

Status: OC1 backend shipped; move to OpenCode 2 (`@opencode/cli` 2.1.4) decided\
Research date: 2026-08-26  
OpenCode 2 review: 2026-08-27  
OpenCode 2.1.4 gate: 2026-10-25

## Decision summary

Integrate OpenCode as a third native Isomux backend through OpenCode's typed
TypeScript client and headless server API. Do not use ACP, and do not route
OpenCode through a terminal emulator.

The intended product boundary is:

```text
Isomux meta-harness
  -> OpenCode backend adapter
  -> OpenCode harness
  -> selected model provider
```

OpenCode owns its agent loop, tools, permissions, model compatibility,
compaction, and durable session. Isomux owns agent identity, orchestration,
the shared UI, its normalized transcript, office permissions, and the task,
app, file, and inter-agent APIs.

The integration is feasible on paper. OpenCode 1.18.23 and
`@opencode-ai/sdk` 1.18.23 were the stable npm releases on 2026-08-26, and V1
became the production target of the OC1 backend. OpenCode 2 requires V1
integrations to migrate; on 2026-08-27 its server API, clients, configuration,
plugin API, and durable runtime behavior were still beta.

The V1 topology passed the feasibility gate. Nil ruled on 2026-08-27 that the
next step is to scope an adapter against the stable OC1 stack; that backend
and its V2 migration budget live in
[`opencode-oc1-scope.md`](opencode-oc1-scope.md).

OpenCode 2 is the release line since `@opencode/cli` 2.0.0 (2026-09-11), and
OpenCode 1 gets only security builds. Upstream never calls 2.x "stable" and
still marks its server API "Experimental"; no later stable event is coming to
wait for. Nil decided the move on 2026-10-23 and 2026-10-25: an exact pin of
`@opencode/cli` 2.1.4, one cut-over, no OpenCode 1 fallback, and a kept copy
of the version 1 profile database for rollback. The gate passed on
2026-10-25 with conditions that the cut-over tasks carry; see
[`opencode-gate/report-2.1.4.md`](opencode-gate/report-2.1.4.md).

OpenCode stores credentials and
session state in a shared local profile, and its project has an open request
for a documented parallel-headless-worker isolation contract. Isomux must not
run several OpenCode processes against one profile and hope that database
locking, credentials, plugins, and sessions remain isolated.

## Why this backend

OpenCode is an MIT-licensed coding-agent harness. Its published provider layer
supports more than 75 model providers, including OpenRouter, DeepSeek, Ollama,
OpenAI, Anthropic, Google, and custom OpenAI-compatible endpoints. One native
OpenCode integration therefore adds a general harness for low-cost, local, and
alternative models without making Isomux own a model agent loop.

This does not replace the native Claude and Codex backends. Those integrations
use their richest vendor APIs and remain the preferred paths for Claude Code
and Codex. OpenCode is a third harness with a different strength: broad model
and provider support.

## Upstream interface selected

For OpenCode 2, use its separate headless server, not its embedded host:

- `opencode serve` keeps the harness outside Isomux's Bun process. Do not use
  `--service`: it reads its own `service.json`, changes to HOME and checks for
  an incumbent service;
- the HTTP contract lives entirely under `/api`. The gate drove it with plain
  HTTP, not with `@opencode/client`, as the OC1 transport uses its own narrow
  HTTP client;
- the separate process preserves crash, memory, and lifecycle isolation.

The OC1 backend uses OpenCode 1.x:

- `opencode serve` runs a loopback HTTP server and publishes an OpenAPI 3.1
  contract.
- `@opencode-ai/sdk` can start the server and return a typed client, or connect
  to a server that Isomux owns.
- `event.subscribe()` provides the structured SSE stream.

Do not use the embedded V2 SDK for the production topology. It hosts OpenCode
inside the application process. A subprocess matches the existing Isomux
backend boundary and does not put another agent loop on Isomux's Bun event
loop.

Do not use ACP for this backend. ACP would create a reusable runtime-protocol
axis, but that is a different project. This scope adds OpenCode as one native
harness beside the existing native Claude Code and Codex harnesses. OpenCode's
own API exposes its full session, event, permission, model, cost, and diff
surface. Routing it through ACP would add a translation layer and could reduce
that surface without reducing the work needed to fit OpenCode into Isomux's
normalized UI and persistence contracts.

This decision does not reject ACP for future runtimes. ACP needs its own
field-by-field conformance study against LogView, permission round trips, and
session resume. Equal fidelity means, at minimum, that ACP preserves tool calls
and results paired by ID, typed permission requests and responses, structured
diffs, usage data, and enough durable session state to reconstruct LogView
after resume. It must not replace the native Claude Code or Codex paths unless
it passes each check. That study is outside this OpenCode task.

Pin the CLI and SDK to the same exact version. Disable OpenCode self-update so
the protocol cannot drift independently of Isomux releases.

## Proposed runtime topology

Use one on-demand OpenCode server per Isomux user profile, not one server per
agent and not one server for the whole office.

Each per-user server:

- owns that user's OpenCode credentials and durable OpenCode sessions;
- serves all live OpenCode agents and cron runs owned by that user;
- runs on loopback with a generated password that is not logged;
- multiplexes one SSE stream by OpenCode session ID;
- starts on first use and stops after its last client is idle;
- restarts on demand after a crash;
- uses a state directory derived from immutable Isomux `userId`, never the
  mutable username;
- receives the same resolved user environment that Isomux already gives its
  Claude and Codex processes.

This topology avoids two bad alternatives:

- One office-wide server would mix credentials and durable state across
  users.
- Several processes sharing one user profile can contend on OpenCode's local
  database and global state.

It does add a small supervisor below the existing `Backend` interface. A
`BackendSession` becomes a lightweight handle to one session on a shared
per-user server. `close()` unsubscribes and aborts active work; it does not
delete durable history. The supervisor owns process shutdown.

The feasibility spike must prove that one server can run simultaneous sessions
in different working directories without state or event crossover. If that
fails, stop. Do not fall back to several processes sharing one profile.

## Mapping to the Isomux backend contract

### Backend metadata

| Isomux operation | OpenCode source | Proposed behavior |
| --- | --- | --- |
| `getModelOptions` | Cached provider catalog | Return the last known tested defaults. |
| `listModels` | Provider/model discovery API | Flatten each choice to `providerID/modelID`. Keep the provider label in the display label. |
| `getPermissionModes` | OpenCode permission rules | Offer Ask, Accept edits, and Allow all. |
| `createSession` | `session.create` | Bootstrap asynchronously and emit `system_init` with the OpenCode session ID. |
| `resumeSession` | `session.get` plus new event subscription | Confirm the session belongs to the same user profile and working directory before resuming. |
| `forkSessionBeforeMessage` | `session.fork` | Fork at the target message and return the child session ID. Verify first-message behavior in the spike. |
| `getSessionMessages` | `session.messages` | Normalize user and assistant text with stable OpenCode message IDs. |
| `oneShotPrompt` | Temporary session | Create, prompt, read the answer, and delete. |
| `detectAuthError` | Typed message/provider errors | Prefer typed errors. Keep text matching only as fallback. |
| `getLoginInstructions` | OpenCode provider auth CLI | Give a profile-scoped `opencode auth login` terminal card and env-file instructions for API-key providers. |

### Session events

| Isomux `NormalizedEvent` | OpenCode event or part | Notes |
| --- | --- | --- |
| `system_init` | `session.create` / `session.get` | Emit once after the session and event subscription are ready. |
| `assistant_text` | text part deltas and end | One event per part, whole, at its end: each event is a chat entry. A turn that ends mid-part sends what the part holds. |
| `thinking` | reasoning part deltas and end | One event per part, as for text. Preserve duration from part timestamps. |
| `tool_call` | tool part entering pending/running | Use `callID` as `toolUseId`; preserve tool name and structured input. |
| `tool_result` | tool part entering completed/error | Preserve output, attachments, duration, and error state. Emit once per terminal state. |
| `approval_request` | `permission.asked` | Use the permission request ID. Map Allow once and Deny directly. Do not offer a wider choice unless its scope is proven session-only. |
| `turn_completed` | final step plus session idle/error | Emit exactly once per Isomux send. Include step tokens and cost. Ordering and deduplication are spike requirements. |
| `usage_update` | message/step token fields | Optional in v1; completion usage is sufficient if live totals are not reliable. |
| `compacted` | compaction part or `session.compacted` | Emit one visible compaction event. |
| `error` | `session.error` or typed assistant error | Preserve a safe provider error for classification and redact secrets. |
| `file_view` | file attachment part | Resolve only files inside the existing Isomux attachment/path policy. |
| `task_lifecycle` | subtask/agent/tool parts | Defer unless the event stream distinguishes background tasks reliably. |

OpenCode also has an interactive question tool. Isomux currently asks agents to
ask questions in normal chat rather than park a provider-specific question
request. Disable that tool for v1. A later change can add a normalized
elicitation event if more than one backend needs it.

### Session controls

- `send()` calls the asynchronous prompt endpoint and lets SSE drive the turn.
- `abort()` calls the session abort endpoint.
- `canAbortInPlace()` returns true while that session has an active turn.
- `approve()` replies to the pending OpenCode permission request.
- `getContextUsage()` returns null in v1 unless the spike proves an accurate
  current-context reading. Per-message token totals are not the same value.
- `getSubscriptionUsage()` returns `unavailable`; provider billing is not a
  subscription-allowance reading.

## Shared types and persistence

Add `"opencode"` to `AgentBackendType` and the exhaustive backend registry.

Keep `modelFamily` as the existing backend-specific string. For OpenCode it is
the composite `providerID/modelID`. This avoids adding a provider field across
every contract before another backend needs one. The model picker can show
provider and model separately while sending the composite ID.

Reuse the existing Claude-shaped permission values where their meaning is the
same:

- `default`: ask before restricted actions;
- `acceptEdits`: allow reads and edits, ask for shell and other side effects;
- `bypassPermissions`: allow all.

The adapter translates these to explicit OpenCode rules. It must not persist
an OpenCode "always" decision if Isomux promised that an approval lasts only
for the current session.

OpenCode model variants use the exact intersection with Isomux effort levels.
The picker appears only when the selected model exposes at least one matching
variant. Provider-specific names remain hidden, and models without a match use
their OpenCode default.

Existing agent persistence already stores backend, model, effort, permission,
working directory, and session ID. The required migration is additive:

- legacy agents and sessions continue to default to Claude when backend is
  absent;
- OpenCode sessions store `agentType: "opencode"` and the composite model ID;
- cronjob definitions and run snapshots accept and preserve OpenCode;
- killed-agent and resume projections recognize the third backend;
- OpenCode's database remains provider-owned opaque state, like Codex rollout
  files. Isomux's normalized JSONL remains the source for its UI and search.

Add an immutable backend profile key, derived from `userId`, to session factory
options so the adapter can acquire the correct per-user server. Unowned legacy
agents use a single office-local legacy profile. Do not derive security or
credential routing from the username snapshot.

## Authentication and model selection

Isomux must not accept provider API keys through its browser API.

Support both existing setup patterns:

1. The user's env file supplies provider variables. OpenCode receives the
   resolved environment at process start.
2. A terminal card runs the profile-scoped OpenCode authentication command for
   providers that support a login flow.

Never print the generated server password, provider keys, OpenCode `auth.json`,
or provider response headers in logs or chat.

The spawn and new-conversation dialogs fetch models through the existing
`/api/backends/:type/models` route. For OpenCode, the result should include only
providers available to the effective user profile. If OpenCode cannot
distinguish connected from merely catalogued providers reliably, show the
catalog but label unconfigured providers and surface an actionable login error
on first use.

The first supported model set should be small and tested even though OpenCode
has a large catalog. Test at least:

- one OpenCode free model, while the offer exists;
- DeepSeek V4 Flash through OpenCode Zen or direct DeepSeek;
- one OpenRouter model;
- one local Ollama model when the test host has adequate memory;
- one premium reference model for comparison.

Free models must be labeled temporary. Do not send private repositories to a
free model whose terms allow training or trial logging without a clear user
choice.

## Security requirements

OpenCode can load project and global configuration, plugins, MCP servers, and
compatibility files. That is a larger startup surface than an inference API.

Superseded in part on 2026-10-15 (Nil, 2026-10-11: OpenCode should match
Claude): user and project plugins and config load, and `--pure` is not used.
The launch contract is in the Security boundaries section of
[`opencode-oc1-scope.md`](opencode-oc1-scope.md).

The spike must determine what `--pure` disables. The production launch must:

- use `--pure` if it prevents unapproved plugin execution while retaining the
  required core harness;
- disable automatic session sharing and automatic updates;
- bind only to loopback and use authentication;
- isolate data, cache, config, and state by immutable Isomux user ID;
- refuse symlink/path escapes at the same Isomux boundaries used by the other
  backends;
- redact provider credentials and response headers from process errors;
- keep project-supplied executable plugins disabled by default;
- treat OpenCode snapshots as sensitive because they can contain repository
  file contents;
- document that OpenCode permissions are policy checks, not an OS sandbox.

If `--pure` does not stop automatic code-loading paths, the implementation task
must add an explicit launch allowlist or remain blocked on an upstream control.

## UI and route work

The existing model endpoint and backend capability payload are reusable. The
main UI work is removing two-backend assumptions:

- add OpenCode to `ui/engine-options.ts` and its accent/label maps;
- make spawn, new-conversation, resume, killed-agent, and cron dialogs render
  backend-provided models and permission modes without `isCodex` branches;
- hide sandbox and effort controls when the backend does not expose them;
- update model display helpers and demo fixtures;
- change permission copy in `agent-manager.ts` so it comes from backend
  semantics rather than `codex` versus "everything else";
- keep engine switching at conversation boundaries and restore OpenCode when an
  OpenCode session resumes.

The server route table does not need a new public route family. Existing agent,
conversation, model-list, and cron routes carry the backend discriminator.

## Cronjobs

OpenCode cronjobs use the same backend adapter and per-user server as
interactive agents. Their permission policy must be unattended-safe:

- map `bypassPermissions` to the certified V2 unattended permission policy;
- disable the interactive question tool;
- fail the run instead of parking if OpenCode still emits a permission or
  question request;
- snapshot backend, composite model ID, and permission mode in the run record;
- ensure a cron run can resume only inside the same user profile.

## Feasibility gate

Complete this gate before the production adapter, and again before a move to
a new OpenCode line. The first run (2026-08-27,
[`opencode-gate/report.md`](opencode-gate/report.md)) used the V2 beta and
V1 1.18.23. The second run (2026-10-25,
[`opencode-gate/report-2.1.4.md`](opencode-gate/report-2.1.4.md)) used
`@opencode/cli` 2.1.4 with 1.18.35 as the baseline, and added the nine items
of the move's packet. Item 7 below is superseded: since 2026-10-15 Isomux loads
project code, and the second run records what loads instead.

1. Start one authenticated loopback server under an isolated test profile.
2. Run two simultaneous sessions in different repositories and prove that
   messages, events, files, permissions, and session IDs never cross.
3. Stop the server, start it again, and resume both sessions with their prior
   context.
4. Record fixtures for text streaming, reasoning, a shell permission allow and
   deny, a file edit, a failed tool, recovery, abort, fork, compaction, and an
   authentication error.
5. Prove that tool calls and results retain the same `callID` and each terminal
   event is emitted exactly once.
6. Prove the turn-completion signal arrives once and only after all final text
   and tool results.
7. Test `--pure` against a repository containing a harmless project plugin,
   MCP configuration, and compatibility configuration. Record exactly what is
   loaded.
8. Measure idle RSS for one server and incremental RSS for 1, 8, and 16 active
   sessions. Attach the date to the results.
9. Verify provider credentials and the server password do not appear in
   stdout, stderr, SDK errors, SSE fixtures, Isomux logs, or process listings.
10. Verify Linux update/reinstall preserves the pinned backend and its durable
    profile state.

Stop and revise the topology if parallel sessions or per-user state isolation
fails. Stop and report a security blocker if project content can execute code
at server startup without an enforceable opt-out.

## Implementation slices

These slices are the original adapter plan. OC1 built the backend in the
tracer slices of [`opencode-oc1-scope.md`](opencode-oc1-scope.md), and the
move to OpenCode 2 has its own cut-over tasks, listed in the 2.1.4 gate report.

1. **Runtime client and supervisor**: pin dependencies; add the per-user server
   registry, lifecycle, authentication, event multiplexing, and fake client.
2. **Adapter**: implement the `Backend` and `BackendSession` contracts plus
   normalized event translation and fixtures.
3. **Persistence and orchestration**: extend shared types, agent/session
   persistence, resume/fork/edit paths, context invalidation, and migrations.
4. **UI and HTTP contracts**: add the engine choice and make model, effort,
   sandbox, and permission controls capability-driven.
5. **Cronjobs and auth UX**: add unattended runs, profile-scoped login cards,
   model discovery, and typed auth failures.
6. **Hardening and docs**: redaction, crash recovery, idle eviction, live smoke
   tests, user-facing setup/features/how-it-works docs, and release/update
   verification.

Keep commits aligned to these slices. Do not mix an OpenCode SDK version bump
with unrelated backend behavior.

## Test scope

Minimum automated coverage:

- adapter contract tests from recorded OpenCode SSE fixtures;
- fake-client tests for bootstrap, streaming, permissions, abort, completion,
  failure, resume, fork, compaction, and process loss;
- backend registry and validator exhaustiveness;
- persisted-agent and per-session engine migration round trips;
- REST spawn/edit/new-conversation/resume/model-list contracts;
- queue replay and at-least-once send behavior;
- cron create/edit/run/resume and unexpected-permission failure;
- per-user profile isolation and cross-user credential refusal;
- UI engine, model, permission, and hidden-control behavior;
- secret redaction tests;
- one opt-in live smoke tier for each certified provider/model combination.

The live smoke tier must assert invariants, not exact model text.

## Documentation impact when the feature lands

This scope document is not a shipped feature and needs no user-facing copy
change now. When the backend lands, review every surface indexed by
`internal-docs/documentation.md`, with at least these changes:

- `README.md` and `site/index.html` if the headline provider statement changes;
- `docs/features.md`;
- `docs/how-it-works.md`;
- setup documentation for OpenCode authentication and local Ollama;
- `api/chat.ts` feature inventory;
- `AGENTS.md` backend overview;
- Nil's architecture blog because this is an architecture-level change.

## Estimate

Estimate after a successful gate, for one engineer familiar with Isomux:

- feasibility gate: 2-3 focused days;
- runtime supervisor and adapter: 6-9 days;
- persistence, UI, cronjobs, auth, and migrations: 5-8 days;
- hardening, tests, live certification, and docs: 5-8 days.

Expected total: 3-5 engineer-weeks. The range is driven mainly by OpenCode
profile isolation, event ordering, and authentication behavior, not by the
number of model providers.

## Primary upstream references

- OpenCode 2 docs: <https://opencode.ai/v2/docs/>
- OpenCode 2 client: <https://opencode.ai/v2/docs/build/client>
- OpenCode 2 embedded SDK: <https://opencode.ai/v2/docs/build/sdk>
- OpenCode 2 migration from V1: <https://opencode.ai/v2/docs/migrate-v1>
- OpenCode 2 implementation status:
  <https://github.com/anomalyco/opencode/blob/dev/specs/v2/todo.md>
- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenCode server API: <https://opencode.ai/docs/server/>
- OpenCode providers: <https://opencode.ai/docs/providers/>
- OpenCode configuration: <https://dev.opencode.ai/docs/config>
- OpenCode troubleshooting and storage: <https://dev.opencode.ai/docs/troubleshooting/>
- OpenCode repository and MIT license: <https://github.com/anomalyco/opencode>
- Parallel headless-worker isolation request:
  <https://github.com/anomalyco/opencode/issues/33321>
