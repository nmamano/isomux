# Multi-Office Isolation

Design doc for supporting multiple isolated workspaces ("offices") within isomux.

## Problem

A single isomux instance serves one set of agents, rooms, conversations, and tasks. When multiple people access the same deployment (e.g., over a shared Tailscale network), they see and interact with the same state. There is no way to give different users their own isolated workspace.

## Chosen Design: External Hub

Instead of teaching isomux about offices internally, a separate program ("the hub") manages multiple isomux instances. Each office is a fully separate isomux process with its own state directory. The hub handles routing, process lifecycle, and per-office configuration.

### Architecture

```text
                 ┌─────────────┐
  browser ──────▶│   hub :4000 │
                 └──┬──┬──┬────┘
          unix sock │  │  │
       ┌────────────┘  │  └────────────┐
       ▼               ▼               ▼
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ isomux  │    │ isomux  │    │ isomux  │
  │ default │    │  alice  │    │  team   │
  └─────────┘    └─────────┘    └─────────┘
```

The hub is a lightweight reverse proxy + process manager. Each isomux instance is unmodified except for two small changes: configurable state root and Unix socket listening.

### URL Structure

```text
hub:4000/              → "default" office
hub:4000/o/alice/      → "alice" office
hub:4000/o/team/       → "team" office
```

The root `/` serves the `default` office directly. The hub strips the `/o/<name>` prefix before proxying, so each isomux instance sees clean `/` paths.

### Communication: Unix Domain Sockets

Each isomux instance listens on a Unix socket instead of a TCP port. No port allocation, no collisions, no firewall concerns.

```text
/tmp/isomux-hub/
  default.sock
  alice.sock
  team.sock
```

Isomux needs a `--socket /path/to/file.sock` flag (alongside the existing `--port`). Bun supports `unix:` in `Bun.serve`.

### State Layout

```text
~/.isomux-hub/
  hub.json                  # hub config (office registry)
  offices/
    default/
      config.json           # per-office env vars
      agents.json
      office-prompt.md
      tasks.json
      agents-summary.json
      recent-cwds.json
      logs/
        <agentId>/
          <sessionId>.jsonl
          sessions.json
          files/
    alice/
      config.json
      agents.json
      ...
```

Each isomux instance is launched with `ISOMUX_HOME=~/.isomux-hub/offices/<name>` (replacing the current hardcoded `~/.isomux/`).

### Office Lifecycle

**Creation:** Visiting a nonexistent office (e.g., `/o/alice/`) does not auto-create it. The hub itself (not isomux) serves a small standalone HTML page:

> Office "alice" doesn't exist yet. Create it?
> [Create]

This prevents typos from silently creating empty offices. The `default` office is pre-created and cannot be deleted.

**Naming:** Office names must be lowercase alphanumeric + hyphens, no leading/trailing hyphen, max 50 characters. Validated at creation time.

**Deletion:** Out of scope for initial implementation. Delete by stopping the process and removing the folder.

### Per-Office Environment Variables

Each office can define environment variables injected into its isomux process. This enables per-office Git identity and GitHub credentials without OS-level user separation.

Office config (`~/.isomux-hub/offices/alice/config.json`):

```json
{
  "env": {
    "GIT_AUTHOR_NAME": "Alice",
    "GIT_AUTHOR_EMAIL": "alice@example.com",
    "GIT_COMMITTER_NAME": "Alice",
    "GIT_COMMITTER_EMAIL": "alice@example.com",
    "GH_TOKEN": "ghp_..."
  }
}
```

The hub injects these into the child process environment at spawn time. Git and the GitHub CLI (`gh`) both respect these standard environment variables over global config.

### Credential Separation

The hub holds shared credentials (Claude API auth) in its own environment and passes them to all offices. Per-office config adds office-specific credentials on top.

- **Claude API auth** — shared, hub provides to all offices
- **Git/GitHub identity** — per-office, from `config.json`

Offices never need to store or know about Claude credentials.

### Isomux Changes Required

Only two changes to isomux itself:

1. **Configurable state root.** Respect `ISOMUX_HOME` env var instead of hardcoding `~/.isomux/`. Fall back to `~/.isomux/` when unset (backward compatible).
2. **Unix socket listening.** Accept `--socket /path/to/file.sock` as an alternative to `--port`. Mutually exclusive.

Isomux remains a single-office application. It has no knowledge of the hub or other offices.

### Hub Internals

**Process management:**

- On startup, scan `~/.isomux-hub/offices/`, spawn one isomux process per office
- Monitor child processes, restart on crash
- On SIGTERM, gracefully stop all children

**Reverse proxy:**

- Parse office name from URL path
- Strip `/o/<name>` prefix
- Proxy HTTP and WebSocket to the corresponding Unix socket
- Serve office creation page for unknown offices

**The hub is small.** Core is a reverse proxy + child process spawner + office creation page. A few hundred lines of TypeScript/Bun.

### Migration

On first hub startup, if an existing `~/.isomux/` directory exists and `~/.isomux-hub/` does not:

1. Create `~/.isomux-hub/offices/default/`
2. Move known files into it: `agents.json`, `office-prompt.md`, `tasks.json`, `agents-summary.json`, `recent-cwds.json`, `logs/`
3. Skip `launchers/` — ephemeral, regenerated on startup

### Isolation Escalation

The hub architecture decouples office management from isolation enforcement. The spawn mechanism is a deployment-time choice:

| Level | Mechanism                        | Isolation                        | Cost                                |
| ----- | -------------------------------- | -------------------------------- | ----------------------------------- |
| 0     | Same user, separate processes    | State dirs only                  | Zero — default                      |
| 1     | Different Linux user per office  | OS file permissions              | Pre-create users, hub needs sudo    |
| 2     | Docker container per office      | Filesystem + network + resources | Docker dependency, image management |
| 3     | MicroVM per office (Firecracker) | Full VM isolation                | Heavier infra, cloud-oriented       |

The hub's core logic (proxy + lifecycle) stays the same across all levels. Only the spawn function changes.

## Commercialization Analysis

The hub architecture enables a hosted commercial offering: run a hub in the cloud, sell office instances at a monthly price.

### Value Proposition

"Hire an AI dev office." Multiple persistent agents, collaborative task board, room-based organization, persistent memory across sessions. Not a single assistant (Cursor, Copilot) or a single autonomous agent (Devin) — a _staff_.

### What a Customer Gets

- A URL like `hub.isomux.com/o/acme/`
- Their own set of AI agents they configure and direct
- Persistent conversations, rooms, and tasks
- Their own Git/GitHub credentials configured
- Shared Claude API access (included in the subscription)

### Cost Structure

**Claude API is the primary COGS.** Each agent burns API calls. The hub supplies Claude auth, so you pay Anthropic and mark it up. This is the same model as Cursor, Windsurf, etc. Margin depends on usage patterns.

**Compute is secondary but real.** Each office runs agent processes that spawn subprocesses (bash, node, etc.). Need resource limits per office to prevent one customer from starving others.

**Pricing options:**

- Flat monthly — simple, but you eat usage variance. A power user with 8 agents running all day could cost more than they pay.
- Usage-based — accurate, but confusing UX ("why did my bill spike?").
- Hybrid (base + usage cap) — probably right, but hard to calibrate early.

### Security Requirements

Self-hosted among trusted people and multi-tenant cloud are different universes. Agents execute arbitrary code — that's the feature. Commercial hosting requires:

- **MicroVM isolation (Level 3) at minimum.** Containers are insufficient for untrusted multi-tenant code execution. Container escapes are a real attack surface. Firecracker-style microVMs are what serious code execution platforms use (Lambda, Fly.io).
- **Network isolation** so one customer's agents can't reach another's.
- **Credential security.** Customers provide repo access (GitHub OAuth, SSH keys) and agents discuss proprietary code. High-trust position. SOC2, encryption at rest, audit logs — enterprise buyers will ask.
- **Resource limits.** CPU, memory, disk per office to prevent abuse and control costs.

### Risks

**Upstream dependency.** The biggest cost center is controlled by Anthropic, who could change pricing, rate limit you, or ship their own multi-agent product. The moat must be in orchestration and workflow UX, not in "we run Claude for you."

**Competition.** Cursor, Windsurf, GitHub Copilot Workspace, Devin are all in the space with different UX models. Isomux's differentiator is the multi-agent office metaphor — but that differentiation needs to be deep enough to survive if Anthropic ships native multi-agent tooling.

**Infrastructure complexity.** The cloud version needs a control plane (office CRUD, billing, auth), an orchestrator (spinning up/down VMs), persistent storage, auto-sleep for inactive offices. This starts looking like a Kubernetes deployment, not a single binary.

### Recommended Path

1. **Now:** Make isomux excellent for self-hosted power users. Validate the multi-agent workflow. Ship the hub for self-hosted multi-office.
2. **Next:** Build community around self-hosted. Prove the workflow solves real problems.
3. **Then:** Offer hosted version for people who don't want to run infra. The hub becomes the conceptual foundation; the cloud version replaces the spawn layer with a VM orchestrator.

Commercializing too early means solving infra/security/billing problems before the product is nailed. The self-hosted path validates the core while the hub design leaves the door open.

## Alternatives Considered

### In-Process Multi-Office (Original Design)

Modify isomux internals to support multiple offices within a single process. AgentManager becomes one instance per office in a `Map<string, AgentManager>`. All API routes namespaced under `/o/:office/`. WebSocket connections tagged with office at upgrade time, broadcast scoped per-office.

**Pros:**

- Single process, simpler deployment
- No proxy hop for WebSocket latency
- No port/socket management

**Cons:**

- Significant isomux architecture changes (AgentManager singleton → map, broadcast scoping, route namespacing, frontend office parsing)
- One office crashing takes down all offices
- No process isolation — shared memory space
- Cannot run different isomux versions per office during upgrades
- Harder to evolve toward stronger isolation (Linux users, containers)

**Verdict:** More invasive to implement and harder to evolve toward commercial isolation requirements. The hub approach achieves the same user-facing result with minimal isomux changes and a clear path to stronger isolation.

### Separate Linux User Per Person

Each Tailscale user maps to a Linux user. Each user runs their own isomux instance as a systemd user service on a separate port.

**Pros:**

- True filesystem isolation enforced by the OS
- No application changes needed

**Cons:**

- Per-user binary/dependency installation, or shared `/opt/isomux` setup
- Per-user port management
- Deploying updates requires pulling code and restarting every instance
- State format changes require migrations across all user instances independently

**Verdict:** Strong isolation but high operational overhead. Better suited as a future hardening step (and available as Level 1 in the hub's isolation escalation).

### Single Process, sudo -u Per Office

Single isomux server runs as a privileged user. Each office has a `runAsUser` field. Agent processes are spawned with `sudo -u <user> claude ...`.

**Pros:**

- Single deployment, filesystem isolation for execution

**Cons:**

- Agent cwds must be under the target user's home directory
- Isomux process needs root or sudo privileges
- Cascading complexity: "home" means different things per office
- Couples the application to the OS user model

**Verdict:** Rejected. The cascading complexity of remapping paths and home directories outweighs the benefit.

### Per-Agent Linux User Field

Each agent gets a `user` field. Claude Code is spawned as that user.

**Pros:**

- Granular — different agents can run as different users

**Cons:**

- Same path/cwd problems as sudo-u per office
- No conversation or state isolation
- Mixed concern: agent config shouldn't know about OS users

**Verdict:** Rejected for the same reasons as sudo-u per office, plus no application-level isolation.

### Reverse Proxy with Tailscale Identity

nginx/caddy resolves Tailscale identity via `tailscale whois`, proxies to per-user backends.

**Pros:**

- Single URL for all users — identity is invisible
- Full isolation (separate processes)

**Cons:**

- All the operational overhead of separate instances, plus a proxy layer
- Requires Tailscale-specific infrastructure

**Verdict:** Clean UX but compounds operational overhead. Over-engineered for current scale.

### Room-Based Isolation

Rooms become the isolation boundary with access control.

**Pros:**

- Natural collaboration model

**Cons:**

- Requires an access control system
- Agents moving between rooms conflicts with isolation
- Tasks and office prompt don't belong to a room

**Verdict:** Rooms are a spatial metaphor within an office, not an isolation boundary.

### Auto-Create Office on First Visit

Navigate to `/o/alice/` and the office springs into existence.

**Pros:**

- Lowest friction

**Cons:**

- Typos create empty offices that look like data loss

**Verdict:** Rejected in favor of a confirmation page.

## Scope

### In scope (hub v1)

- Hub reverse proxy with Unix socket communication
- Office creation with confirmation page
- Per-office state isolation via separate isomux processes
- Per-office environment variables (Git/GH identity)
- Shared Claude credentials from hub
- Backward-compatible root URL serving default office
- Migration of existing `~/.isomux/` state

### In scope (isomux changes)

- `ISOMUX_HOME` env var for configurable state root
- `--socket` flag for Unix socket listening

### Out of scope

- Authentication or authorization
- Stronger isolation (Linux users, containers, microVMs) — future layers
- Office deletion UI
- Cross-office features
- Office management UI (list, rename)
- Commercial hosting infrastructure (control plane, billing, auto-sleep)
