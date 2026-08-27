# OpenCode OC1 adapter scope

Status: alignment in progress; implementation not started\
Decision dates: 2026-08-27 to 2026-08-28\
Runtime target: OpenCode CLI 1.18.23

This is the master implementation document for OC1. Where it conflicts with
`opencode-backend-scope.md`, this document controls. The feasibility report and
its evidence support the decisions here; they are not separate product plans.

## Decision

OpenCode gives Isomux one harness with broad model and provider support. OC1 is
the stable way to add it now.

Build the first OpenCode backend against OC1, the stable V1 stack. The gate
proved one shared server running parallel sessions, restart, resume, and event
ordering. Later startup testing proved that several OpenCode processes cannot
safely start against one profile at the same time. The gate also found contract
and security defects that the adapter must contain.

This is a bridge to stable V2, not throwaway work. Isomux's backend adapter,
supervisor, normalized events, persistence, UI, cron support, and tests survive
the move. One version-scoped transport module contains the OC1 HTTP and SSE
contract so V2 does not spread through the product.

## Product outcome

Users can choose OpenCode when they create an agent, use it through the normal
Isomux chat and controls, resume its conversations, run OpenCode cronjobs, and
configure supported models through the existing environment-file system.

OpenCode follows existing Isomux behavior unless its runtime forces a recorded
difference. In particular:

- spawning creates a dormant agent even when the backend is not configured;
- the first message starts the backend;
- an authentication failure is shown in that agent's chat with backend-specific
  instructions and a terminal-command card;
- authentication changes take effect through the existing new-conversation
  flow, subject to the OpenCode recovery gate below;
- office agents, rooms, and logs remain shared. A spawning user's optional
  environment file selects process environment; it is not a private-office or
  private-conversation boundary.

Fork and edit-message may ship disabled for OpenCode if OC1 cannot implement
them reliably. A stable V2 release during this work does not change the target:
finish the pinned OC1 backend, and migrate only after a separate V2 gate.

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

OpenCode uses shared servers, not one process per agent:

- one server handles all OpenCode agents using the office's default environment;
- when a spawning user has a custom environment file, one additional server
  handles all OpenCode agents using that environment;
- each server has its own OpenCode profile below Isomux `STATE_ROOT`, following
  the existing Codex state and backup convention;
- start a server on first use and stop it 10 minutes after its last client and
  active turn;
- a live cron run counts as a client for its whole run;
- a command that changes the selected environment or profile must replace the
  affected server before a new conversation uses it.

This grouping preserves Isomux's existing environment selection. It does not
make agents or conversations private to the spawning user.

All starts for one profile must be serialized. A permanent per-profile startup
lock covers first use and any later CLI migration. The server is usable only
after it reports healthy; another caller waits for that result instead of
starting a competing process.

The first-use startup requirement is measured, not speculative. On 2026-08-28,
the focused probe started several pinned OC1 processes at the same instant
against a fresh shared profile and the same working directory. A later CLI
migration can run the same non-serialized schema mechanism, but that case was
not measured separately.

| Processes | Trials | Trials with at least one failed start | Failed processes |
| ---: | ---: | ---: | ---: |
| 2 | 50 | 20 | 20 |
| 8 | 50 | 28 | 49 |

Failures reported a locked database, a collision while creating the
`workspace` table, or `ServeError`. The append-only records and reproducer are
`opencode-gate/evidence/shared-profile-startup.jsonl` and
`opencode-gate/harness/shared-profile-startup-probe.ts`. This rejects the exact
Codex process topology. It does not reject shared profiles after serialized
startup.

Measurements from 2026-08-27 show why. One idle server costs about 380 MiB.
The increase above idle was 94.1 MiB at one minimal mid-turn session, 96.9 MiB
at eight, and 201.5 MiB at 16. A second concurrent user therefore costs more
memory than adding eight sessions to an existing server. Servers are expensive;
sessions on one server are comparatively cheap. This favors lazy start, shared
servers, and idle shutdown. Cron runs can start servers even when no browser
user is active, so office sizing must use concurrent environment groups, not
signed-in browser users.

These values are floors from a deterministic mock with almost no token flow or
tool output. They are topology evidence, not production capacity limits. Live
certification must measure real provider streams and tool results.

## Authentication

Authentication follows the existing lazy backend flow. Isomux does not add a
setup screen or require login before an agent can be placed at a desk. On the
first message, an unconfigured OpenCode backend reports the failure in the
agent's chat and provides a terminal-command card.

The terminal command must call Isomux's pinned OC1 binary with the exact profile
and environment used by that agent's shared server. A bare global
`opencode auth login` command is incorrect because it can write credentials to
another OpenCode profile.

The manual API-key path was tested on 2026-08-28 with pinned OC1 1.18.23:

1. `opencode auth login --provider openai --method 'Manually enter API Key'`
   ran interactively through Isomux's real `pty-sidecar.cjs` terminal transport.
2. The prompt rendered, accepted masked input, and completed.
3. OpenCode wrote `auth.json` with mode `0600` below the selected
   `XDG_DATA_HOME`.
4. A separate `opencode auth list` process found the saved provider.
5. A newly started OpenCode server using the same profile reported `openai` as
   connected through its provider API.

This proves the terminal, persistence, and server-reload parts for manual API
keys. It does not yet prove browser OAuth. It also cannot prove that an Isomux
OpenCode agent recovers after `/clear`, because the adapter does not exist. The
first authentication slice must test the complete failure -> terminal card ->
login -> `/clear` -> successful message path before claiming it in user copy.

Provider environment variables remain supported through the existing office
and user environment-file merge. They do not use `auth.json`.

## Fork and edit-message

The gate proved only that the OC1 fork endpoint responds. Slice 1 must first
verify fork at the selected message, the child transcript, and the child's
first new message. If any of these fail, Isomux capability-gates edit-message
and fork off for OpenCode and ships OC1 without them.

## Cron requirements

The parallel cron backend seam owns its general shape. OpenCode requires it to
carry backend selection, the same environment/profile selection used by an
interactive agent, the composite provider/model ID, permission mode, lifecycle
controls, and normalized events.

An unattended OC1 session receives standing allow rules at creation, not
`once` answers. The gate showed that `once` does not persist: a later shell
request asks again. Disable the interactive question tool. If a permission or
question event still arrives, fail the run and record the reason instead of
parking it. A run resolves the same environment and profile without a browser
session and can resume only through that profile. It also keeps the server
alive for the whole run.

## V2 migration budget

When a stable V2 CLI/client pair ships, rerun the full gate before changing the
adapter. The known beta pair's prompt fails with `Missing key at ["prompt"]`,
its `/api/server` route serves HTML, and its fork and compaction routes disagree
with the client. Migration therefore stays inside the version-scoped transport
module.

Keep unchanged:

- shared-server supervision and environment/profile selection;
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

## Provisional implementation slices

This is the original layer-oriented cut. It is not yet approved as the slice
loop because its early items are not end-to-end demoable. Phase 1 must recut it
into small user-visible tracer slices and define the exact gates before Phase 2
or implementation starts.

1. **Contract proof and supervisor, 3-5 days.** Pin CLI 1.18.23, add the
   version-scoped fixture client and shared-server lifecycle, enforce every launch
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
   environment/profile routing, real-load memory, certified models, update/rollback,
   and every documentation surface listed in `documentation.md`.

Expected OC1 implementation: 4-6 engineer-weeks. Fork failure reduces the
shipped capability; contract drift or a security-boundary failure stops and
re-cuts the affected slice.

## Open questions

- Which safe structured-error fields, if any, should join the keep list?
- What memory ceiling is safe under real provider streams and large tool
  results?
- What exact subpaths and packaging layout hold the pinned binary and the
  profiles below `STATE_ROOT`?
- Which small provider/model set is certified first?
- Which provider login methods, beyond a manual API key, are certified in the
  first release?
- What are the exact always-run and paid live gates for each tracer slice?
- What wall-clock and repeated-failure conditions stop the implementation loop?
