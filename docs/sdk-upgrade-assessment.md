# Claude Agent SDK Upgrade Assessment

**Date:** 2026-04-07
**Current version:** 0.2.86 (installed), `^0.2.85` in package.json
**Latest version:** 0.2.92
**Decision:** Hold. No bump until we have a concrete reason.

## Our SDK usage

We use the **unstable V2 API** (`unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`), not `query()`. Key integration points:

- **`server/agent-manager.ts`** — session lifecycle (create, send, stream, close), message processing, topic generation via `unstable_v2_prompt()`
- **`server/safety-hooks.ts`** — PreToolUse hooks for Bash and Write/Edit safety
- **`shared/types.ts`** — own `permissionMode` type (`"default" | "acceptEdits" | "bypassPermissions"`)

We do **not** use: `query()`, `startup()`, `getSessionMessages()`, `listSubagents()`, `getSubagentMessages()`, `side_question`, `createSdkMcpServer`, `settingSources`, sandbox options.

## Release-by-release analysis

### v0.2.87 (Mar 29) — CLI parity only

No SDK API changes.

### v0.2.89 (Apr 1) — New APIs + bug fixes

| Change                                              | Affects us?                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup()` pre-warm (~20x faster first query)      | No. We don't use it. Potential future opportunity.                                                                                                                        |
| `listSubagents()` / `getSubagentMessages()`         | No. Additive API, unused.                                                                                                                                                 |
| `includeSystemMessages` on `getSessionMessages()`   | No. We don't call `getSessionMessages()`.                                                                                                                                 |
| `includeHookEvents` option                          | No. Additive option, unused.                                                                                                                                              |
| `ERR_STREAM_WRITE_AFTER_END` fix                    | **Probably not.** Triggers on single-turn `query()` with hooks/MCP. We use multi-turn V2 sessions.                                                                        |
| Zod v4 `.describe()` fix on `createSdkMcpServer`    | No. We don't use `createSdkMcpServer`.                                                                                                                                    |
| `side_question` null on resume fix                  | No. We don't use `side_question`.                                                                                                                                         |
| `settingSources` empty array fix                    | No. We don't pass `settingSources`.                                                                                                                                       |
| `is_error: true` on error result messages           | No breakage. We check `result.subtype === "success"`, not `is_error`.                                                                                                     |
| MCP servers stuck after connection race — now retry | **Plausibly relevant.** Agents inherit account-level MCP integrations. A connection race could leave an MCP server permanently stuck. Unconfirmed whether we've hit this. |

### v0.2.90 (Apr 1) — CLI parity only

No SDK API changes.

### v0.2.91 (Apr 2)

| Change                                         | Affects us?                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `terminal_reason` field on result messages     | No. Additive field, unused.                                                                      |
| `'auto'` added to `PermissionMode` type        | No. We define our own type, never pass `'auto'`.                                                 |
| Sandbox `failIfUnavailable` defaults to `true` | **No.** Only applies when `sandbox: { enabled: true }` is passed. We don't pass sandbox options. |

### v0.2.92 (Apr 4) — CLI parity only

No SDK API changes.

## Summary

- **Zero breaking changes** for our usage
- **Zero code changes** required on our side
- Only plausibly relevant fix: MCP server stuck state (0.2.89), unconfirmed
- New APIs (`startup()`, `terminal_reason`, subagent history) are opportunities for future work, not urgent
