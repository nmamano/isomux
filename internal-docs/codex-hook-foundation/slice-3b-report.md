# Codex standalone safety checker

- Measurement date: 2026-08-29
- Pinned Codex version: `@openai/codex` 0.144.6
- Runtime: Bun 1.3.11 standalone executable
- Production installation changed: no; installation is Slice 4

This is Slice 3B evidence for task `e2f28dac`. It adds the standalone checker,
the Codex-to-neutral action adapter, and apply_patch path enforcement. It does
not install the checker into a Codex home or change agent spawn behavior.

## Result

The standalone executable makes the same decisions, with the same denial text,
as the in-process neutral policy. Bash maps to `shell`, apply_patch maps to
`patch-files`, and every other measured Codex tool maps to `uncovered-tool`.
The adapter routes by exact tool name, never by the presence of a `command`
field. Patch content therefore never enters the shell regular expressions.

The core owns apply_patch grammar and path-policy routing. It extracts Add,
Delete, and Update paths plus both sides of a Move. Relative and traversal paths
remain intact for the existing resolver. If a syntactically valid patch does
not identify a complete supported path set, the policy denies it as
unverifiable. A checker technical fault instead returns a well-formed allow
with the draft warning below. Those are different outcomes by design.

The executable is a compiled snapshot, so the build binds it to the complete
local source closure reported by Bun's bundle graph. On 2026-08-29 that closure
was:

- `server/backends/codex/safety-hook.ts`
- `server/config.ts`
- `server/safety-policy.ts`

The build hashes each normalized path and its bytes, stamps the combined
SHA-256 into the executable, invokes the new executable with `--source-hash`,
and refuses to return an artifact if the stamp differs. Slice 4 must still do
two separate checks: compare the installed file's content with the known-good
artifact to detect replacement, and compare its embedded source stamp with the
current closure hash to detect staleness. Neither check substitutes for the
other.

## Failure contract

The exact draft agent-facing text is unchanged and still requires Nil's
approval before Slice 4 ships it:

> ISOMUX SAFETY WARNING: Safety checks failed for this tool call. Isomux
> allowed it without guard enforcement. Tell the office owner and check the
> isomux service logs.

Malformed JSON, a non-PreToolUse event, a missing tool name, or a non-object
tool input is a checker technical fault and returns that well-formed
`systemMessage` allow. A valid apply_patch envelope with missing, malformed, or
unsupported path controls is policy input and denies as unverifiable. An
unknown tool is valid input and allows under the first-release coverage limit.

Agent-controlled input did not reach the technical-fault allow in the checked
axes: a 256 KiB allowed Bash command, a 256 KiB allowed patch, a 256 KiB command
ending in `rm -rf /`, 50,000 nested parentheses around that denial, 20,000
chained commands ending in that denial, 5,000 backticks around that denial, and
a 10,000-deep uncovered-tool input. The deny-worthy cases denied and the
uncovered tool allowed. This bounds those axes; it does not claim that all
possible inputs are incapable of triggering a technical fault.

## Process and hash cost

Worker and reviewer measured the identical artifact:

- executable SHA-256:
  `574199fa94ea0d4dbfe2463f2fa6ec6dcb4121b0de69532e11152f15373014e6`
- embedded closure SHA-256:
  `4421b0d7ace77bb4b9ff23cea3746a52ec30a3ca9ae31893fdf10d21710adf63`
- size: 99,335,513 bytes (94.7 MiB)

Worker measurement ran from 19:55:32Z to 19:57:08Z. Load average was
2.15/3.68/4.50 at start and 3.92/4.09/4.58 at end, concurrency one.

| Worker distribution | n | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh process, pre-warmup | 50 | 95.78 ms | 185.50 ms | 221.70 ms | 221.70 ms |
| Fresh process, after 30 warmups | 300 | 101.31 ms | 189.02 ms | 232.23 ms | 310.82 ms |
| In-process policy only | 20,000 | 0.0111 ms | 0.0380 ms | 0.1353 ms | 21.05 ms |
| Full-file read plus SHA-256 | 300 | 158.36 ms | 341.86 ms | 446.01 ms | 592.84 ms |

The worker instrument did not record the required Chrome check at the end edge
of each distribution. The Wall Game harness PID was observed exiting at
19:54:08Z and the worker waited 84 seconds before starting. Reviewer 3 observed
Chrome absent shortly after the worker interval and enforced Chrome-free edges
on the independent run, but that does not prove the worker's unsampled end
edge. Any unobserved CPU contention could only increase process and hash time,
so these figures are conservative upper observations for the decisions they
support; they are not presented as a tight quiet-host distribution.

Reviewer 3 ran an independent harness against the same bytes from 19:58:15Z to
19:58:25Z. Load was 3.60/3.92/4.48 at start and 3.49/3.89/4.46 at end. The
instrument confirmed no Chrome process at every distribution edge.

| Reviewer distribution | n | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spawn allow, concurrency 8 | 200 | 142.0 ms | 326.0 ms | 403.7 ms | 438.3 ms |
| Spawn deny, concurrency 8 | 200 | 107.4 ms | 184.9 ms | 221.2 ms | 247.8 ms |
| Spawn allow, concurrency 1 | 30 | 84.2 ms | 107.5 ms | 110.2 ms | 124.4 ms |
| In-process policy | 200 | 0.0 ms | 0.2 ms | 0.3 ms | 5.8 ms |

The sequential floors agree within one millisecond: worker 64.76 ms and
reviewer 65.5 ms. Sequential medians are 84-101 ms. The reviewer's sequential
sample has only 30 readings, so its p99 is not compared with the worker's
300-reading tail. Policy matching is more than three orders of magnitude below
process startup and is under 0.1% of ordinary call cost. The standalone
process is about three times faster at median than Slice 1's representative
252-308 ms process shape.

The highest reviewer observation was 438 ms. Codex's omitted-timeout default of
600 seconds therefore has more than one thousandfold headroom for ordinary
traffic. No explicit timeout and no input cap ship. The current cubic rm-flag
shape remains the disclosed residual: a multi-kilobyte pathological flag run
can approach the vendor timeout, while ordinary long commands measured in
single-digit milliseconds. Task `8340b53f` owns that policy rewrite.

Content verification costs more than one ordinary checker invocation: 158 ms
median for the 94.7 MiB artifact. It occurs once per session spawn, not per tool
call, and remains required. Replacing it with mtime, a version string, or a stat
fast path would restore the same-content-path replacement gap that Slice 1
measured.

## Mutation and differential evidence

The checked suite compares one corpus through the in-process policy and the
compiled executable on both decision and exact denial text. It includes Bash
allow and deny, patch allow, protected-path deny, deny-unverifiable, unknown
tool allow, and both 256 KiB valid envelopes.

Nine scratch mutants must change bytes at construction and then disagree on an
assigned case:

1. patch header match loses its line-start anchor;
2. Move destination is dropped;
3. an empty path set becomes allow;
4. Move without Update is accepted;
5. Update source is dropped;
6. apply_patch is routed to shell;
7. `patch-files` is changed to allow;
8. `uncovered-tool` is changed to deny;
9. caught technical fault emits an invalid hook output.

The earlier git-derived differential remains checked and proves that Claude's
decision and denial text did not change through the extraction and the new
core action kinds.

## Verification

- `bun test` over the standalone checker, patch extractor, git-derived
  differential, and Claude safety suite: 292 pass, zero fail on three
  consecutive runs after the final fault-path additions.
- Standalone checker suite alone: 7 pass before the final fault-path table; the
  combined run contains 8 pass after it.
- TypeScript gate before the final freeze: the only guards diagnostic was the
  unsupported `write` field on Bun's `BuildConfig`; it was removed. After the
  five unrelated OpenCode fixes landed and the lane rebased onto main
  `e085d99`, `bunx tsc --noEmit` passed with zero errors.

Raw worker timing output is `/tmp/codex-guards-safety-hook-benchmark.json`.
The preserved binary is a temporary measurement artifact and is not the Slice
4 installation.
