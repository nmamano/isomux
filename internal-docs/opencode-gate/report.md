# OpenCode backend feasibility gate

Date: 2026-08-27  
Task: `6a43cd2f`, first deliverable only  
Recommendation: **NO-GO for the production adapter**

The proposed per-user server topology works with the V1 runtime, but neither
tested typed client is safe to build on. The V2 beta client cannot send a prompt
to the pinned V2 beta CLI. The same-version V1 SDK does not match the V1 server's
permission event or reply route. OpenCode also exposes arbitrary provider
response headers in structured errors. Adapter work must wait for a stable V2
CLI/client pair and must include an Isomux redaction boundary.

## Tested versions and host

- V2 CLI: `0.0.0-beta-202608110357`
- V2 client: `0.0.0-beta-18314`
- V1 CLI and SDK: `1.18.23`
- Host: `auntie-2`, Linux `6.8.0-136-generic`
- Every launch used `OPENCODE_DISABLE_AUTOUPDATE=1`. Every gate config set
  `autoupdate=false`.

The frozen-lockfile install is the before-run pin. The local pins are in
`package.json` and `bun.lock` in this directory. `evidence/versions-after.json`
confirms the same versions after the full run, so no silent update occurred.
`evidence/root-manifest-hashes.txt` confirms that the repository root
`package.json` and `bun.lock` did not change.

## Gate verdicts

| # | Gate check | V2 beta | V1 stable | Evidence and reason |
|---|---|---|---|---|
| 1 | Authenticated loopback server under an isolated profile | **PASS** | **PASS** | Both health probes report the pinned version after launch with Basic authentication. Profiles use isolated HOME and XDG roots. See `evidence/v2-results.json`, `evidence/v1-results.json`, and `harness/common.ts`. |
| 2 | Parallel sessions in different repositories without crossover | **BLOCKED - upstream-not-implemented** | **PASS** | V2 creates distinct session IDs and locations, but its typed prompt fails before either turn, so content and event isolation cannot be proved. V1 ran simultaneous turns. Each transcript contains only its own canary; event streams stay separate; only repo A contains `gate-output.txt`; permission IDs stay in the correct stream. See `evidence/v2-results.json`, `evidence/v1-results.json`, and `evidence/v1-events-{a,b}.jsonl`. Separate discovery profiles also keep connected-provider state separate in `evidence/provider-discovery-results.json`. |
| 3 | Restart and resume both sessions with prior context | **BLOCKED - upstream-not-implemented** | **PASS** | V2 restores both empty session IDs and their exact directories, but cannot create prior model context because prompt admission fails. V1 stops the server, starts it with the same profile, restores both IDs, directories, messages, tool states, and canaries. See both result JSON files. |
| 4 | Required structured fixtures | **BLOCKED - upstream-not-implemented** | **PASS with fork limit** | V2 prompt fails with `InvalidRequestError: Missing key at ["prompt"]`; fork returns `UnsupportedContentType`; compaction returns `UnexpectedStatus`. V1 fixtures cover text, reasoning, permission allow and deny, a file edit and patch, failed tool plus recovery, abort, compaction, authentication error, and a fork endpoint response. Fork at a target message and the child context are unverified. See `evidence/v1-events-{a,b}.jsonl`, `evidence/auth-error-events.jsonl`, and `evidence/v1-results.json`. |
| 5 | `callID` pairing and one terminal tool event | **BLOCKED - upstream-not-implemented** | **PASS for stability; uniqueness unproven** | V2 has no usable typed model turn. Every V1 tool part keeps one `callID` from pending through terminal state, and each part has exactly one `completed` or `error` event. The mock uses the same `call_gate_001` across sessions, so `callID` uniqueness is not proved and it is unsafe as a global key. Key tool state by `(sessionID, partID)` and retain `callID` only as the pairing field. See `evidence/v1-event-analysis.json`. |
| 6 | Exact turn completion ordering | **BLOCKED - upstream-not-implemented** | **PASS with abort note** | The five completed V1 turns each emit one `session.idle` only after the final `step-finish`, which follows final text and tool results. Abort also emits `session.idle`, but it has no `step-finish`; an adapter must classify it as abort completion, not ordinary turn completion. See `evidence/v1-event-analysis.json`. |
| 7 | `--pure` blocks project plugin, MCP, and compatibility execution | **FAIL** | **FAIL** | In both CLIs, a no-`--pure` positive control executes the project plugin, while `--pure` blocks it. However, `--pure` still loads project MCP config, executes its command, and loads a `.claude` compatibility skill. The enforceable combination `--pure`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and `OPENCODE_DISABLE_CLAUDE_CODE=1` blocks all three. This is not the security stop condition because an enforceable opt-out exists, but the proposed launch contract must require all three controls. See `evidence/security-results-v2.json` and `evidence/security-results-v1.json`. |
| 8 | Dated idle and 1/8/16 active-session RSS | **BLOCKED - upstream-not-implemented** | **PASS** | V2 cannot start typed active turns. V1 measurements use accepted `prompt_async` calls, confirm every sampled session is `busy`, and hold all responses open. See the RSS table and `evidence/rss-v1-{1,8,16}.json`. The 8 and 16 runs used `MemoryMax=4G`; `oom_kill` stayed 0. These are floor values from a deterministic mock with minimal token flow and no tool output. |
| 9 | Credential, password, error, SSE, and log redaction | **FAIL** | **FAIL** | Provider API keys and server passwords do not appear in the captured artifacts: stdout, stderr, URLs, argv, or fixtures. The server password exists only in the required child environment. However, a sentinel response header appears unchanged in both the structured `session.error` SSE event and SDK result. See `evidence/secret-scan-results.json`, `evidence/process-secret-results.json`, and `evidence/auth-error-results.json`. The positive-control scan finds its planted sentinel. The scan does not cover scratch profile databases, snapshots, or auth state under `/tmp`. Isomux production logs are **BLOCKED - adapter-not-started** because this deliverable does not install an Isomux adapter. |
| 10 | Release/update preservation | **BLOCKED - adapter-not-started** | **BLOCKED - adapter-not-started** | The existing updater's full-state snapshot and rollback suite passes 21/21 in `evidence/update-sh.test.log`. That proves an OpenCode profile placed under Isomux `STATE_ROOT` would be backed up and restored. It cannot prove the final pinned binary location, install step, or profile layout because those do not exist until the runtime slice is approved. This line remains blocked, not passed. |

## RSS results

Measured 2026-08-27 on `auntie-2`. RSS is the OpenCode server process tree;
the local mock server is excluded. “Active” means `prompt_async` returned,
the session status was `busy`, and the mock held the response open.

| Active sessions | Server idle | Created, not prompted | All mid-turn | Mid-turn minus server idle | Busy confirmed | Cgroup `oom_kill` |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 378.4 MiB | 381.4 MiB | 472.4 MiB | 94.1 MiB | 1/1 | 0 -> 0 |
| 8 | 380.8 MiB | 346.9 MiB | 477.7 MiB | 96.9 MiB | 8/8 | 0 -> 0 |
| 16 | 351.3 MiB | 348.7 MiB | 552.8 MiB | 201.5 MiB | 16/16 | 0 -> 0 |

The created-idle readings include normal GC noise and are not monotonic. The
mid-turn readings are the decision values and are capacity floors. The mock
holds an open response with almost no token flow and no tool output, so it does
not allocate the buffers that real provider streams and tool results can need.
Before the 16-session run, the host had 19 GiB available; see
`evidence/free-before-16.txt`.

## Four contract facts requested by review

1. Session reads expose the working directory in both V1 and V2. They do not
   expose a profile identifier. Isomux can verify the directory, but profile
   ownership must come from the per-user supervisor that selected the server.
2. V1 assistant messages expose input, output, reasoning, and cache token fields
   plus cost. The session record stores accumulated token and cost totals. The
   mock fixture proves exact field transport in `evidence/v1-results.json`.
   This is usage accounting, not current context occupancy, so
   `getContextUsage()` should remain `null`.
3. V1 provider discovery separates `all` from `connected`. With zero test
   credentials it reports only `opencode` connected; after the local provider
   is configured it reports `opencode` and `gate`. See
   `evidence/provider-discovery-results.json`.
4. An `once` permission answer does not persist. A later bash request in the
   same session asks again. The fixture then rejects it. See the three request
   and reply pairs in `evidence/v1-results.json` and the event streams.

## Decisive client contract failures

- V2 client `0.0.0-beta-18314` sends the generated prompt shape that the V2 CLI
  rejects with `Missing key at ["prompt"]`.
- The V2 client calls `/api/server`, but the V2 CLI serves HTML there.
- V2 fork and compaction routes do not match the generated client contract.
- V1 SDK `1.18.23` types name the permission event `permission.updated` and
  expose the old session-scoped reply route. V1 CLI `1.18.23` emits
  `permission.asked` and accepts `POST /permission/:requestID/reply`.

These are typed client failures, not model-provider failures. The deterministic
mock received no real credential.

## Open risks and required revision

- Wait for one stable V2 CLI/client pair, pin both exact versions, and rerun the
  full gate. A beta pass would still not satisfy the scope's stable-contract
  condition.
- Change the launch contract to require all three startup controls:
  `--pure`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, and
  `OPENCODE_DISABLE_CLAUDE_CODE=1`. An allowlisted global config can then add
  only Isomux-approved providers and MCP servers.
- Redact structured provider errors before they reach Isomux JSONL or LogView.
  OpenCode passes arbitrary response headers through unchanged.
- Put the durable OpenCode profile below Isomux `STATE_ROOT`, or extend the
  updater snapshot contract before implementation. Then rerun an actual tagged
  update with the pinned binary installed.
- Treat abort-idle separately from completed-turn idle.
- Key tool state by `(sessionID, partID)`. Keep `callID` as a pairing field, not
  as a globally unique identifier.
- Verify fork at the selected message, the child transcript, and first-message
  behavior before implementing Isomux edit-message flow. This gate proves only
  that the V1 fork endpoint responds.

## Reproduction

Run commands from this directory after `bun install --frozen-lockfile`:

```sh
bun run harness/probe-v2.ts
bun run harness/probe-v1.ts
bun run harness/analyze-events.ts
bun run harness/auth-error-probe.ts
bun run harness/security-probe.ts v1
bun run harness/security-probe.ts v2
bun run harness/process-secret-probe.ts
bun run harness/secret-scan.ts
bun run harness/discovery-probe.ts
bun run harness/rss-probe.ts 1
systemd-run --user --scope -p MemoryMax=4G --unit=isomux-opencode-rss-8b bun run harness/rss-probe.ts 8
free -h
systemd-run --user --scope -p MemoryMax=4G --unit=isomux-opencode-rss-16b bun run harness/rss-probe.ts 16
bun run harness/version-probe.ts
```

All scratch repositories and profiles are under `/tmp/isomux-opencode-gate`.
No gate session points at a real project checkout. The early route-discovery
probe queried the V2 provider list from the worktree before this invariant was
encoded; it created no session and sent no prompt. All verdict-bearing session
evidence uses only the scratch paths above.
