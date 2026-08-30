# Agent safety hooks

Isomux applies the same safety policy before recognized tool calls from Claude and Codex agents. The policy blocks recognized destructive commands, protected-path writes, secret-bearing reads, cross-agent process kills, and commands that open outbound tunnels.

These checks reduce accidents by honest agents. They are not complete prevention, and they are not an operating-system security boundary.

## Security boundary

In a standard Isomux install, the server, its agents, and the Codex checker run as the same operating-system user. File mode bits can exclude other users, but they do not isolate processes that share that user ID. An agent that acts adversarially with the same user permissions can change files that the server can change. Stronger isolation requires running Isomux under a dedicated operating-system identity, separate from the owner's account, and may require stronger isolation between agents.

A filesystem-capable MCP remains a concrete route around the built-in tool mappings. On 2026-08-30, live policy checks allowed such an MCP to write Isomux state, read a backend login file, and replace the Codex checker executable. Mapping Codex `apply_patch` into the safety policy closed that tool route; it did not close the class of filesystem-capable tools.

Before each Codex spawn, Isomux hashes the installed checker bytes and repairs missing or changed content from a verified build artifact. However, a replacement at the same path can affect the next tool call in an already running session. The pre-spawn repair therefore limits a replaced checker to the remainder of the current session; it does not protect that live session.

## Protected paths and limits

Protected write targets resolve against the agent working directory. When a hook input has no non-empty absolute working directory, a relative target with a bounded `.isomux` path segment denies, while an ordinary relative target remains allowed. The residue is that an ordinary relative target can fail open if the provider stops sending the working directory and the agent is already working inside the state root. Codex emits a transcript warning on every tool call with a missing or invalid working directory, so this reduced coverage is visible rather than silent; the parser test does not prove that a future Codex version will keep sending the field.

An unresolvable directory-change operand denies any later relative write, while an absent envelope working directory denies only a protected-path candidate. This asymmetry is deliberate: a dynamic `cd` states an intent to relocate, so the old working directory is not a safe fallback. The denial tells the agent to use an absolute write target.

Relative paths that resolve under the literal `~/.isomux` are mapped to the configured state root before the boundary check. This is an identity in a default install. With a non-default state root, it also denies writes to the literal `~/.isomux` path.

## Measured coverage

The Codex hook contract was measured with Codex 0.144.6 on 2026-08-28 and 2026-08-29. `PreToolUse` covered every measured Bash, `apply_patch`, dynamic-tool, and MCP action before its side effect. Fresh, resumed, forked, and one-shot sessions were measured directly. Cron runs and model listing use the same spawn path, so their setup coverage is inferred rather than measured with a tool action.

`PermissionRequest` added no tool coverage in the measured `never` and `untrusted` approval modes. Under `never`, only `PreToolUse` fired. Under `untrusted`, the measured action reached `PreToolUse` first and `PermissionRequest` second. This conclusion applies only to those measured modes.

On 2026-08-29, the production installer was proven end to end for the allow arm: it installed and trusted the hook, the hook ran and returned a decision, and the allowed command completed. The installed hook's own deny was not observed end to end because the model declined to issue the protected command. The deny claim is a composition: the production installer was shown to create the trusted decision path, and the 2026-08-28 hook-contract measurement showed that a trusted deny blocked the action in both measured runs. The link between those measurements is inferred.

## Failure behavior

Codex fails open when a hook executable is missing, exits with an error, times out, or returns an invalid result. Isomux surfaces the same signed transcript warning when it detects a pre-spawn installation or trust failure, a caught checker fault, or a technical `hook/completed` failure:

> ISOMUX SAFETY WARNING: Safety checks failed for this tool call. Isomux allowed it without guard enforcement. Tell the office owner and check the isomux service logs.

The Codex session still starts after a pre-spawn failure. Isomux also writes a cause-specific server error so the office owner can distinguish artifact, repair, hook configuration, trust, and unexpected failures.

## Trust and event identity

Codex uses two numbering systems for hooks. A trust key uses the matcher-group index plus the hook's index within that group. A `hook/completed` event uses `displayOrder`, the flat handler position across all `PreToolUse` groups. These values are equal in layouts with one hook per group, which can hide an incorrect implementation. Isomux keeps them separate so a failed Isomux hook produces the safety warning without mislabeling a user's failed hook.

## Boot trust probe

At boot, Isomux starts a scratch Codex App Server without authentication and asks `hooks/list` for the trust hash used by the bundled Codex version. The complete scratch measurement, including process start, initialization, and `hooks/list`, has a 10-second deadline. On 2026-08-29, full boot preparation including compilation, closure analysis, source-stamp verification, and the trust measurement took about 2.41 seconds, so the deadline has about four times the observed headroom. If boot-probe timeouts appear in the server logs, this deadline is the first constant to inspect.

A failed trust measurement is not cached for the process lifetime. The office continues to listen, and each later Codex spawn retries the complete bounded measurement. If it still fails, the Codex session starts with the signed transcript warning.
