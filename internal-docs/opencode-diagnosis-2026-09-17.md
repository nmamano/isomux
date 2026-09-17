# OpenCode process-loss diagnosis, 2026-09-17

A stale-server repeated-failure mechanism is reproduced, but it does **not** reproduce the customer's exact repeated wording. Whether the customer's process died, and why, is **not established**. A provider error does not, by itself, make Isomux stop OpenCode. Both a local HTTP 400 and a controlled real-provider HTTP 401 left the pinned server alive. Product code is unchanged.

Measurements below were made on 2026-09-17 UTC (September 16, evening PT), on this box only. The paid test contacted the vendor API with PM approval. No test contacted the live office or a customer's host. Office API calls were limited to lane coordination and task bookkeeping.

## Source and failure chain

All product file:line references are at `cee01e545e17d1a258b7254bc4a6cf1e5feea6fb`, unchanged in this lane. The pinned executable is `opencode-v1` 1.18.23 (`server/backends/opencode/runtime.ts:4`). References below are relative to `server/backends/opencode/` unless stated otherwise.

1. `adapter.ts:130` creates one transport per backend session. `transport.ts:344` acquires a lease only when the transport has no session id. Later turns reuse it.
2. `supervisor.ts:145` calls `ensureServer()` on each **acquisition**. The helper checks the old process and authenticated `/global/health` (`start-server.ts:68`), then adopts it or stops it and starts a replacement (`start-server.ts:171`, `:187`).
3. `start-server.ts:212` detaches the server; `:239` unreferences it. The long-lived supervisor owns the helper invocation, not a child-process exit listener for the server. It does not clear its cached record when the server exits or receives SIGKILL. Ordinary exit, crash, and external kill therefore have the same stale-record problem.
4. `supervisor.ts:173` checks for replacement requests, but calls `ensureServer()` only if the cached record is null. A dead process leaves a non-null record. A live process that refuses connections also passes this check. There is no per-turn health check or autonomous restart timer.
5. `transport.ts:412` calls `beginTurn()`. With an office authority binding, `:414` can fail first: `authority-broker.ts:103` rejects an unreadable server process identity. Otherwise `/event` is requested at `transport.ts:526`. An initial connection failure reaches the outer catch at `:437`; a failure while reading an established stream reaches `:733`. The latter message does **not** prove that initial connection establishment failed.
6. `transport.ts:707` handles a provider error by classifying it and completing the turn as failed. It does not stop the server or invalidate the lease. `:372` ends the turn and aborts that turn's stream, not the process. The customer sequence needs an additional, unproved process failure or connection failure.
7. A new acquisition can repair the process. Existing leases read the supervisor's current record dynamically (`supervisor.ts:155`), so old sessions can recover after another acquisition. Model discovery also acquires (`transport.ts:76`). A configuration/environment replacement clears the record through shutdown (`supervisor.ts:246`, `:311`).
8. The ten-minute idle shutdown requires **zero leases** (`supervisor.ts:347`); waiting between turns on an open session does not meet that condition. The manager has a separate two-hour idle release (`server/agent-manager.ts:4575`), so the failure is not guaranteed to last forever. Retrying the same session alone does not repair it.

The direct member path preserves the existing backend session (`server/agent-manager.ts:6599`, `:7126`). Its failed completion adds the error to chat and changes state (`:4289`, `:4311`, `:4339`). The queued-message path differs: it can auto-resume an errored agent (`:5846`). This distinction matters when comparing manual chat sends with agent/API messages.

### Customer wording and release boundary

`ba7579dd` first ships in **v2026.9.14** (also present in v2026.9.16). The prior code (`git show ba7579dd^:server/backends/opencode/transport.ts`) requests `/event` at old line 453, through fetch at old line 702. An initial refused connection reaches the outer catch at old lines 356–367, which returns the **bare** Bun message, such as `Unable to connect. Is the computer able to access the url?`. The prefix `OpenCode event stream failed: ` exists only in the reader catch at old lines 665–670, **after `/event` has answered**. On v2026.9.14 and later, the catch paths instead use the class/code wording recorded below. The stale-record check already exists in v2026.9.10 (`supervisor.ts:162`).

Thus, a prefix of `OpenCode event stream failed: ` on **every** next turn matches neither the stale-dead-record reproduction nor the current error wording exactly. The quote may be paraphrased, or `/event` may connect and then fail while reading on every turn. A server that accepts and then drops each stream is a different mechanism. Obtain the **customer build tag and verbatim chat text** before attributing their sequence to stale process state. The quoted Bun text alone does not prove that nothing was listening.

## Reproduction and evidence

The recipe is [evidence/opencode-diag-0917/reproduce.js](evidence/opencode-diag-0917/reproduce.js). It uses the real pinned executable, a local mock provider on port 0, and the supervisor's spare port in 22000–22999. It never starts an office HTTP server. The manager mode calls the manager in-process, with topic generation stubbed to avoid unrelated model calls.

```sh
diag_root=$(mktemp -d /tmp/opencode-diag-local-XXXXXX)
git rev-parse HEAD > /tmp/opencode-diag-run.log
ISOMUX_HOME="$diag_root" systemd-run --user --scope -p MemoryMax=2G \
  bun internal-docs/evidence/opencode-diag-0917/reproduce.js \
  >> /tmp/opencode-diag-run.log 2>&1
printf 'exit=%s\n' "$?" >> /tmp/opencode-diag-run.log
git rev-parse HEAD >> /tmp/opencode-diag-run.log
```

Use a fresh root on every run. Add `DIAG_MANAGER=1` for member-send behavior, `DIAG_STARTUP_ONLY=1` for health-to-event timing, `DIAG_TIMEOUT=1` for the local delayed-provider topic timeout, or `DIAG_LIVE=1` for the explicitly authorized paid test. The paid mode performs three short turns on one paid model, then one controlled invalid-key request only if all three succeeded. It stops at an earlier failure. It reads the existing key from the environment, never prints it, and never persists raw provider messages or `/provider` bodies. Do not re-run the paid mode without a spend authorization.

Each checked-in log begins and ends with the actual worktree commit. The local and first paid runs used `fd16ed1d61f8050157a2087efcd8f112dcb0d44e`; manager and paid control used `c0046f31cf0e1f105aa734671684cebc773cd549`; concurrent startup used `5518b1f348fd3a38f0e7749b5005697e9d542615`. Product code is identical across these commits. All checked-in runs exited 0. An earlier manager harness completed its observations but retained its authority-broker listener; the harness cleanup was fixed and the completed rerun is the evidence below.

### Local transport: [local.log](evidence/opencode-diag-0917/local.log)

Root `/tmp/opencode-diag-local-UB1kND`; mock port 35809. Initial server pid 253787, port 22969. Baseline completed. Local HTTP 400 produced `OpenCode reported a provider or transport error.` The next successful turn used the **same pid**.

The harness then executed `process.kill(253787, "SIGKILL")`, equivalent to **`kill -KILL 253787`**, between turns. This is the pid read from `server.lock`, not the helper or flock pid.

| Turn | Exact failed-completion text / result | Record pid |
| --- | --- | --- |
| After between-turn kill, first | `OpenCode turn failed (Error/ConnectionRefused; HTTP status: unavailable).` | 253787 |
| After between-turn kill, second | Same exact text | 253787 |
| Two-second wait, no acquisition | No new server record | 253787 |
| New session | Completed | 253932 |
| Original session after acquisition | Completed | 253932 |

The mock then held a provider response. Once the provider request arrived, the harness executed **`kill -KILL 253932`**, again from `server.lock` (port 22811), during the active turn.

| Turn | Exact failed-completion text / result | Record pid |
| --- | --- | --- |
| Active turn at kill | `OpenCode event stream failed (Error/ConnectionRefused; HTTP status: unavailable).` | 253932 |
| Next turn, first | `OpenCode turn failed (Error/ConnectionRefused; HTTP status: unavailable).` | 253932 |
| Next turn, second | Same exact text | 253932 |
| Close/recreate transport, resume same session id | Completed | 254138 |

These are normalized backend events. The next run verifies actual manager chat errors.

### Member send path: [manager.log](evidence/opencode-diag-0917/manager.log)

Root `/tmp/opencode-diag-manager-bXBbeG`; mock port and server port are recorded in the log. After a successful baseline and the same generic provider-error sentence, **`kill -KILL 256046`** killed the recorded server between turns. Both next member sends logged exactly:

`OpenCode turn failed (Error; HTTP status: unavailable).`

Both retained pid 256046. The current authority binding fails before fetch because the pid is gone; this is different wording from the reported customer build. Calling the backend's model-list method started pid 256176, and the next member turn succeeded. No product recovery patch was used.

### Paid provider: [paid.log](evidence/opencode-diag-0917/paid.log), [paid-control.log](evidence/opencode-diag-0917/paid-control.log)

`OPENCODE_API_KEY` was present. Six short turns total on **`opencode/gpt-5-nano`** completed across two isolated runs. No natural provider error occurred. The second run then deliberately replaced only its temporary child's launch environment with a dummy invalid key. The replacement itself changed pid 256042 to 256231 **before** the failing request. This seventh request returned `APIError`, HTTP 401, non-retryable. The member-facing text was `OpenCode authentication is not configured.` A direct authenticated health request then returned HTTP 200 from the same pid 256231. No further provider turn was sent after the error.

This proves a real provider-error path survives; it does not reproduce the customer's unknown paid-provider error or prove that every provider error is safe. Roots were `/tmp/opencode-diag-paid-LIEvOq` and `/tmp/opencode-diag-paid-control-TXWjF4`. A post-run byte scan found the real key in **zero files** across all six diagnostic roots (192 regular files), and zero times in all six harness logs. Only counts were printed. Raw provider logs and databases are not checked in.

## Relayed customer topic timeout

PM relayed a customer journal excerpt supplied through Nil: September 17, 02:43–03:04 **customer box time, timezone unverified**. The excerpt mostly contains office-proxy calls, plus `Topic generation failed for agent-1788647046601-dson: OpenCode one-shot prompt timed out.` at 02:44:30. We did not obtain or inspect the customer's journal directly. This tail has **no event-stream or provider-error line**; it neither supports nor refutes process death. Proxy calls show that some OpenCode work reached the office proxy at those times, not that the affected session or environment profile stayed healthy.

On the inspected source, `adapter.ts:100` sets a 30-second one-shot timeout and `:101` a one-second cleanup wait. Model discovery acquires before that timer starts (`:601`). The one-shot then creates its own temporary session on the same environment supervisor and selected model (`:605`). Its timeout covers send and completion (`:657`), including the second acquisition, setup, and provider response. At expiry it requests an abort (`:663`), rejects, attempts to delete the temporary session for up to one second, and closes it (`:669`). This path does not stop the shared server or invalidate its cached record.

`generateTopic` uses the agent's model and environment (`server/agent-manager.ts:3303`), logs the failure (`:3362`), clears the topic to null, and clears the generating flag (`:3367`, `:3375`). It does not replace or fail the main chat session. The next ordinary send uses that main session. A null topic can also start another topic attempt (`:6553`); its new discovery acquisition can incidentally repair a dead server.

The timeout is consistent with slow or stalled work, but does not locate the delay in the local server versus the vendor or event handling. A simple refused local connection normally settles as a failed turn instead of waiting for this timeout. It is not evidence of local overload, nor proof against a later death. The local delayed-provider control below separates timeout from process loss without a paid call.

**Local control, 2026-09-17 UTC:** [timeout.log](evidence/opencode-diag-0917/timeout.log) starts and ends at `72b7df8818fb05101c372452377190ed9dd802ca`. Root `/tmp/opencode-diag-timeout-3IT7ok`, local provider port 34817, OpenCode pid 264057 on port 22708. After a successful main-session baseline, the fixture delayed a real request from the pinned server to the local provider by 10 seconds. The existing backend test option shortened only the one-shot timer to 3 seconds; product code and its 30-second default were unchanged. The call reported `OpenCode one-shot prompt timed out.` after 5.345 seconds total, including discovery and cleanup. The fixture confirmed the provider had received the request. A health request returned 200, and the next turn on the original main session completed with the same pid 264057. No kill or restart occurred. The fixture exited 0; its 11 state files and its log contained zero occurrences of the real key. This control uses the real one-shot backend, not the manager's topic-generation stub from the earlier member-send test.

## Separate startup/load symptom

Single initial acquisitions measured 5.292 s (one-minute load 0.52→0.64), 4.457 s (0.90), and 4.389 s (0.46→0.83). Four concurrent isolated starts in one MemoryMax=2G scope measured **3.875, 4.067, 4.220, 4.402 s**; one-minute load was **2.43→2.96**. Each returned HTTP 200 and a first `/event` frame, 0.204–1.168 s after acquisition. All four individual exit lines were 0. See [startup.log](evidence/opencode-diag-0917/startup.log).

This did not recreate the September 10 load of 9–17. The old symptoms remain separate and unproved. Health acceptance requires an actual successful authenticated response and matching version (`start-server.ts:132`); it cannot accept a process that has never listened. The port can still stop listening after acceptance. Its limit is 160 attempts, each with a 300 ms request timeout and 50 ms sleep; it is **not** a fixed eight-second wall-clock deadline. An immediate refusal often spends only the sleep, while slow requests and scheduling delay extend elapsed time. These measurements do not justify changing a timeout or cap.

## Models, logs, and recovery today

Processes are shared by **environment-source identity**, not by model or payment tier (`supervisor.ts:358`, `:384`; `profile-paths.ts:18`). The manager supplies `environmentSourceKeyForUserId` (`server/agent-manager.ts:547`); that identity hashes the office and personal environment source paths (`server/env-loader.ts:135`). Members with different source identities may have different processes. Free and paid models with the same identity use one process. A dead process cannot serve either. A newly opened free-model session or model picker can restart the shared process, which confounds a free-versus-paid comparison. Ask whether a pre-existing free session with the same identity kept working at the same time, and whether any model dialog or new session was opened.

The brief's logging premise needs correction. `transport.ts:709` calls an **optional** `safeErrorSink`; `adapter.ts:691` constructs the production singleton with no sink. Therefore that callback writes to **no production log**. `transport.ts:1180` retains `error.data.message` for classification, but the generic failed completion loses it. The manager writes the generic text into the agent JSONL (`server/agent-manager.ts:4311`; `server/persistence.ts:105`), which is what chat and the conversation-log API can show. History projection also keeps only text parts (`transport.ts:906`), not provider error metadata.

The pinned server independently wrote the local error marker three times to `<profile>/data/opencode/log/opencode.log` in this run. In production that is normally `${ISOMUX_HOME}/opencode/profiles/<identity-hash>/data/opencode/log/opencode.log`. The supervisor also has stdout/stderr capture, but removes those private temporary files after healthy startup unless `ISOMUX_OPENCODE_DEBUG=1` (`start-server.ts:192`, `:254`). That flag is prospective; it cannot recover old unlinked output. A hosted owner can inspect their own runtime log through the terminal/filesystem; the normal chat/logs API does not expose that log. Provider messages can contain sensitive response text, so wiring this sink requires deliberate redaction, not raw forwarding.

**Least disruptive workaround, from source plus the model-list reproduction:** the agent's owning member can open its Edit agent dialog, wait for the OpenCode model list to load, then retry the chat. The dialog fetches the model endpoint (`ui/components/EditAgentDialog.tsx:610`, `:627`), whose source resolves that member's environment and calls `listModels` (`server/isomux-office.ts:1400`, `:1407`). This obtains a new lease without clearing the conversation. A new/resumed backend session also repairs the process; `/clear` obtains a fresh session but starts a new conversation. A whole-office restart is a more disruptive fallback. None was performed here. The dialog action itself was traced in source, not exercised through a browser in this lane.

## Fix candidates, ranked

1. **Validate/recover the shared server at turn entry.** Check process identity and bounded health before authority activation or `/event`, and serialize one restart per profile. Resume the existing durable session and refresh all lease endpoints. This addresses the reproduced persistent failure after process loss. Do not replay a prompt that may already have executed; recover for the next turn or retry only before prompt submission.
2. **Record process-loss diagnostics and safe provider metadata.** Record pid, identity, health outcome, status code, and reviewed error classes. A persistent process supervisor could also record exit status/signal. This helps distinguish a crash, external kill, and refusal without disclosing raw provider text. It addresses the missing evidence for the customer's first failure, not recovery by itself.
3. **Bounded event-subscription recovery before prompt submission.** Re-check health and reacquire on a failed initial subscription. This covers a narrow health-to-event race; blind retries against the cached dead port do not. Mid-turn stream loss needs an explicit failure and next-turn recovery, not silent prompt replay.
4. **Startup deadline/diagnostic improvements only after high-load evidence.** Separate child exit, health deadline, and bind failure in safe diagnostics. A longer wait may help a slow start but cannot repair a dead server cached by an existing session. Current measurements do not support increasing limits.

Before any OpenCode dependency change, check whether a later release fixes an upstream process-exit defect; no such upstream defect or fix is established here. No product fix, user-visible copy, API, or product test assertion changed. The next decision is a recovery-fix lane for the reproduced bug. Questions for the customer are the build tag, verbatim chat text, selected model, failure time with timezone, and whether an existing free-model session with the same environment identity kept working without a new acquisition. Whether their process died, and the cause if it did, remain unknown.
