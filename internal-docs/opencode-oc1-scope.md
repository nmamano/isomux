# OpenCode OC1 adapter scope

Status: proposed for implementation\
Decision date: 2026-08-27\
Runtime target: OpenCode CLI 1.18.23

## Decision

OpenCode gives Isomux one harness with broad model and provider support. OC1 is
the stable way to add it now.

Build the first OpenCode backend against OC1, the stable V1 stack. The gate
proved the per-user server topology, parallel sessions, restart, resume, and
event ordering. Cross-user profile and credential isolation is designed, not
yet proved; slice 6 tests it. The gate also found contract and security defects
that the adapter must contain.

This is a bridge to stable V2, not throwaway work. Isomux's backend adapter,
supervisor, normalized events, persistence, UI, cron support, and tests survive
the move. One version-scoped transport module contains the OC1 HTTP and SSE
contract so V2 does not spread through the product.

## OC1 contract

Use the recorded HTTP and SSE fixtures as the source of truth. Do not use the
V1 SDK in the production transport path. CLI and SDK 1.18.23 disagree: the
server emits `permission.asked` and accepts
`POST /permission/:requestID/reply`, while the SDK describes an older event and
route. A small HTTP client with narrow runtime validators avoids a mixed
contract. Validators accept unknown fields but never log them.

Pin the CLI to 1.18.23. Any CLI version change invalidates the fixtures and
requires the gate harness and event analysis to run again.

Tool state is keyed by `(sessionID, partID)`. `callID` pairs a call with its
result, but it is not globally unique. Abort is also distinct from ordinary
completion: an abort emits `session.idle` without `step-finish`.

## Security boundaries

The security requirements in
[`opencode-backend-scope.md`](opencode-backend-scope.md) apply in full. This
section adds the boundaries the gate forced.

All OpenCode launches go through one supervisor-owned spawn builder. It always
sets the three code-loading controls together:

- `--pure`
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`
- `OPENCODE_DISABLE_CLAUDE_CODE=1`

Automatic updates are a separate control. The builder also sets
`OPENCODE_DISABLE_AUTOUPDATE=1` and writes `autoupdate=false` in the approved
profile configuration. Create, restart, authentication, and model-discovery
paths cannot spawn OpenCode directly. A repository text-scan test enforces that
no other path launches the binary.

Redaction sits at the raw HTTP and SSE ingress, before provider data can reach
diagnostics, JSONL, normalized events, or the browser. Structured errors use a
default-deny keep list: retain only `name`, `message`, `statusCode`, and
`isRetryable`, and drop every other field. This removes `responseHeaders`,
`responseBody`, `metadata.url`, and unknown future fields. Further fields can
be added only after a security review.

## Supervisor

Run one server per immutable Isomux `userId`, with its profile below Isomux
`STATE_ROOT`. Start it on the user's first OpenCode use, share it across that
user's sessions, and stop it after the last client and turn have been idle for
the chosen timeout. A live cron run counts as a client for its whole run.

Measurements from 2026-08-27 show why. One idle server costs about 380 MiB.
The increase above idle was 94.1 MiB at one minimal mid-turn session, 96.9 MiB
at eight, and 201.5 MiB at 16. A second concurrent user therefore costs more
memory than adding eight sessions to an existing user's server. Servers are
expensive; sessions on one server are comparatively cheap. This favors lazy
start, one server per user, and idle shutdown. Cron runs can start servers even
when no browser user is active, so office sizing must use concurrent servers,
not signed-in browser users.

These values are floors from a deterministic mock with almost no token flow or
tool output. They are topology evidence, not production capacity limits. Live
certification must measure real provider streams and tool results.

## Fork and edit-message

The gate proved only that the OC1 fork endpoint responds. Slice 1 must first
verify fork at the selected message, the child transcript, and the child's
first new message. If any of these fail, Isomux capability-gates edit-message
and fork off for OpenCode and ships OC1 without them.

## Cron requirements

The parallel cron backend seam owns its general shape. OpenCode requires it to
carry backend selection, immutable user/profile identity, the composite
provider/model ID, permission mode, lifecycle controls, and normalized events.

An unattended OC1 session receives standing allow rules at creation, not
`once` answers. The gate showed that `once` does not persist: a later shell
request asks again. Disable the interactive question tool. If a permission or
question event still arrives, fail the run and record the reason instead of
parking it. A run resolves the same `userId` profile without a browser session
and can resume only inside that profile. It also keeps the server alive for the
whole run.

## V2 migration budget

When a stable V2 CLI/client pair ships, rerun the full gate before changing the
adapter. The known beta pair's prompt fails with `Missing key at ["prompt"]`,
its `/api/server` route serves HTML, and its fork and compaction routes disagree
with the client. Migration therefore stays inside the version-scoped transport
module.

Keep unchanged:

- the per-user supervisor and profile ownership;
- the `Backend` and `BackendSession` behavior;
- normalized events, persistence, UI, cron behavior, and product-level tests;
- startup and redaction policies.

Re-record and adapt:

- every HTTP route, request, response, and SSE fixture;
- runtime validators and event translation;
- fork, compaction, permission, prompt, completion, and abort behavior;
- live-model, memory, isolation, redaction, restart, and update checks.

Discard:

- the OC1 transport module and its 1.18.23 fixtures;
- OC1-only compatibility code and route names.

Budget 4-7 focused days after a stable V2 pair exists: 1-2 days to rerun and
review the gate, 2-3 days to replace the transport and fixtures, and 1-2 days
for regression and live certification. A failed V2 gate pauses migration; it
does not invalidate the OC1 product work.

## Implementation slices

1. **Contract proof and supervisor, 3-5 days.** Pin CLI 1.18.23, add the
   version-scoped fixture client and per-user lifecycle, enforce every launch
   control, and resolve fork capability first.
2. **Adapter and normalization, 4-6 days.** Implement sessions, event mapping,
   default-deny error redaction, tool identity, completion, abort, permissions,
   compaction, and fixture tests.
3. **Persistence and orchestration, 3-4 days.** Add the backend discriminator,
   immutable profile ownership, resume, capability-gated fork/edit, migrations,
   and update-state placement.
4. **UI and HTTP contracts, 2-3 days.** Add OpenCode and make model, effort,
   sandbox, and permission controls follow backend capabilities.
5. **Cron, authentication, and models, 3-4 days.** Integrate with the cron seam,
   standing unattended rules, safe interaction failure, profile-scoped login,
   model discovery, and typed auth failures.
6. **Hardening and release, 4-6 days.** Test crashes, idle shutdown, profile and
   credential isolation, real-load memory, certified models, update/rollback,
   and every documentation surface listed in `documentation.md`.

Expected OC1 implementation: 4-6 engineer-weeks. Fork failure reduces the
shipped capability; contract drift or a security-boundary failure stops and
re-cuts the affected slice.

## Open questions

- What idle timeout balances memory recovery against restart delay?
- Which safe structured-error fields, if any, should join the keep list?
- What memory ceiling is safe under real provider streams and large tool
  results?
- What exact subpaths and packaging layout hold the pinned binary and the
  profiles below `STATE_ROOT`?
- Which small provider/model set is certified first?
