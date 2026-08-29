# Codex safety-hook contract measurements

- Measurement date: 2026-08-29
- Pinned Codex version: `@openai/codex` 0.144.6
- Model: `gpt-5.6-sol`
- Production behavior changed: no

This is Slice 3A evidence for task `e2f28dac`. It measures the contract that a
later standalone checker can use. It does not install a hook in an Isomux
agent, add enforcement, change the Claude policy, or choose a timeout.

## Result

The primary fail-open warning can use a well-formed `systemMessage`. Codex
0.144.6 places it in the `hook/completed` notification as an entry with
`kind: "warning"`. The notification reaches the Isomux adapter, but the adapter
currently ignores it. A later slice can translate that entry into transcript
`system_text` without a broker, socket, or new transport.

Hook stderr is not a usable warning surface. A marker written on a successful
allow call did not appear on the App Server stderr stream, in
`hook/completed`, or in any transcript-facing event. The same marker was absent
when the hook exited 17 and when it printed malformed output. This establishes
that stderr is not observable at the App Server boundary in these cells. It
does not claim whether Codex discards the bytes internally or retains them in
an interface App Server does not expose.

`PermissionRequest` observed no action that `PreToolUse` missed. Under Isomux's
actual `approvalPolicy: "never"`, a Bash positive control ran and only
`PreToolUse` fired. Under `untrusted`, the same class of action first reached
`PreToolUse`, then reached `PermissionRequest`, requested client approval, and
ran after the probe approved it. A PermissionRequest deny saw the same action,
blocked it, emitted no approval request, and produced no side effect. The
production hook therefore needs `PreToolUse`; mounting the same policy again on
`PermissionRequest` would be redundant for every measured action.

`apply_patch` is cheap to cover without a new policy. Its live `PreToolUse`
payload reports `tool_name: "apply_patch"` and puts the patch envelope in
`tool_input.command`. A 42-line candidate extractor returned paths only from
the envelope's Add, Delete, Update, and Move headers. It returned both source
and destination for a move and returned null for missing, malformed,
ambiguous, or unsupported structure. The existing path rules can then resolve
and check those paths. Patch text must never enter the shell rules.

No shared input-length cap should ship. The cap weakens Claude enforcement and
is unnecessary if the ambiguous rm flag patterns are repaired. At 1,604 input
bytes the live policy took 10,364 ms and denied; a scratch-only arm with the 14
ambiguous flag fragments replaced took 1.319 ms and made the same deny
decision. A 512-byte cap changed six named denials to allow, including ordinary
long destructive, secret-read, and protected-write commands. A 1,024-byte cap
still changed the 1,204-byte rm-shaped denial to allow. Task `8340b53f` should
become the prerequisite policy fix rather than routing around the defect with
a cross-engine cap.

## Warning transport

The focused probe ran one model-driven Bash action per cell. Every fail-open
cell has a positive side-effect control: the marker file existed after the
turn. The full raw result was written to
`/tmp/codex-guards-hook-contract.json`; it is not checked in because it contains
123 KB of repetitive App Server items and scratch paths. Re-run with:

```sh
ISOMUX_TEST_CODEX_AUTH_HOME=~/.isomux/codex-home \
  bun server/backends/codex/hook-contract-probe.ts
```

| Hook result | `hook/completed` | App Server stderr | Transcript event | Side effect |
| --- | --- | --- | --- | --- |
| `{}` | completed, no entries | no hook output | none | present |
| stderr marker + `{}` | completed, no entries | marker absent | marker absent | present |
| `systemMessage` marker | completed, warning entry | marker absent | currently absent | present |
| `additionalContext` marker | completed, context entry | marker absent | currently absent | present |
| missing executable | failed, `hook exited with code 127` | no hook output | currently absent | present |
| stderr marker + exit 17 | failed, `hook exited with code 17` | marker absent | marker absent | present |
| stderr marker + malformed stdout | completed, no entries | marker absent | marker absent | present |
| one-second Codex timeout | failed, `hook timed out after 1s` | no hook output | currently absent | present |

The checked adapter measurement injects `hook/completed` through the same
notification subscription the real client uses, followed by a normal warning.
The first surfaced event is the later warning. Thus, `hook/completed` reaches
the adapter and is ignored by its current switch; it is not lost before the
adapter.

The output field inventory came from the official Codex hook manual fetched on
2026-08-29 and was tested against pinned binary 0.144.6. The tested PreToolUse
allow fields were `systemMessage` and
`hookSpecificOutput.additionalContext`; deny and rewrite fields remain covered
by Slice 1 and the pinned binary schema. PermissionRequest used
`hookSpecificOutput.decision.behavior`. Current documentation can move ahead of
the release, so only the live 0.144.6 results above support the production
contract.

The proposed agent-facing warning remains a draft until Nil approves it:

> ISOMUX SAFETY WARNING: Safety checks failed for this tool call. Isomux
> allowed it without guard enforcement. Tell the office owner and check the
> isomux service logs.

The later checker can emit that text as `systemMessage` on a caught internal
fault. For failures outside the checker, such as missing executable, nonzero
exit, or Codex timeout, the adapter can translate the error entry from
`hook/completed` into the same visible warning. Malformed output is not an
expected checker path: the checker owns stdout and must catch its internal
faults and emit a well-formed allow plus `systemMessage`.

## PermissionRequest event matrix

| Settings / output | Positive control | PreToolUse | PermissionRequest | Client approval | Result |
| --- | --- | --- | --- | --- | --- |
| `never`, allow | marker present | completed | absent | absent | ran |
| `untrusted`, allow | marker present | completed | completed | requested and approved | ran |
| `untrusted`, PermissionRequest deny | action emitted, marker absent | completed | blocked | absent | blocked |

The `never` cell is the exact setting Isomux currently passes. The two
`untrusted` cells force the approval path and prove both the event's positive
case and its blocking behavior. PermissionRequest is a second decision point
for the same measured action, not coverage for an action absent from
PreToolUse.

## apply_patch extraction

The live payload was:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "apply_patch",
  "tool_input": {
    "command": "*** Begin Patch\n*** Add File: /tmp/.../marker\n+reached\n*** End Patch"
  }
}
```

The candidate extractor covers:

- absolute, relative, and `..` header paths;
- Add, Delete, and Update sources;
- both Update source and Move destination;
- protected-to-safe and safe-to-protected moves;
- multiple files in one envelope;
- content lines such as `+*** Add File: not-a-header.ts` without treating them
  as headers;
- null for non-string, missing envelope, no-path, move-without-update, repeated
  move, NUL path, and unknown control header inputs.

Five scratch mutants confirmed the tests discriminate rather than decorate:

1. accepting a header match away from line start failed one test;
2. dropping Move destinations failed two;
3. returning an empty list instead of null failed one;
4. accepting Move without Update failed one;
5. dropping Update source paths failed three.

The production action kind should be `patch-files`. The Codex adapter maps the
explicit tool name `apply_patch` to it. The core extractor returns the paths,
and the existing write-path policy resolves and checks each path. An extractor
null is deny-unverifiable. It is not a checker failure and must not use the
allow-and-warn path.

## Remaining non-shell surface

The official 2026-08-29 hook manual and Slice 1 measurements give this local
tool surface:

| Surface | PreToolUse | Local protected-path reach |
| --- | --- | --- |
| `apply_patch` | measured | covered by the planned path extractor |
| MCP tools | measured | arbitrary server-defined inputs and effects; a configured filesystem MCP can still read or write `~/.isomux`, backend credentials, and the checker executable |
| Dynamic App Server tools | measured in Slice 1 | arbitrary handler effects, but Isomux does not configure them for ordinary sessions and currently rejects `item/tool/call` |
| Other local function tools | documented and partly observed | tool-specific; no other built-in arbitrary filesystem writer was established |
| Hosted tools such as WebSearch | documented as outside tool hooks | no local filesystem path established |
| Code-mode nested calls | documented | the nested local tool inherits its normal hook decision |

Thus, after Bash and apply_patch parity, a user-configured filesystem-capable
MCP server remains the concrete unproven path to `~/.isomux`, the backend login
files, and `~/.isomux/bin/isomux-codex-safety-hook`. This is the disclosure,
not the vague statement that non-shell tools are uncovered. Dynamic tools do
not provide that route in an ordinary Isomux session today because the adapter
does not expose them.

## Evaluation curve and cap cost

The checked probe imports the live neutral policy, builds its alternative only
in a temporary directory, asserts that exactly 14 ambiguous fragments were
replaced, and deletes the mutant. It never edits the production source.

| Command bytes | Live policy | Ambiguity removed |
| ---: | ---: | ---: |
| 104 | 8.150 ms | 4.071 ms |
| 204 | 17.714 ms | 4.858 ms |
| 404 | 132.799 ms | 0.619 ms |
| 804 | 1,311.151 ms | 0.783 ms |
| 1,604 | 10,364.298 ms | 1.319 ms |

Both arms denied every rm-shaped input. The ordinary allow and deny controls
completed in 0.174 ms and 0.130 ms respectively. These figures characterize
the algorithm on the office box; they are not the later standalone-process
startup measurement. That startup measurement waits for the PM's shared quiet
window and must record load average.

At a hypothetical 512-byte cap, these six denials became allow:

- `rm -` plus 600 alternating `r`/`f` flag bytes (604 bytes total);
- the same shape at 1,204 bytes;
- a 625-byte command ending in `rm -rf /home/probe`;
- a 628-byte command ending in `git reset --hard HEAD`;
- a 615-byte command ending in `cat .env`;
- a 632-byte command ending in `tee ~/.isomux/agents.json`.

At a hypothetical 1,024-byte cap, the 1,204-byte rm-shaped denial became
allow. The corpus also included ordinary and long allow controls, which stayed
allow. The named inputs show that the weakening is not confined to artificial
rm flags: the 512-byte candidate waves through commands a person could issue.

The ambiguity-removed arm is measurement only. It does not anchor, delete, or
otherwise change `normalizeAbsolutePaths`, and no pattern change is present in
the tree.

## Post-OpenCode extraction re-verification

OpenCode merged before the policy extraction. The extraction was rebased on
2026-08-29 against commit `b6a2e52`. The git-derived baseline is blob
`7cce10438f6a66cbb2b03b23211c73aac5f28366`, with SHA-256
`553e6f1e3b7ea9e704f33e03619b1a413fcc9cbf1195126bdedef5fd80fff53b`.
The checked differential test asserts both identifiers before it makes the
only mechanical baseline edit: it resolves the relative `./config.ts` import
to the checkout's absolute module URL. It also proves that reversing this one
edit restores the exact git bytes.

The corpus has 37 cases. It runs every hook in every matching Claude matcher
and compares both the decision and exact denial text. It includes one denial
tripwire for each new OpenCode credential-path arm, plus the two location
controls `/tmp/some-project/opencode/auth.json` and
`/tmp/some-project/auth.json`, which remain allowed. A third control proves a
profile name is exactly one path segment. Eight scratch mutants
must disagree with the baseline on their assigned case: raw-input loss, safe
and destructive rule reordering, allow-on-unverifiable paths, loss of the
second read-and-write check, tunnel ordering, and independent removal of each
OpenCode credential arm, and loosening the profile segment from `[^/]+` to
`.+`. All eight were killed. Each mutant must change bytes after the shared
scratch-import rewrite, so a no-op string replacement fails during construction
instead of producing a misleading decision failure. The known equivalent
normalization mutant is not counted as a tripwire.

The neutral action kind formerly named `notebook-edit` is now
`read-and-write-files`. The name states its semantics; the Claude adapter alone
maps `NotebookEdit` to that provider-neutral kind.

## Verification

- Focused live contract probe: 12 original cells plus three corrected
  missing/PermissionRequest cells; all requested positive controls stated
  above emitted.
- `bun test server/backends/codex/hook-contract-probe.test.ts`: 9 pass, zero
  fail, three consecutive runs.
- Extractor scratch mutants: five of five killed, with failure counts
  `1, 2, 1, 1, 3`.
- Adapter `hook/completed` measurement: one pass, zero fail, one run.
- Policy curve probe: one complete run; allow and deny controls passed, 14
  mutations asserted, both arms denied all five curve inputs.
- `bun test server/safety-policy-differential.test.ts`: 3 pass, zero fail on
  three consecutive runs; 37 baseline comparisons and eight scratch mutants.
- `bun test server/safety-hooks.test.ts`: 271 pass, zero fail on three
  consecutive runs after the OpenCode rebase.

Raw live outputs stay in `/tmp` and contain scratch session ids and repetitive
tool items. The checked probes regenerate them. No test assertion was removed
or replaced in this slice.
