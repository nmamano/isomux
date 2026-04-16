# Plugin Management UI — Design Doc

## Status: Planned (not yet started)

## Context

Claude Code plugins are bundles of skills, commands, hooks, MCP servers, and
subagent definitions installed via `/plugin add`. The `/plugin` command is a
local-JSX (Ink/React) UI rendered entirely client-side in the CLI — no SDK
events are emitted, so Isomux cannot forward or intercept it.

**Current state:** Isomux already discovers plugin skills from
`~/.claude/plugins/installed_plugins.json` and surfaces them in autocomplete.
Plugin skills, hooks, and MCP servers work transparently because they're loaded
by the CLI subprocess. The only gap is the management UI (install, remove,
enable, disable, browse marketplace).

**Interim solution:** `/plugin` shows a message directing users to the built-in
terminal.

## Design: Hybrid Web UI + Headless CLI

### Principle

Use the existing headless CLI commands for mutations. Build a lightweight web UI
for browsing and status display. Don't reimplement the Ink component tree.

### Architecture

```
┌─────────────────────────────────────────┐
│  Isomux Web UI (Plugin Manager panel)   │
│                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │Installed │  │Discover  │  │Markets │ │
│  │ tab      │  │ tab      │  │ tab    │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │            │      │
└───────┼──────────────┼────────────┼──────┘
        │              │            │
        ▼              ▼            ▼
  ┌──────────────────────────────────────┐
  │  Isomux Server (plugin routes)       │
  │                                      │
  │  GET /api/plugins         → read     │
  │  POST /api/plugins/install   → CLI   │
  │  POST /api/plugins/remove    → CLI   │
  │  POST /api/plugins/enable    → CLI   │
  │  POST /api/plugins/disable   → CLI   │
  │  GET /api/plugins/marketplace → read │
  │  POST /api/plugins/marketplace/add   │
  └──────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────┐
  │  Headless CLI (subprocess)           │
  │                                      │
  │  claude plugin install <name>        │
  │  claude plugin remove <name>         │
  │  claude plugin enable <name>         │
  │  claude plugin disable <name>        │
  │  claude plugin marketplace add o/r   │
  └──────────────────────────────────────┘
```

### Data Sources

**Installed plugins** — read directly from
`~/.claude/plugins/installed_plugins.json` (V2 format):

```json
{
  "version": 2,
  "plugins": {
    "plugin-name@marketplace": [{
      "scope": "user|project|local|managed",
      "installPath": "/path/to/cache",
      "version": "1.0.0",
      "installedAt": "ISO 8601",
      "lastUpdated": "ISO 8601"
    }]
  }
}
```

**Plugin metadata** — read `.claude-plugin/plugin.json` from each
`installPath` for name, description, version, author, components.

**Enabled state** — read from `~/.claude/settings.json` →
`enabledPlugins` map.

**Marketplace catalog** — TBD. May need to fetch from marketplace repos
or rely on `claude plugin search` CLI output.

### Server Endpoints

| Endpoint | Method | Action |
|---|---|---|
| `/api/plugins` | GET | List installed plugins with metadata and enabled state |
| `/api/plugins/install` | POST | `claude plugin install <name> --scope <scope>` |
| `/api/plugins/remove` | POST | `claude plugin remove <name>` |
| `/api/plugins/enable` | POST | `claude plugin enable <name>` |
| `/api/plugins/disable` | POST | `claude plugin disable <name>` |
| `/api/plugins/marketplace` | GET | List configured marketplaces |
| `/api/plugins/marketplace/add` | POST | `claude plugin marketplace add <owner/repo>` |

All mutation endpoints shell out to the headless CLI and return
success/failure. After mutations, the server re-reads
`installed_plugins.json` and broadcasts updated state to all browsers.

### Web UI

A modal or sidebar panel accessible from the office toolbar. Three tabs:

**Installed** — table of installed plugins showing name, version, scope,
enabled state, and action buttons (enable/disable/remove).

**Discover** — search and browse available plugins from configured
marketplaces. Install button per plugin with scope picker.

**Marketplaces** — list configured marketplace repos. Add/remove buttons.

### Post-Install Agent Refresh

After installing or enabling a plugin, the server needs to trigger a reload
on affected agents. Options:

1. Send `/reload-plugins` as a message to the agent's session (if the
   command is SDK-reported)
2. Recreate the agent's session (heavier but guaranteed)
3. Notify the user to manually reload

Option 1 is preferred. The server can check if `reload-plugins` is in the
agent's `sdkReportedCommands` and auto-send it.

### Scope

Plugins can be installed at multiple scopes:
- **user** — global, applies to all projects
- **project** — per-project, shared with team via `.claude/settings.json`
- **local** — per-project, personal override

The UI should default to `user` scope and allow override.

### Security Considerations

- Plugin install runs arbitrary CLI code (git clone, npm install). The
  headless CLI handles this safely already.
- Marketplace trust: only official + user-added marketplaces.
- No process-level sandboxing exists in CC — same applies here.

### What This Doesn't Cover

- Building a plugin marketplace browser/search from scratch
- Plugin hook management UI (hooks fire transparently via CLI)
- LSP server management (handled by CLI)
- Plugin authoring/development tools

### Open Questions

1. Does `claude plugin search <query>` exist as a headless CLI command?
   If not, how do we populate the Discover tab?
2. Should we auto-reload all agents after a user-scope plugin install, or
   let users choose which agents to reload?
3. How should we handle plugin `userConfig` (sensitive config like API
   keys that plugins prompt for at enable time)?
