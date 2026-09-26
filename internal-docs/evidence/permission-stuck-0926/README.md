# Permission prompt: clicks do nothing, agent never continues (task 7a185be0)

Diagnosis, 2026-09-26, on c223b277. No product code changed.

## Reproduction

`reproduce.ts` in this directory (run command in its header). A real Claude agent in default permission mode gets a prompt to run two subagents in parallel. Each subagent asks for Bash permission. The harness sends every server event through the real UI reducer and clicks the card that LogView shows. Transcript: `run.txt` (made on c223b277; the product code is the same at this commit).

Result (`run.txt`):

1. Two `approval_request` events arrive 1.8 s apart. The UI holds two cards; the server holds only the second.
2. The UI shows the first card. Four clicks on it (Allow, Deny, Allow, Deny) all return 404 `interaction_not_found`. The member sees only "Could not apply that choice." under the card.
3. After a reload the UI shows the second card. The click on it succeeds, and one subagent runs.
4. The other subagent waits forever. No card shows, the turn never ends, and the other file is never written.

Bedrock is not necessary for the reproduction. The run used the box's default Claude login. From the source: concurrent approval events from any Claude provider take this same server path, so a Bedrock agent that runs parallel subagents probably gets the same result. Bedrock itself and its launch configuration were not tested.

## Cause

Claude's SDK serializes permission requests for parallel tool calls in one agent (checked with a direct SDK probe, 2026-09-26). It does not serialize requests from parallel subagents: two `canUseTool` calls were open at the same time (probe: 5.3 s and 6.0 s).

- `server/backends/claude.ts:791` keeps both requests in `pendingApprovals`. That is correct. The comment at `:810` ("SDK tool calls are serialized") is wrong for subagents.
- `server/agent-manager.ts:4489` keeps one `pendingPermission` per agent. The second request overwrites the first. Nothing can resolve the first SDK request after that, so its subagent, and the turn, wait forever.
- `server/agent-manager.ts:2850` (`openChoiceInteraction`) replaces `pendingInteraction` but emits no `interaction_removed` for the old card.
- `ui/store.tsx:499` keeps both cards, and `ui/log-view/LogView.tsx:741` shows the first (`find` by agent id). Every click goes to the forgotten card and gets the 404 at `server/agent-manager.ts:7181`.

Recovery, from code (not run live): stop the agent or `/clear`. `ClaudeSession.close()` denies every open request (`server/backends/claude.ts:942`).

Other engines, from code (not run live): the Codex backend keeps a map of requests, but it goes through the same single server slot. The OpenCode transport keeps one `pendingPermission` (`server/backends/opencode/transport.ts:653`).

## Proposed fix

1. Server, root cause (medium; about 100 lines in `agent-manager.ts` plus tests): replace the one `pendingPermission` slot with a first-in, first-out queue per agent. A request that arrives while one is open goes into the queue: log it, and show its card when the one before it is answered. A member answer settles only the request it identifies and then shows the next card. Stop, session swap, the echo race and session loss settle all the requests of the affected session. Keep the request and session identity across the asynchronous `approve()` and teardown. If `approve()` rejects, keep the next card open.
2. Server, UI half (small; about 10 lines plus a test): `openChoiceInteraction` emits `interaction_removed` for any interaction it replaces. Then no client can keep a card that the server forgot.
3. Fix the comment at `server/backends/claude.ts:810`.

Not proposed: deny the older request when a newer one arrives. That fails a subagent's work without a member choice.

Open question for Isomux PM: when a member picks "Allow for this session" on the first request, should the server resolve queued requests that the new rule covers? The SDK does not check a request again after it is open. Proposal: no, show each request in turn. Rule matching belongs to the backend; the manager must not infer authorization from input summaries. This is a product decision for Isomux PM.

## After the fix

Fixed in the commits after this diagnosis on branch `permission-stuck`. Transcript: `run-fixed.txt`, same harness, made on cd5c55bb. The UI shows one card. The first click allows one subagent, and the second request then gets its own card. The second click denies it. The turn finishes. The harness waits about 90 s at the start, because its wait condition expects two cards at once, which the fix no longer shows.

OpenCode, 2026-09-26: the pinned 1.18.23 server can also have two requests open in one session. Upstream `packages/opencode/src/permission/index.ts` at tag v1.18.23 keeps a map of pending requests with no per-session lock, and the AI SDK runs the tool calls of one step in parallel. A probe of the pinned binary with a local mock provider saw two `permission.asked` events for one session in the same millisecond, both still pending 3 s later. A `reject` for one request also rejects the other open requests of the same session (`index.ts:121-138`).

## Withdrawn requests

Isomux PM ruling, 2026-09-26: a queued card must never show a request that the backend already closed, and no card may stay after the turn ends. Backends now emit `approval_withdrawn`. The manager drops a withdrawn request from the queue, or closes its open card and shows the next one, and records no member choice for it.

- Claude: the SDK aborts a pending `canUseTool` signal when the CLI sends `control_cancel_request` (`handleControlCancelRequest` in `sdk.mjs`, SDK 0.3.280), and on query cleanup. A probe on 2026-09-26 saw the signal fire before any answer when `interrupt()` was called. `close()` empties the request map first, so a teardown emits no withdrawal.
- OpenCode: a reject closes every open request of the session, so the transport withdraws the others. Requests still open when the turn ends are also withdrawn.
- Codex: the app-server protocol has `serverRequest/resolved` (`_generated/v2/ServerRequestResolvedNotification.ts`). The adapter withdraws an approval it still holds when that notification arrives. Not observed live.
