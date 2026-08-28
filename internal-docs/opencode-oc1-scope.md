# OpenCode OC1 adapter scope

Status: OC1 implementation in progress\
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

Fork and edit-message are enabled from S4 after the selected boundary, child
history, first child turn, first-message boundary, and parent preservation all
passed against the pinned binary. A stable V2 release during this work does not
change the target: finish the pinned OC1 backend, and migrate only after a
separate V2 gate.

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

The server record also carries a revision of the generated OpenCode config.
The first S6-era acquire treats a pre-S6 record without that revision as stale,
drains active turns for the existing two-minute bound, and replaces the server.
An operator can therefore see each still-running OpenCode server restart once
after this upgrade. An unchanged config continues to adopt the same process.

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

This proves the terminal and persistence parts for manual API keys. It does not
prove browser OAuth. S2 also runs the complete failure -> terminal card -> login
-> `/clear` -> successful message path through the real pinned binary and a
local deterministic provider before it claims recovery in user copy.

Follow-up probes on 2026-08-28 found two different reload behaviors. A running
OC1 server added a newly authenticated provider to `provider.connected` on the
same PID, but its model registry did not reload. A prompt on that PID still
failed with the same selected-model-not-found error. Provider variables changed
in an environment file also cannot affect a process that already inherited the
old environment. Both routes require server replacement.

The same probes found that pinned `opencode auth login` against a profile with
a live server produced no prompt for more than 40 seconds. The cause was not
measured. Before it emits the card, Isomux stops new acquires, gives active turns
a two-minute drain, and stops the shared server. A drain timeout asks the user
to retry. Pending login state expires after ten minutes and is removed when a
supervisor starts, so an abandoned card cannot disable the shared environment.
The
mode-0700 wrapper runs the pinned login against the exact shared profile under
`flock`. It keeps a mode-0600 snapshot in a temporary sibling directory, checks
that the requested provider was written, atomically merges the result with the
other providers, and always removes the snapshot. Login and replacement affect
every agent that uses the shared environment. `/clear` starts the replacement
server with the authenticated profile.

Provider environment variables remain supported through the existing office
and user environment-file merge. They do not use `auth.json`.

## Fork and edit-message

The original gate proved only that the OC1 fork endpoint responds. S4 recorded
the selected boundary, child transcript, child's first new message, empty
first-message boundary, and unchanged parent after the child's write. Those
proofs enable both fork and edit-message for OpenCode.

## Cron requirements

The parallel cron backend seam owns its general shape. OpenCode requires it to
carry backend selection, the same environment/profile selection used by an
interactive agent, the composite provider/model ID, permission mode, lifecycle
controls, and normalized events.

An unattended OC1 session receives standing allow rules at creation, not
`once` answers. The gate showed that `once` does not persist: a later shell
request asks again. The named `isomux-cron` agent allows shell and edit tools,
and denies the question and task tools. Task delegation is disabled because a
delegated subagent can use its own permission rules; S6 does not claim standing
authority across that boundary. If a permission or question event still
arrives, fail the run and record the reason instead of parking it. A run
resolves the same environment and profile without a browser session and can
resume only through that profile. It also keeps the server alive for the whole
run.

OpenCode cron runs do not receive an Isomux run token. Their system prompt omits
the agent list, task board, inter-agent message, read-file, and diff affordances
that need that token. These self-affordances remain unavailable until Isomux can
grant per-session tool authority without putting a run token in the shared
server environment.

The fail-closed event handling applies to every cron backend, not only
OpenCode. If a Claude or Codex cron run unexpectedly requests permission or
interactive input, Isomux now denies when possible, aborts the turn, and fails
the run instead of leaving it parked until the 30-minute hard timeout.

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
- the login snapshot merge and private `data/opencode/auth.json` layout authored
  by Isomux under the pinned OC1 profile;
- fork, compaction, permission, prompt, completion, and abort behavior;
- live-model, memory, isolation, redaction, restart, and update checks.

Discard:

- the OC1 transport module and its 1.18.23 fixtures;
- OC1-only compatibility code and route names.

Budget 4-7 focused days after a stable V2 pair exists: 1-2 days to rerun and
review the gate, 2-3 days to replace the transport and fixtures, and 1-2 days
for regression and live certification. A failed V2 gate pauses migration; it
does not invalidate the OC1 product work.

## Approved tracer slices

Each slice keeps one complete user path working. The branch stays in its
worktree until the backend works; partial slices do not merge to main or reach
the running office.

1. **S1a - first reply through a deterministic transport.** Add the OpenCode
   discriminator, spawn choice, dormant agent, minimal adapter events,
   persistence, and one reply in normal chat. Move automatic stored-session
   inspection behind the backend contract, closing task `00cae917`. Missing
   authentication is plain text with no runnable command. Fork, edit, tools,
   one-shot prompts, and topic generation stay capability-disabled.
2. **S1b - the same reply through pinned OC1.** Replace only the deterministic
   transport with CLI 1.18.23, the shared supervisor, serialized startup,
   profile under `STATE_ROOT`, all launch controls, loopback authentication,
   raw-ingress redaction, and the ten-minute idle shutdown. The timeout is a
   named constant with a test-only injected duration.

S1b packages `opencode-ai` 1.18.23 as the root dependency alias
`opencode-v1`. The supervisor resolves the installed platform package's native
binary directly (`opencode-linux-<arch>/bin/opencode`); it does not use PATH,
the postinstall wrapper, or V2. Release/update preservation for this installed
dependency and its profile remains an S7 proof.
3. **S2 - authentication recovery.** Prove missing login -> exact
   profile-scoped terminal card -> manual API-key login -> `/clear` -> a
   successful reply. Browser OAuth remains uncertified until tested.
4. **S3 - controlled work.** Add streaming text and reasoning, shell and edit
   tools, allow-once and deny replies, failed-tool recovery, abort, and exact
   completion ordering.

S3 keeps OpenCode in Ask mode. `validatePermissionMode` accepts only `default`
for OpenCode, so no other posture is representable before the model/UI slice.
Each permission request offers only Allow once and Deny; no persistent rule is
shown or accepted. The retained `patterns` field supplies the reviewed command
patterns displayed with the request. The shared server config asks for shell
and edit, and denies the interactive question tool. A 2026-08-28 pinned probe
confirmed that question denial emits no permission request and settles as an
invalid-tool result.

Completed turns require `session.idle` after a recorded `step-finish`. A local
abort may idle without `step-finish` and is interrupted, not completed. Abort
rejects a pending permission before it calls the session abort route. Any
non-terminal tool at abort receives one synthesized interrupted result; the
2026-08-28 pinned running-shell probe emitted its own terminal result before
idle, so the synthesis is a future-shape guard. This rule assumes Isomux is the
only actor for the session. A remote abort is not reachable in S3 and would be
reported as a failed unexplained idle.

A dropped SSE stream fails the active turn. S3 does not reconnect or replay an
in-flight turn. Failed-tool recovery means that OpenCode reports the tool result
to the model and the same server turn continues to final reasoning and text; it
does not mean transport recovery.
5. **S4 - durable conversations.** Prove process loss, isolated Isomux
   restart/resume, simultaneous repositories without crossover, and server
   replacement after environment/profile change. Prove fork at the selected
   message plus child history and first child turn, or keep fork and edit off.
   S5 pins that OpenCode remains observe-only in the busy-turn watchdog; S3 and
   S4 did not change that existing behavior.

S4's 2026-08-28 pinned probes found that `messageID` is an exclusion boundary.
Forking at the second user message retained the complete first turn, removed
the selected and later turns, and left the parent unchanged after both the
fork and the child's first prompt. Forking at the first user message produced
an empty linked child. The child's first reply recalled a canary available only
in its retained parent context. Fork and edit can therefore ship for OC1.

Fork parents are retained in OpenCode's profile. This matches Isomux's existing
branch history and Codex rollout retention, makes `/resume` honest, and means
profile and backup size can grow with edits. S4 does not add automatic parent
deletion.

An OC1 session is fixed to its birth directory. A repo-B client request against
a repo-A session still ran its tool in repo A, so a cwd edit starts a fresh
session for OpenCode as it does for Codex. The profile and other durable
sessions stay in place.

The SSE subscription is per turn. Replacement drains all active turns, so no
idle persistent subscription can be stranded on the old endpoint. Retained
leases read the supervisor's current authenticated endpoint before their next
turn. Agent-manager enforces one live backend session per agent; edit closes
the parent handle before it installs and sends through the child, and resume
replaces the old handle. A fork parent and child have distinct session ids. A
cron run can share the profile in S6 but must never receive an interactive
agent's session id. The server-record revision design assumes one Isomux
process owns one `STATE_ROOT`; two Isomux processes with different views of the
same env files are unsupported.

Fork and message inspection use the same lazy binding constructor. A binding
holds cwd, supervisor, and the stored session model, so fork safety does not
depend on the edit path reading messages first.

Environment-file contents have a separate revision from profile identity. The
revision hashes configured office and user env-file values only, never ambient
process values, and is stored only in the mode-0600 server record. A changed
revision replaces the active server in the same paths-only profile after the
two-minute bounded drain. Durable session ids remain valid.
6. **S5 - model and UI completion.** Add provider/model discovery, at most
   three first-release certified models, capability-shaped controls, and every
   killed/resumed-agent surface.

S5 reads the pinned server's `/provider` route through the same shared
environment profile as an agent turn. It accepts only providers in the
server's `connected` set and flattens their models to `provider/model`. The
browser receives only that composite id and a bounded provider/model label.
Provider options, environment names, costs, limits, and unknown catalog fields
are dropped at ingress. Credential-shaped or invalid labels fall back to the
validated id.

Opening spawn or edit on OpenCode can start the shared server for discovery.
Discovery runs once when the selected engine becomes OpenCode, not on renders
or cwd edits. Cancelling the dialog leaves that server under the existing
ten-minute idle shutdown. This can retain the measured approximately 380 MiB
idle server for that bound; S5 does not add a second idle timeout. Discovery
against an already-live session must keep the same pid and cannot request a
drain or replacement.

One agent-manager helper authors the OpenCode launch environment for both
discovery and sessions. It resolves the configured office and user env files
from the same user id used for the environment key and revision. The
`start-server.ts` spawn builder then removes inherited `OPENCODE_*`,
`ISOMUX_OPENCODE_DEBUG`, and the per-agent `ISOMUX_AGENT_TOKEN` before exec.
Discovery and session launch environments were already equal after that token
filter on the pre-S5 tree; the new helper and its source-structure pin are the
control that prevents two authors from drifting later.

The selected composite id is the runtime model. It is stored in each session
binding, emitted in `system_init`, and split into the prompt's `providerID` and
`modelID`; the backend singleton has no production model constant. A stored
model is never silently replaced during resume. A disconnected provider can
produce the reviewed authentication recovery. A connected provider with a
retired model id remains a generic model failure, not an authentication
failure, and settings shows the stored id as unavailable until the user picks
a connected model.

`opencode/fake` remains only in the deterministic tracer. New production
agents require an explicit discovered model. A legacy tracer record remains
truthful in history, killed-agent, and revive projections, but production
session creation gives one settings repair error and does not start, kill the
agent, or spend watchdog recovery budget. The OpenCode `/model` command points
to agent settings because its connected list is environment-specific.

OpenCode keeps Ask-only permission mode and exposes no effort, sandbox, or
one-shot controls. Slide Mode therefore returns no job instead of calling the
unavailable OpenCode one-shot path with Codex's formatter model. Fresh offices
still seed only the existing Claude and Codex welcome agents; S5 does not add a
third welcome agent.

The shared cron definition and run types already preserve OpenCode plus a
composite model id, and S5 pins that serialization. S6 owns executable OpenCode
cron sessions, unattended permissions, explicit model selection, and all
three environment-key creation sites. It cannot rely on a model fallback.

The real-provider gate ran on 2026-08-28 with three explicit connected free
models. `opencode/hy3-free` and `opencode/mimo-v2.5-free` completed, returned
the canary, and matched the requested model in the adapter's outgoing
`prompt_async` body. `opencode/nemotron-3.5-lightning-free` timed out after the
fixed 120-second wait and is not certified. The gate recorded no provider
response content. The safe result is in
`opencode-gate/evidence/oc1-real-certification-2026-08-28.json`.

The opt-in harness accepts at most three explicit connected models, records
billed tokens, and fails after a response exceeds 200,000 input-plus-output
tokens per model. This is not a pre-spend cap. Its pre-spend bound is one short
prompt with a 120-second response wait per model and a stated $2 per-model
intent. The deterministic local gate provider still proves only the pinned
binary contract and is not a certified real provider.
7. **S6 - unattended run.** Run an OpenCode cronjob with standing allow rules.
   An unexpected permission or question fails visibly instead of parking.

The 2026-08-28 pinned probe used one shared server process for all cases. The
default agent asked for shell permission, `isomux-cron` completed the same shell
tool without a permission event, a denied question returned an ordinary failed
tool result and the model recovered, and an unknown agent failed without
falling back to the default agent. This makes the config revision a correctness
boundary, not only an update optimization. Raw results are in
`opencode-gate/evidence/s6-permission-probe-results.json`.
8. **S7 - release hardening.** Measure real-stream memory, prove update and
   rollback with the pinned binary/profile, scan for secrets, run final
   regression, and update every surface in `documentation.md`.

S7 pins the packaged runtime at three levels: the root alias, the platform
package selected by the resolver, and every Linux package in `bun.lock` all
name version `1.18.23` and the locked packages carry integrity values. A fresh
frozen install completed in a 2 GiB scratch scope on 2026-08-28 and the
resolved Linux binary reported `1.18.23`. The dated result is in
`opencode-gate/evidence/s7-release-hardening-results.json`.

Daily backup archives and updater snapshots contain the managed OpenCode
profile, including provider login state. New partial archives, published
archives, and updater snapshots are mode `0600`. The partial is reserved at
that mode before `tar` opens it, so there is no more-readable window during a
large write. The matching backup verification sidecar was already mode `0600`;
the archive was the missing restrictive path. No off-box backup copier exists
in this repository as of 2026-08-28. Existing archives are not changed by the
code update. Operators should run `chmod 600 ~/isomux-backups/isomux-*.tar.gz`
and can run `chmod 700 ~/isomux-backups` to tighten the directory.

The automatic committed-artifact credential scan receives its synthetic
positive control directly, then scans the OC1 fixtures, the S6 evidence, the
generated login sources, and the server-record sources without an exclusion
list. The runtime-artifact scanner remains opt-in because normalized streams,
agent JSONL, cron JSONL, and browser payloads exist only after a run. A green
automatic scan does not claim that opt-in gate ran.

The real-stream memory gate ran on 2026-08-28 with
`opencode/mimo-v2.5-free`. Each independent level used a fresh server and
scope. For the active levels, every real model turn had a Bash tool running a
`sleep` process before and after the sample. The N=16 calibration measured a
5.084-second first-to-last tool spread. The measured N=16 run widened to 6.992
seconds. The derived holds were 45.3 and 51.0 seconds respectively, so the
60-second floor, not the calibration estimate, kept both barriers safe.

| Active turns | Core anon + kernel | Charged `memory.current` | Scope `memory.peak` | Summed PSS (descriptive) |
|---:|---:|---:|---:|---:|
| 0 | 458.9 MiB | 477.7 MiB | 561.7 MiB | 484.0 MiB |
| 1 | 505.2 MiB | 540.0 MiB | 571.3 MiB | 563.9 MiB |
| 8 | 603.0 MiB | 651.1 MiB | 679.1 MiB | 640.3 MiB |
| 16 | 526.2 MiB | 569.9 MiB | 650.5 MiB | 564.2 MiB |

The table shows one run per level; the N=0 and N=16 repeat ranges follow.

At the barrier, generation had finished and every active session was parked in
a Bash `sleep`. Core, `memory.current`, and PSS therefore describe parked
sessions. Only `memory.peak` covers the generation phase as well.

All four samples had stable cgroup PID sets, zero swap, and no `high`, `max`,
OOM, `pgscan`, or `pgsteal` movement. Two added fresh repeats at N=0 measured
core ranges of 448.3-513.3 MiB; two valid added N=16 repeats produced a combined
526.2-632.2 MiB range across the three valid N=16 runs. Three valid fresh runs
at each of N=0 and N=16 separate completely: every N=16 run exceeded every N=0
run on core, on `memory.current`, and on `memory.peak`, with gaps of 12.9, 33.6,
and 16.1 MiB. The runs interleaved in time rather than being blocked by level,
and host MemAvailable held within 19.9-20.0 GiB at loadavg 1.36-2.72, so drift
does not explain the separation. The direction is therefore established: 16
concurrent sessions cost more than an idle server. The magnitude is not. The
N=0 to N=16 core difference averages 92.0 MiB while the fixed-level ranges are
65.0 MiB at N=0 and 106.0 MiB at N=16, so the uncertainty is comparable to the
effect and no per-session figure or production ceiling follows. Ordering among
the active levels is likewise unresolved: the single N=8 core reading of 603.0
MiB falls inside the N=16 range. With three runs per level, complete separation
is the strongest available result and carries an exact one-sided probability
of 1/20 under exchangeability.

One additional N=16 attempt aborted before its barrier on a provider connection
error; it is retained as evidence and excluded from the ranges.

`memory.current` is the charged total, while the table leads with anon plus
kernel because file cache is reclaimable. The full cgroup counters, host
pressure, process PSS/RSS tables, barrier timestamps, calibration, repeats, and
aborted attempt are in the dated
`opencode-gate/evidence/oc1-real-memory-*` files. The earlier 2026-08-27
deterministic-provider figures remain topology evidence only.

The architecture image has no editable source in this repository. S7 does not
replace the binary image or keep using its two-backend caption as a current
architecture claim. A new source asset remains a documentation blocker.

## Slice gates and rails

Every slice runs focused tests, its deterministic end-to-end path, ESLint on
touched files, and `build:ui` when UI changes. A slice that changes a backend
union or switch also runs `tsc --noEmit`. S1b and later compare HTTP and SSE
shape from the real pinned binary against the recorded contract through the
local deterministic provider. S1b also has a repository scan that refuses any
binary launch outside the supervisor spawn builder.

Every process started from this worktree sets `ISOMUX_HOME` to a scratch path
under `/tmp` before importing a server module. Tests and demos record that path
and prove the live `~/.isomux/agents.json` did not change. Live provider checks
use scratch repositories only. Restart tests use a separate process, port, and
state root; they never restart the live office or repoint `~/isomux-active`.

OpenCode-spawning tests run in a memory-limited user scope and reap every child.
The limit is named per test: two competing startup attempts fit under 2 GiB;
larger concurrency probes use 4 GiB or another measured bound rather than
turning a cgroup kill into a false startup-lock failure.

The profile's `server.lock` is both the cross-process `flock` target and its
0600 pid/port/auth record. Every start takes that file lock, probes the record,
adopts a healthy pinned server, and replaces a stale or unhealthy process.
This applies after an Isomux SIGKILL and across test processes, not only inside
one supervisor object. An ordinary Isomux SIGINT or SIGTERM reaps the shared
server before the signal is re-raised. The reserved retry range is
22000-22999, directly above Isomux app allocation at 21000-21999 and below the
Linux ephemeral range; an occupied port is retried.
Two concurrent starts are proved by a `/proc` count of the exact pinned binary,
not by the supervisor registry.

The environment identity hashes only the normalized configured office and user
environment-file paths. It does not hash file contents or inherited process
values. Thus, systemd values such as `INVOCATION_ID` cannot move the profile
after an Isomux restart, and a credential rotation can replace the server
without stranding durable sessions in a new profile. Paths, values, and
credentials do not enter profile directory names.
`ISOMUX_AGENT_TOKEN` is excluded from the shared server environment: it is a
per-agent capability and cannot be inherited by a server shared across agents.
The child first removes every inherited `OPENCODE_*` variable and then applies
only the reviewed launch controls. S1b has tools disabled; S3 must add
per-session tool authority at a narrower boundary.

The idle timer starts only when both the lease count and active-turn count are
zero. The injected short-timeout tests prove both edges: an idle server is
reaped, and a turn that exceeds the timeout remains alive and completes.

Live scripts refuse to run without `ISOMUX_TEST_LIVE=1`. The stated budget is
$2 or 200,000 billed input-plus-output tokens for an ordinary slice, and $2 per
model for at most three certification models. The certification script records
tokens and fails after a response exceeds the limit; it cannot prevent that
spend. Its actual pre-spend bound is one short prompt with a 120-second response
wait per model. The dollar figure is intent because providers do not report
billed cost during the run. When no credential exists, a slice can commit in
the worktree after cheap gates, but its acceptance says the real-provider
tracer is unproved and parks the exact live command for Nil.

Stop immediately for a launch-control bypass, provider data reaching logs or
the browser, competing processes for one profile, cross-session event/file
mixing, a server reaped during an active turn, or real-binary contract drift.
Re-cut a slice after two failed focused
repairs of one invariant, one focused day without its tracer, or three focused
days in that slice. There is no separate whole-project deadline.

Expected OC1 implementation: 4-6 engineer-weeks. Fork failure reduces the
shipped capability; a failed security or isolation rail blocks release.

S1a intentionally treats an environment-file read failure during silent
automatic recovery as indeterminate and lets strict resume rebuild the
environment and surface the backend's more precise error. The Codex directory
scan-cap sentinel follows the same assume-durable rule; that impractical cap
branch is knowingly not covered by a focused test.

Residual two-backend assumptions recorded 2026-08-28:

- S5 pins OpenCode's existing observe-only busy-turn watchdog behavior at
  `agent-manager.ts:4251`; this is a regression pin, not a behavior change.
- S4 owns cwd-change classification at `agent-manager.ts:827`.
- S5 closes slide model selection at `agent-manager.ts:2466`, welcome-agent
  naming at `isomux-office.ts:480-484`, LogView engine display at
  `ui/log-view/LogView.tsx:1914`, and template handling at
  `ui/agent-templates.ts:384,415`.
- S6 owns cron permission defaults and UI at `agent-validators.ts:185`,
  `cronjob-manager.ts:352,430`, and `ui/components/CronjobDialog.tsx`.
  S6 passes the stable environment-source key at all three cron session
  creation paths. The OpenCode adapter rejects a missing key, so cron cannot
  silently join the default profile.

The S1b drift fixture covers only the real OC1 shapes emitted by the local
deterministic provider for session creation, prompt admission, assistant text,
and idle completion. It does not cover reasoning, tools, permissions, abort,
or provider error bodies; S3 adds those shapes. The fixture recorder refuses a
credential-shaped value before writing, and the final canary scan covers the
fixtures, normalized stream, and agent JSONL.

S1b replaces every real `session.error` body with one fixed safe message. The
adapter cannot classify a real authentication failure from that message. S2
must add and review the safe error keep list (`name`, `message`, `statusCode`,
and `isRetryable`) before it enables the terminal login card. The credential
boundary does not promise that retained free-form messages contain no internal
stack or implementation detail; `SafeOpenCodeError` means credential-safe, not
internal-detail-free. The S6 unknown-agent probe observed such a stack trace.
The credential canary must stay green for the normalized stream and agent
JSONL.

S2 pulls one narrow provider-discovery check forward from S5. When OC1 reports
the observed no-credential `UnknownError` / selected-model-not-found shape, the
transport queries the server's sanitized `connected` provider IDs on that error
path only. A disconnected selected provider is authentication failure; a
connected provider with a missing model is not. This prevents the current
`opencode/fake` tracer model, deprecated models, and mistyped models from
producing false login cards. Recorded 401 and 403 API errors remain structured
authentication failures. Free-form error messages are used for classification
but are never persisted.

OpenCode startup output is not persisted below `STATE_ROOT`. A startup stops
after one non-bind error. For one diagnostic run, an operator can set
`ISOMUX_OPENCODE_DEBUG=1`; this keeps private startup output in a mode-0600
directory below `/tmp`. The operator must treat that output as secret-bearing
and remove it after diagnosis.

## Open questions

- What memory ceiling is safe under real provider streams and large tool
  results?
- What exact subpaths and packaging layout hold the pinned binary and the
  profiles below `STATE_ROOT`?
- Which provider login methods, beyond a manual API key, are certified in the
  first release?
