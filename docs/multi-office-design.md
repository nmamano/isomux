# Multi-Office Isolation

Design doc for supporting multiple isolated workspaces ("offices") within a single isomux deployment.

## Problem

A single isomux instance serves one set of agents, rooms, conversations, and tasks. When multiple people access the same deployment (e.g., over a shared Tailscale network), they see and interact with the same state. There is no way to give different users their own isolated workspace.

## Chosen Design: URL-Based Offices

Each office is a fully isolated namespace within a single isomux server process. Offices share nothing — no agents, rooms, conversations, tasks, or office prompt. The office is determined by the URL path.

### URL Structure

```
auntie:4000/              → "default" office
auntie:4000/o/alice/      → "alice" office
auntie:4000/o/team/       → "team" office
```

The root `/` serves the `default` office directly. `/o/default/` is an alias for `/`.

### State Layout

```
~/.isomux/
  offices/
    default/
      agents.json
      office-prompt.md
      tasks.json
      agents-summary.json
      recent-cwds.json
      launchers/
      logs/
        <agentId>/
          <sessionId>.jsonl
          sessions.json
          files/
    alice/
      agents.json
      office-prompt.md
      ...
```

### Office Lifecycle

**Creation:** Visiting a nonexistent office (e.g., `/o/alice/`) does not auto-create it. Instead, the server returns a small standalone HTML page:

> Office "alice" doesn't exist yet. Create it?
> [Create]

This prevents typos from silently creating empty offices that look like data loss. The `default` office is pre-created and cannot be deleted.

**Naming:** Office names must be lowercase alphanumeric + hyphens, no leading/trailing hyphen, max 50 characters. Validated at creation time.

**Deletion:** Out of scope for initial implementation. Delete by removing the folder.

### API Namespacing

All API routes are namespaced under `/o/:office/`:

```
GET  /o/alice/tasks         → alice's task board
POST /o/alice/tasks         → create task in alice's office
WS   /o/alice/ws            → WebSocket for alice's office
POST /o/alice/api/upload/:agentId  → file upload
GET  /o/alice/api/files/:agentId/:filename  → serve files
```

Root-level routes (`/tasks`, `/ws`, etc.) map to the `default` office for backward compatibility.

### WebSocket Scoping

Each WebSocket connection is tagged with its office at upgrade time, based on the URL path. The server maintains a map of `office → Set<WebSocket>`. The `broadcast()` function becomes `broadcast(office, msg)`, ensuring state updates only reach clients viewing that office.

### Agent Awareness

Agents do not know about the office concept. The system prompt is templated at spawn time with the correct paths:

- Task board URL: `localhost:4000/o/alice/tasks` (or `localhost:4000/tasks` for default)
- Agent manifest: `~/.isomux/offices/alice/agents-summary.json`

Cross-office agent discovery is intentionally not supported. Each office has its own `agents-summary.json`.

### Frontend

The SPA parses the office name from `window.location.pathname`. If the path starts with `/o/`, extract the next segment; otherwise it's `"default"`. This determines the WebSocket URL to connect to.

`document.title` is set to `"isomux — alice"` (or just `"isomux"` for default) so browser tabs are distinguishable.

No office-switching UI. Users navigate between offices by URL only.

### Server Internals

**AgentManager:** The current singleton with static methods becomes one instance per office, held in a `Map<string, AgentManager>`. Each instance owns its agents, rooms, and launcher directory independently.

**Startup:** All offices are loaded eagerly. The server scans `~/.isomux/offices/`, creates an AgentManager per office, and restores agents in each. This ensures agents left running in any office are available when users reconnect.

**Safety hooks:** No change. Agents are still blocked from writing anywhere in `~/.isomux/`. Read access to the office's own `agents-summary.json` continues to work.

### Migration

On first startup after this change, if `~/.isomux/offices/` does not exist:

1. Create `~/.isomux/offices/default/`
2. Move each known file/directory into `offices/default/`:
   - `agents.json`, `office-prompt.md`, `tasks.json`, `agents-summary.json`, `recent-cwds.json`, `logs/`
3. Skip `launchers/` — it is ephemeral and regenerated on startup

The absence of the `offices/` directory is the migration trigger. No marker file needed. The move is atomic per file (rename within the same filesystem).

## Alternatives Considered

### Separate Linux User Per Person

Each Tailscale user maps to a Linux user. Each user runs their own isomux instance as a systemd user service on a separate port.

**Pros:**
- True filesystem isolation enforced by the OS (file permissions, process isolation)
- No application changes needed

**Cons:**
- Per-user binary/dependency installation, or shared `/opt/isomux` setup
- Per-user port management (`alice → :4001`, `bob → :4002`)
- Deploying updates requires pulling code and restarting every instance
- State format changes require migrations across all user instances independently
- Tight coupling to Linux — not portable to other deployment environments

**Verdict:** Strong isolation but high operational overhead, especially while the codebase is changing rapidly. Better suited as a future hardening step once the state format stabilizes.

### Single Process, sudo -u Per Office

Single isomux server runs as a privileged user. Each office has a `runAsUser` field. Agent processes are spawned with `sudo -u <user> claude ...` for OS-level execution isolation.

**Pros:**
- Single deployment, filesystem isolation for Claude Code execution

**Cons:**
- Agent cwds must be under the target user's home directory, creating a coupling between office configuration and OS user home layout
- Isomux process needs root or sudo privileges
- Cascading complexity: "home" means different things per office, path resolution becomes fragile
- Couples the application to Linux — isomux shouldn't care about the OS user model

**Verdict:** Rejected. The cascading complexity of remapping paths and home directories outweighs the benefit. Filesystem isolation is better solved at the deployment level, not the application level.

### Per-Agent Linux User Field

Each agent (not office) gets a `user` field. Claude Code is spawned as that user.

**Pros:**
- Granular — different agents can run as different users
- Simple config: one field per agent

**Cons:**
- Same path/cwd problems as sudo-u per office
- No conversation or state isolation — shared UI, shared .isomux
- Mixed concern: agent config shouldn't know about OS users

**Verdict:** Rejected for the same reasons as sudo-u per office, with the added problem of no application-level isolation.

### Reverse Proxy with Tailscale Identity

nginx/caddy on `:4000` resolves Tailscale identity via `tailscale whois` on the source IP, then proxies to per-user backend instances.

**Pros:**
- Single URL for all users — identity is invisible
- Full isolation (separate processes)

**Cons:**
- All the operational overhead of separate instances, plus a proxy layer
- Requires Tailscale-specific infrastructure

**Verdict:** Clean UX but compounds the operational overhead of per-user instances. Over-engineered for the current scale.

### Room-Based Isolation

Rooms become the isolation boundary. Users own rooms and can grant access to others.

**Pros:**
- Natural collaboration model (invite someone to a room)

**Cons:**
- Requires an access control system (who owns what, who can see what)
- Agents moving between rooms — which is an existing feature — conflicts with isolation boundaries
- Tasks, office prompt, and other state don't naturally belong to a room

**Verdict:** Rooms are a spatial metaphor within an office, not an isolation boundary. Overloading them with access control creates conflicting concerns.

### Auto-Create Office on First Visit

Navigate to `/o/alice/` and the office springs into existence.

**Pros:**
- Lowest friction — just share a URL

**Cons:**
- Typo in URL creates an empty office, which looks like data loss to the user
- No confirmation step

**Verdict:** Rejected in favor of a confirmation page ("Office X doesn't exist. Create it?") that makes typos visible before they create state.

## Scope

### In scope
- URL-based office routing
- Per-office state isolation (agents, rooms, conversations, tasks, office prompt)
- Migration of existing state to `offices/default/`
- Office creation with confirmation page
- Backward-compatible root URL serving default office

### Out of scope
- Authentication or authorization
- Filesystem isolation (deployment concern, not application concern)
- Office deletion UI
- Cross-office features (shared tasks, agent discovery, etc.)
- Office management UI (list, rename, etc.)
