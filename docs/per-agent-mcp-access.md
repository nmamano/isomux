# Per-Agent MCP Integration Access Control

## Background

Claude Code agents in isomux inherit all MCP integrations connected to the user's claude.ai account (Gmail, Google Calendar, Vercel, etc.). These are account-level OAuth grants stored server-side by Anthropic, not configured locally. The tools appear with the prefix `mcp__claude_ai_<IntegrationName>__`.

Currently all agents get the same set of integrations. We want per-agent control over which integrations are available.

## How Account-Level MCPs Work

1. User authorizes an integration (e.g. Gmail) in claude.ai account settings via OAuth.
2. Anthropic hosts first-party MCP servers that use the stored OAuth token.
3. When Claude Code authenticates with the user's account, the SDK pulls in these integrations as available tools.
4. No local configuration exists for these — they come from the account.

## SDK Primitives Available

The Claude Agent SDK session object exposes:

- **`session.mcpServerStatus(): Promise<McpServerStatus[]>`** — Returns all connected MCP servers with name, status, and `scope` (e.g. `"claudeai"` for account-level integrations).
- **`session.toggleMcpServer(serverName: string, enabled: boolean): Promise<void>`** — Enable/disable a specific MCP server on a live session. Disabled servers have their tools removed from the model's context.
- **`session.setMcpServers(servers): Promise<McpSetServersResult>`** — Replace dynamic MCP server set.
- **`disallowedTools` option on session creation** — Alternative approach: block specific tool names at session creation time. Less granular (tool-level, not server-level).

`toggleMcpServer` is the cleanest lever — it operates at the server level and works on live sessions.

## Proposed Design

### Discovery

- Call `mcpServerStatus()` after the first session is created.
- Filter for `scope === "claudeai"` to find account-level integrations.
- Cache the list server-side (it's account-level, same for all agents).
- Refresh periodically or on agent spawn.

### Per-Agent State

- Add a field to `AgentInfo`, e.g. `disabledIntegrations: string[]`.
- After session creation (and on session recreation during abort recovery, model change, etc.), call `toggleMcpServer(name, false)` for each disabled integration.
- Persist in `agents.json` alongside other agent config.

### UI (TBD)

Timing constraint: the available integrations can only be discovered after a session exists, so the spawn dialog can't show them before the first agent is created.

Options considered:

- **Agent settings panel** — toggles per integration, per agent (if such a panel exists or is added).
- **Context menu on agent nametag** — quick "Integrations" submenu.
- **Global office-level defaults with per-agent overrides** — "These MCPs are on by default; agent X has Gmail off."

### Implementation in `createSession()`

All session creation flows through `createSession()` in `agent-manager.ts`. After creating the session, apply disabled integrations:

```typescript
function createSession(managed: ManagedAgent, resumeSessionId?: string) {
  const opts: any = {
    model: managed.info.model,
    permissionMode: sdkPermissionMode(managed.info.permissionMode),
    pathToClaudeCodeExecutable: managed.launcherPath,
    hooks: createSafetyHooks(),
  };
  // ...existing logic...
  const session = resumeSessionId
    ? unstable_v2_resumeSession(resumeSessionId, opts)
    : unstable_v2_createSession(opts);

  // Apply per-agent MCP restrictions
  for (const name of managed.info.disabledIntegrations ?? []) {
    session.toggleMcpServer(name, false);
  }

  return session;
}
```

Note: `toggleMcpServer` is async — may need to await it or fire-and-forget depending on whether the session is ready immediately.
