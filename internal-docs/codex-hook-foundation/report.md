# Codex hook foundation and coverage matrix

- Measurement date: 2026-08-28
- Pinned Codex version: `@openai/codex` 0.144.6
- App Server settings: `approvalPolicy: "never"`, `sandbox: "danger-full-access"`
- Model: `gpt-5.6-sol`

This document records Slice 1 evidence only. It does not install a hook for an
Isomux agent. It does not extract the safety policy, change the Claude adapter,
or add enforcement.

## Result

Codex `PreToolUse` blocks every measured model action before its side effect.
This includes Bash, `apply_patch`, dynamic tools, and MCP tools. The same result
holds after resume and fork, and in Isomux's one-shot session settings.

Codex fails open when the hook cannot give a valid decision. A missing command,
a nonzero exit, malformed output, and the configured hook timeout all let the
tool action run. This is the main runtime limit. A session-start check cannot
fix a failure that happens during a later tool call.

The allow control is part of the finding. In a model-driven turn, an absent
side effect can mean either that the hook blocked the action or that the model
never proposed it. A deny cell has evidence only when its paired allow cell
shows the action and side effect. All final cells met that denominator.

## Run method and denominator

The checked-in live test uses the bundled binary. It copies only `auth.json`
from `/home/nil/.isomux/codex-home` to each scratch home. All hook files,
workspaces, config files, MCP files, rollouts, and markers are under `/tmp`.
The test did not write to the source auth home.

The final matrix ran each cell two consecutive times. It made 62 readings and
four mid-session reload readings in 1,147.39 seconds. All 62 requested actions
emitted. The validation error list was empty. For each action cell, the test
ran these controls:

1. Allow: the action emitted and the side effect was present.
2. Deny: the action emitted and the side effect was absent.
3. Untrusted: the action emitted, no hook ran, and the side effect was present.

The raw result records each wall time and the full hook payload. It is 3,229
lines, so it is kept out of the repository at
`~/nil/scoping-reports/codex-hook-foundation/live-matrix.json`. Re-generate it
by running the probe; the counts above are what it supports.

## Action coverage

| Action | Actual `tool_name` | Input keys | Allow | Deny | Untrusted |
| --- | --- | --- | --- | --- | --- |
| Shell | `Bash` | `command` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |
| Patch/file change | `apply_patch` | `command` (the patch text) | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |
| Dynamic App Server tool | `write_probe_marker` | `value` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |
| MCP tool | `mcp__isomux_probe__write_marker` | `value` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |

The file-change action emitted App Server `fileChange` items. The dynamic tool
emitted `dynamicToolCall` items. The MCP tool emitted `mcpToolCall` items. The
deny cells did not reach their marker handlers.

The App Server also has client RPC methods such as `fs/writeFile`. They are not
model tool actions, and Isomux does not expose them to the model. This probe
does not claim that `PreToolUse` gates an App Server client that calls those
RPC methods directly.

## Session coverage

| Session path | Allow | Deny | Untrusted | Basis |
| --- | --- | --- | --- | --- |
| Fresh `thread/start` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects | Live |
| `thread/resume` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects | Live, after a persisted setup turn |
| `thread/fork` | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects | Live, after a persisted setup turn |
| Isomux one-shot | 2/2 sentinel outputs | 2/2 blocked, 0/2 outputs | 2/2 sentinel outputs | Live with `ephemeral: true`, `read-only`, and `never` |
| Cron | Not run | Not run | Not run | Inferred from the shared spawn path |
| Model list | No tool action | No tool action | No tool action | Inferred from the shared spawn path |

Cron is an explicit inference, not a measurement. `JsonRpcLiteClient.start()`
in `server/backends/codex/client.ts` is the only runtime Codex process spawn.
It applies `withIsomuxCodexHome(this.opts.env)` at that one spawn. The adapter
creates clients for regular sessions, model list, fork, read, and one-shot, but
they all enter that method. `resolveCodexLauncherPath()` is called at the spawn
and in `native-bin.ts` for the human login wrapper. No agent path bypasses the
client spawn. Thus, cron inherits the effective `CODEX_HOME` by construction.
The probe still measures resume, fork, and one-shot directly because they can
run in scratch state.

## Default and per-user homes

The default-home cells used a `/tmp` replica with the shape
`<scratch>/.isomux/codex-home`. The per-user cells used
`<scratch>/users/probe-user/codex-home` as an explicit `CODEX_HOME`. Both paths
gave the same result:

| Home | Allow | Deny | Untrusted |
| --- | --- | --- | --- |
| Default replica | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |
| Per-user override | 2/2 effects | 2/2 blocked, 0/2 effects | 2/2 effects |

Codex skipped an untrusted hook without a hook event or an error in both
layouts. A future installer must verify each effective home before it starts a
session. Nil has not yet ruled that Isomux may install a mandatory hook in each
effective home, so this is a deployment requirement, not an implemented action.

## Managed hooks

The managed behavior was measured in a bubblewrap root. The probe mounted a
scratch directory at `/etc/codex`, put an inline managed `PreToolUse` hook in
`requirements.toml`, set `allow_managed_hooks_only = true`, and left a user
deny hook in the scratch `CODEX_HOME` as a control.

`hooks/list` reported `source: "system"`, `isManaged: true`, and
`trustStatus: "managed"`. The user hook ran zero times. The managed allow hook
gave 2/2 side effects. The managed deny hook blocked 2/2 actions with no side
effects. Thus, the pinned binary gives the managed hook equivalent blocking and
does not need a user trust hash.

The managed path is not installable by the current user service. On 2026-08-28,
the service user had uid 1001, `/etc/codex` was absent, and `/etc` was not
writable. A root-owned deployment step would have to create the requirements
file and the protected executable. The live probe proves managed semantics in
an isolated root. It does not prove that the current Isomux service can install
them.

Recommendation: managed hooks are the better tamper design when a deployment
can provision the system layer. They are not a complete answer for existing
user-only installs. Do not select user trust as hostile-agent resistance. It is
only an honest-agent layer unless the config and executable are protected.
Nil's mandatory-install and enforcement-claim rulings remain open.

## Trust reload and tamper behavior

Each reload case ran twice:

- A changed trust hash did not disable the hook in the running thread. The
  thread used its cached hook definition.
- A changed `hooks.json` did not replace the hook in the running thread. A
  later `hooks/list` call saw the new entry as `modified`, but the next tool
  call had already run the cached command.
- A changed executable at the same command path took effect on the next tool
  call. The trusted hash did not change, and the changed script denied the call.

This confirms the earlier tamper finding. Trust covers the config entry, not
the executable contents. Config removal takes effect on a new App Server
session. Executable replacement takes effect during the current session. The
executable must be outside agent-writable storage.

## Failure behavior

Each failure cell ran twice. Every requested Bash action emitted.

| Failure | App Server result | Side effect | Decision |
| --- | --- | --- | --- |
| Missing executable | `failed`; broken pipe or exit 127 | 2/2 present | Fail open |
| Exit 17 | `failed`; exit 17 | 2/2 present | Fail open |
| Malformed stdout | `completed`; no error entry | 2/2 present | Fail open |
| Configured 1 s timeout | `failed`; timeout after 1 s | 2/2 present | Fail open |
| Hook-owned 50 ms deadline returning deny | `blocked` | 0/2 present | Fail closed for this case |

The API did not expose the internal result-kind names found in binary strings.
The table uses only the measured `hook/completed` status and entry text.

A future hook needs a small supervisor that starts the policy evaluator,
checks its output, and returns deny for evaluator launch failure, nonzero exit,
malformed output, or its own deadline. The Codex timeout is only an outer
backstop because Codex fails open when that timeout fires. If the supervisor
itself cannot start or hangs past the outer timeout, Codex still fails open.
Startup verification and a protected executable reduce this risk but do not
turn the hook into an OS security boundary.

## Latency and timeout

The process-load probe ran 200 invocations at concurrency 8 for each runtime
shape on `auntie`, inside a 2 GB systemd scope, with six other agents in
flight. The floor fixture reads stdin and returns allow. The representative
fixture starts Bun, imports a synthetic 63,551-byte module, and constructs 256
regular expressions. It matches the source weight of the current policy file
without importing or running the semantic guards.

| Fixture | n | Concurrency | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Minimal floor | 200 | 8 | 100 ms | 187 ms | 213 ms | 238 ms |
| Representative hook runtime | 200 | 8 | 252 ms | 490 ms | 602 ms | 649 ms |

Reviewer 3 then ran the same frozen probe twice on `auntie`, also with six
other agents in flight. These are separate dated measurements, recorded in
`evidence/latency-reviewer-reproduction.json`.

| Scope | Fixture | p50 | p95 | p99 | Max |
| --- | --- | ---: | ---: | ---: | ---: |
| 2 GB | Minimal floor | 124 ms | 535 ms | 928 ms | 958 ms |
| 2 GB | Representative | 296 ms | 789 ms | 993 ms | 1,097 ms |
| Uncapped | Minimal floor | 81 ms | 235 ms | 337 ms | 384 ms |
| Uncapped | Representative | 308 ms | 666 ms | 819 ms | 877 ms |

The final App Server matrix also recorded 36 successful allow/deny hook calls:
p50 23 ms, p95 75 ms, p99 80 ms, max 80 ms. Those shell fixtures are the floor
inside Codex. They do not import the policy runtime.

For a ten-tool turn, the three representative runs span about 2.52 to 3.08
seconds at p50, 4.90 to 7.89 seconds at p95, 6.02 to 9.93 seconds at p99, and
6.49 to 10.97 seconds at the measured maximum. The calls are sequential in a
normal turn, so per-call process startup is the main cost.

The evidence does not support a fixed timeout pair yet. A 750 ms internal
deadline is below the reproduced p95 under the 2 GB scope and below the
uncapped p99, so it would deny legitimate actions under ordinary office load.
A 1 second Codex timeout is below the reproduced 1,097 ms maximum, and Codex
fails open when that timeout fires. Load variance can therefore cause both
spurious deny and silent bypass with the proposed pair. Do not ship either
value from this slice. A later decision needs a stable runtime design and a
load test whose tail stays below the internal and outer deadlines with stated
headroom.

The live matrix and latency data are separate measurements. The matrix result
was written at `2026-08-28T22:09:51.770Z`. The regenerated latency result was
written at `2026-08-28T22:22:31.990Z`. Both name Codex 0.144.6. A dependency,
runtime, or load-condition change must rerun the relevant probe.
