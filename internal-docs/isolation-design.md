# Isolation Architecture

How isomux scopes state, identity, and execution across multiple users on a single deployment. Three layers, each with a different boundary, enforcement mechanism, and status.

## Layers at a glance

| Layer | Boundary | What it carries | Enforced by | Status |
|-------|----------|-----------------|-------------|--------|
| Office | Separate isomux process per workspace | All state (rooms, agents, tasks, logs) | OS process boundary + state directory | Designed |
| User | Inside one office, per spawning user | Env file (Git/GH identity), per-user preferences | Application code, no OS enforcement | Implemented |
| Room | Inside one office | Per-room prompt | Application code | Implemented |
| Process | Inside one agent spawn | Filesystem view, PID table, UID, network | Linux namespaces (`bwrap`) | Scoped |

The three layers are independent and compose. Office isolation enforces that two users on the same machine see fully separate state. Room isolation lets one office host multiple identities. Process isolation closes the remaining holes (an agent in room A reading room B's env file off disk, or `ps`-ing other agents' commands).

---

## Problem

A single isomux instance serves one set of agents, rooms, conversations, and tasks. When multiple people access the same deployment (e.g., over a shared Tailscale network), they see and interact with the same state. There is no way to give different users their own isolated workspace, and within a single workspace there is no enforcement preventing one room's agents from reading another room's credentials.

This document covers the full isolation story: how offices separate users, how rooms separate identities within a user, and how Linux namespaces would close the per-process gaps.

---

## Office layer: external hub (designed)

> Status: designed, not implemented. No `~/.isomux-hub/` directory exists; the server still hardcodes `~/.isomux/` and listens on TCP only.

Instead of teaching isomux about offices internally, a separate program ("the hub") manages multiple isomux instances. Each office is a fully separate isomux process with its own state directory. The hub handles routing, process lifecycle, and per-office configuration.

### Architecture

```
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

The hub is a lightweight reverse proxy plus process manager. Each isomux instance is unmodified except for two small changes: configurable state root and Unix socket listening.

### URL structure

```
hub:4000/              → "default" office
hub:4000/o/alice/      → "alice" office
hub:4000/o/team/       → "team" office
```

The root `/` serves the `default` office directly. The hub strips the `/o/<name>` prefix before proxying, so each isomux instance sees clean `/` paths.

### Communication: Unix domain sockets

Each isomux instance listens on a Unix socket instead of a TCP port. No port allocation, no collisions, no firewall concerns.

```
/tmp/isomux-hub/
  default.sock
  alice.sock
  team.sock
```

Isomux needs a `--socket /path/to/file.sock` flag (alongside the existing `--port`). Bun supports `unix:` in `Bun.serve`.

### State layout

```
~/.isomux-hub/
  hub.json                  # hub config (office registry)
  offices/
    default/
      config.json           # per-office env vars
      agents.json
      office-config.json
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

### Office lifecycle

**Creation.** Visiting a nonexistent office (e.g., `/o/alice/`) does not auto-create it. The hub itself (not isomux) serves a small standalone HTML page:

> Office "alice" doesn't exist yet. Create it?
> [Create]

This prevents typos from silently creating empty offices. The `default` office is pre-created and cannot be deleted.

**Naming.** Office names must be lowercase alphanumeric plus hyphens, no leading or trailing hyphen, max 50 characters. Validated at creation time.

**Deletion.** Out of scope for initial implementation. Delete by stopping the process and removing the folder.

### Per-office environment variables

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

### Credential separation

The hub holds shared credentials (Claude API auth) in its own environment and passes them to all offices. Per-office config adds office-specific credentials on top.

- **Claude API auth.** Shared. Hub provides to all offices.
- **Git/GitHub identity.** Per-office, from `config.json`.

Offices never need to store or know about Claude credentials.

### Isomux changes required

Only two changes to isomux itself:

1. **Configurable state root.** Respect `ISOMUX_HOME` env var instead of hardcoding `~/.isomux/`. Fall back to `~/.isomux/` when unset (backward compatible).
2. **Unix socket listening.** Accept `--socket /path/to/file.sock` as an alternative to `--port`. Mutually exclusive.

Isomux remains a single-office application. It has no knowledge of the hub or other offices.

### Hub internals

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
2. Move known files into it: `agents.json`, `office-config.json`, `tasks.json`, `agents-summary.json`, `recent-cwds.json`, `logs/`
3. Skip `launchers/` (ephemeral, regenerated on startup)

---

## User and room layers: per-user env, per-room prompts (implemented)

> Status: shipped. Code lives in `server/agent-manager.ts`, `server/env-loader.ts`, `server/users.ts`, `server/persistence.ts`, `server/index.ts`, `ui/components/UserManagementModal.tsx`, `ui/components/RoomSettingsModal.tsx`, `ui/components/OfficePromptModal.tsx`. State is `~/.isomux/agents.json` (per-room prompt fields), `~/.isomux/users.json` (per-user envFile), `~/.isomux/office-config.json` (office-level env and prompt).

Multiple users share one isomux office (same Linux user). Each user claims a display name; their agents are stamped with `info.username` at spawn time. Identity-bearing config (env file, including Git/GitHub and provider-auth credentials) is keyed by username. Prompt customization is keyed by room.

### Prompt hierarchy: office → room → agent

Three layers, concatenated in order with clear headers. No layer overrides another; they accumulate. The agent sees all three.

- **Office prompt.** Stored in `~/.isomux/office-config.json`.
- **Room prompt.** Stored inline on `Room` in `agents.json`.
- **Agent prompt.** Stored in the agent's `customInstructions` field.

### Env hierarchy: process → office → user

Three layers. Shallow merge: later layers override matching keys from earlier ones. Unset keys fall through.

- **Process env.** Inherited from the isomux server process.
- **Office env.** Loaded from a user-specified file path in `office-config.json`.
- **User env.** Loaded from a user-specified file path on each `UserRecord` (`users.json`).

Selection is keyed by `info.username` on agents and `job.username` on cronjobs. Unowned actions (no username) get process + office only.

No per-room env. Earlier iterations stored env on `Room`, but identity is naturally per-user (the same person typically uses the same Git/provider credentials across rooms). The room-level field was migrated out in `persistence.ts`; the field is no longer on `Room`.

### Env files are user-managed, paths are absolute

Isomux does not own or manage an env directory. The user creates env files wherever they want and provides absolute paths. Isomux reads from those paths at spawn time. Standard dotenv format.

Example:

```
# /home/nil/.secrets/marc.env
GH_TOKEN=ghp_...
GIT_AUTHOR_NAME=Marc
GIT_AUTHOR_EMAIL=marc@example.com
GIT_COMMITTER_NAME=Marc
GIT_COMMITTER_EMAIL=marc@example.com
```

### Env merge semantics

At spawn time:

```
merged = { ...process.env, ...officeEnv, ...userEnv }
```

- User env beats office env beats `process.env`.
- An explicit empty-string value overrides (does not fall through). To inherit, omit the key.
- No blocklist. Office/user env can override any key, including `PATH`, `HOME`, `SHELL`. Users are responsible for the contents of their own env files.

### Env injection via SDK

The Claude Agent SDK accepts an `env` option on session creation. At spawn time, isomux reads the office and user env files, merges them, and passes the result via the SDK session options. Credentials never appear in launcher scripts or any isomux-managed file.

Spawn path (`server/env-loader.ts:buildEnvFor(username)`):
1. Read office env file (if configured), parse dotenv → `officeEnv`
2. Read user env file for `username` (if configured), parse dotenv → `userEnv`
3. Merge: `{ ...process.env, ...officeEnv, ...userEnv }`
4. Pass to the backend's `createSession({ env: mergedEnv, ... })`

`buildEnvFor` is invoked at every spawn point: Claude `createSession` and `resumeSession`, Codex `createSession` and `resumeSession`, `list_backend_models`, cronjob fire, one-shot prompt. It returns `undefined` (not merged env) when no envFile is configured, so default-path users see no behavior change.

### Spawn-time failure mode

If `envFile` is set but the file is missing, unreadable, or fails to parse, the spawn fails loudly with the error surfaced in the agent log. Silent fallback is the wrong default for a credentials feature: spawning without the expected identity would risk commits under the wrong user.

### Effect timing

Changes to prompts and env file paths take effect on the next agent conversation, not mid-session. This matches the existing office prompt behavior.

### Rooms have stable IDs

Rooms are identified by a stable `id` field (8-character random hex), not by array index. Internal only, never shown in UI. All room-targeting wire messages key by `id`. Index remains a client-side rendering concern (tab order).

### Data model

```typescript
interface Room {
  id: string;                  // stable 8-char hex, e.g. "a3f8b2e1"
  name: string;                // display name, user-editable
  prompt: string | null;       // room-level prompt
  agents: PersistedAgent[];
}

interface UserRecord {
  name: string;                // display name (lowercased for keying)
  defaultRoomId: string | null;
  notifRooms: NotifRoomsSetting;
  envFile: string | null;      // absolute path to dotenv file (Git, provider auth, etc.)
  createdAt: number;
}
```

### Per-user provider auth (Claude / Codex)

The per-user envFile is the mechanism for letting each co-tenant bill Claude/Codex against their own account, instead of sharing whatever account the host Linux user logged into. Two supported recipes per user, both as env vars in the user envFile:

**Flavor A — API-key billing** (requires an Anthropic / OpenAI API account):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

**Flavor B — OAuth subscription billing** (Claude Pro/Max, ChatGPT Plus/Pro):

```
CLAUDE_CONFIG_DIR=/home/<linux-user>/.isomux-users/<user>/.claude
CODEX_HOME=/home/<linux-user>/.isomux-users/<user>/.codex
```

Values must be absolute paths — isomux's dotenv parser does not expand `~` or `$VAR`. The shell login commands below can use `~` because the shell expands those before the CLI runs.

Each tool reads credentials from the directory the env var points at. The Claude SDK honors `CLAUDE_CONFIG_DIR`; Codex honors `CODEX_HOME`. Both are documented provider env vars, not isomux-specific.

#### Provisioning (Flavor B, one-time per user)

The user opens an isomux terminal panel (which already runs as the host Linux user), then runs the provider's login command with the env-scoped config dir. Example for Marc:

```bash
mkdir -p ~/.isomux-users/marc/.claude && chmod 700 ~/.isomux-users/marc/.claude
CLAUDE_CONFIG_DIR=~/.isomux-users/marc/.claude claude auth login

mkdir -p ~/.isomux-users/marc/.codex && chmod 700 ~/.isomux-users/marc/.codex
CODEX_HOME=~/.isomux-users/marc/.codex codex login
```

The CLI prints an OAuth URL; the user opens it in their own browser, signs in with their own Anthropic / OpenAI account, the token lands in the per-user dir. The user then appends the env-var lines above to their envFile, using **absolute paths** — isomux's dotenv parser does not expand `~` or `$VAR`.

Direct SSH as the host user is an alternative path for users with their pubkey authorized; users without shell access can have the operator run the login command on the host while they complete OAuth in their own browser.

#### Filesystem layout (Flavor B)

```
~/.claude/.credentials.json         # host user's own creds (unchanged)
~/.isomux-users/marc/.claude/       # Marc's Claude config dir
  .credentials.json
  projects/                         # session files for Marc's agents
~/.isomux-users/marc/.codex/        # Marc's Codex home
  auth.json
  sessions/                         # rollouts for Marc's agents
```

Isomux's own session-file preflights (`server/cwd-utils.ts:claudeProjectDir`, `claudeSessionFileExists`, `moveClaudeSessionFiles`, `diagnoseProcessExit`, plus Codex's `codexSessionsDir`) honor the same env vars, so resume preflights resolve against the same directories the spawned subprocesses use.

#### What this enables and what it does not

This setup prevents *accidental* account mixing and lets each user bill provider usage to their own account. It is **not** a security boundary:

- Every user's per-user config dir lives under the host Linux user's `$HOME`. Anyone with shell access as the host user can read every credentials file. `chmod 700`/`600` is recommended but only protects against access from *other* Unix users on the box.
- An in-band agent process running under the host user can also read sibling config dirs unless an OS-level isolation layer (Level 1+ in the escalation matrix below) is added.

This layer is appropriate for trusted co-tenants who want clean billing separation, not for adversarial multi-tenancy.

### What this layer does *not* enforce

- An agent stamped with user A can `cat /home/nil/.secrets/team-b.env` if it knows the path.
- An agent can `ps aux` and see other agents' command lines.
- An agent can read another user's `customInstructions` from `~/.isomux/agents.json` or another user's per-user provider config dir.

Closing these gaps is the job of the process layer.

---

## Process layer: Linux namespaces (scoped)

> Status: scoped, not implemented. This section evaluates the design space and recommends a smallest-useful first slice.

Process-layer isolation puts each agent spawn into Linux namespaces so the OS enforces what the application layer cannot: filesystem visibility, PID visibility, user identity, and (optionally) network reach.

### What namespaces buy

| Namespace | Effect for an agent | Necessary? |
|-----------|---------------------|------------|
| `mount` | Sees only its own cwd subtree plus read-only system paths. Other rooms' env files invisible. | Yes. The main payoff. |
| `user` | Distinct subordinate UID per scope; FS perms enforce separation even on shared paths. | Yes. Without it, `chmod` is meaningless across scopes. |
| `pid` | Cannot `ps` other agents, cannot read `/proc/<other>/environ`. | Yes. Cheap. |
| `net` | Per-scope egress policy (e.g., a token cannot be exfiltrated to `attacker.example`). | Optional. Biggest complexity jump. |
| `uts`, `ipc`, `cgroup`, `time` | Marginal value for this use case. | Skip. |

### Where to apply this

The smallest unit isomux spawns is the agent: each agent runs its own claude process via `unstable_v2_createSession` (`server/agent-manager.ts:999-1052`). Two reasonable scopes:

1. **Per-office.** Slot in as Level 2 of the escalation table below. The hub's spawn function wraps each isomux child process in namespaces. All agents in an office share the namespace.
2. **Per-room.** Each agent in a room shares the namespace; agents in different rooms do not. Requires committing to "room = identity = isolation domain."
3. **Per-agent.** Maximum isolation, but no shared identity within a room. Probably overkill given the per-room env design.

The recommendation is **per-office first** (Section "Recommendation" below).

### Implementation sketch

`Bun.spawn` does not take namespace flags, and the SDK's `pathToClaudeCodeExecutable` is what gets exec'd. The wrapping point is a launcher script set as `pathToClaudeCodeExecutable`, which then re-execs claude under namespaces.

Two realistic tools:

- **`bwrap` (bubblewrap).** Single static binary, uses unprivileged user namespaces, no setuid needed on modern kernels. Used by Flatpak. Composable on the command line. The right pick.
- **Custom `unshare(CLONE_NEW*)` plus `pivot_root`.** More control, more code, more bugs. Skip unless `bwrap` proves insufficient.

Conceptual launcher (per-office, mount + pid + user, no network isolation):

```sh
exec bwrap \
  --unshare-pid --unshare-uts --unshare-ipc \
  --share-net \
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --bind "$AGENT_CWD" "$AGENT_CWD" \
  --ro-bind "$ROOM_ENV_FILE" "$ROOM_ENV_FILE" \
  --proc /proc --dev /dev \
  --uid "$ROOM_UID" --gid "$ROOM_GID" \
  -- claude "$@"
```

The launcher is generated per-spawn so cwd, env file path, and UID can vary.

### Hard parts (where this gets expensive)

1. **Cwd freedom.** Today agents pick any cwd via `recent-cwds.json` and roam outside it. A mount-isolated agent can only see what was bind-mounted at spawn. You either constrain cwd to a per-scope root, or accept that "scope" effectively means "this one repo subtree."
2. **Cross-scope references.** Agents read each other's logs via `~/.isomux/agents-summary.json` and `~/.isomux/logs/<id>/...`. Mount isolation breaks that unless `~/.isomux` is bind-mounted read-only into every scope, which then re-leaks credentials stored there. Per-scope secrets need to live outside `~/.isomux` (which the per-office hub design already does: each office has its own state dir).
3. **Moving an agent between scopes.** Currently a metadata flip in `agents.json`. Under namespace isolation, moving scopes means tearing down the namespace and rehydrating with a different UID/mount view. Workable but the user-visible "drag agent to new room" gesture now has session-restart semantics.
4. **Tools the agent invokes.** `bun`, `git`, `gh`, MCPs all run inside the namespace and need to be present on the bound paths (i.e., system bin/lib mounts). Standard for `bwrap` but worth budgeting for the test matrix.
5. **No root required if** the kernel permits unprivileged user namespaces. Default true on most modern distros, but some Debian/Ubuntu configs have toggled this off. Probe `/proc/sys/kernel/unprivileged_userns_clone` at startup and surface a clear error if disabled.

### Architectural tension: room as isolation boundary

The "Alternatives considered" section below rejects rooms as an isolation boundary on the grounds that "agents moving between rooms conflicts with isolation" and "rooms are a spatial metaphor." However, the room env layer (already shipped) makes rooms an *identity* boundary. There is some tension already.

Going room-isolation at the namespace layer would require committing fully: rooms become first-class isolation domains, agents cannot trivially move between rooms, and disk views diverge per room. That commitment is bigger than the namespace work itself.

Going office-isolation at the namespace layer is purely additive: it hardens an already-decided boundary. No design questions to relitigate.

### Recommendation

Start at the office layer, not the room layer. Two reasons:

1. The architectural question is already settled one level up. The hub designates office as the isolation boundary. Implementing namespaces as the spawn mechanism for the hub's office processes (Level 2 of the escalation table) is the lower-controversy version of the same engineering work. The hard parts (launcher generation, mount layout, user namespace mapping, kernel feature check) are identical, but you do not have to relitigate "what is a room."
2. If after that you still want intra-office room isolation, you are layering a second sandbox inside an already-sandboxed office. Cleaner to reason about than "room is sometimes an identity, sometimes not."

The smallest useful first slice:

- `bwrap`-based launcher with `mount` + `pid` + `user` namespaces (skip `net`).
- Bound at the office level, behind a per-office `isolation: "bwrap"` config flag.
- Roughly: ~150 lines of launcher generation in the hub or a new `server/launcher.ts`, ~50 lines of bind-mount policy (system paths + per-office cwd + per-office state dir), ~20 lines of kernel feature probe with a clear error if `userns_clone` is disabled.
- Manual test matrix: git, gh, bun, MCP, file write inside cwd, file read outside cwd should fail.

---

## Isolation escalation matrix

The hub architecture decouples office management from isolation enforcement. The spawn mechanism is a deployment-time choice. Each level builds on the previous.

| Level | Mechanism | Isolation gained | Cost |
|-------|-----------|------------------|------|
| 0 | Same user, separate processes | State dirs only | Zero. Default. |
| 1 | Different Linux user per office | OS file permissions | Pre-create users, hub needs sudo. |
| 2 | Linux namespaces (`bwrap`) per office | Filesystem view, PID, optional network | Single static binary, no root. **Recommended next step.** |
| 3 | Docker container per office | Filesystem + network + resources, packaged | Docker dependency, image management. |
| 4 | MicroVM per office (Firecracker) | Full VM isolation | Heavier infra, cloud-oriented. |

The hub's core logic (proxy plus lifecycle) stays the same across all levels. Only the spawn function changes.

---

## Commercialization analysis

The hub architecture enables a hosted commercial offering: run a hub in the cloud, sell office instances at a monthly price.

### Value proposition

"Hire an AI dev office." Multiple persistent agents, collaborative task board, room-based organization, persistent memory across sessions. Not a single assistant (Cursor, Copilot) or a single autonomous agent (Devin). A *staff*.

### What a customer gets

- A URL like `hub.isomux.com/o/acme/`
- Their own set of AI agents they configure and direct
- Persistent conversations, rooms, and tasks
- Their own Git/GitHub credentials configured
- Shared Claude API access (included in the subscription)

### Cost structure

**Claude API is the primary COGS.** Each agent burns API calls. The hub supplies Claude auth, so you pay Anthropic and mark it up. This is the same model as Cursor, Windsurf, etc. Margin depends on usage patterns.

**Compute is secondary but real.** Each office runs agent processes that spawn subprocesses (bash, node, etc.). Need resource limits per office to prevent one customer from starving others.

**Pricing options:**
- Flat monthly: simple, but you eat usage variance. A power user with 8 agents running all day could cost more than they pay.
- Usage-based: accurate, but confusing UX ("why did my bill spike?").
- Hybrid (base + usage cap): probably right, but hard to calibrate early.

### Security requirements

Self-hosted among trusted people and multi-tenant cloud are different universes. Agents execute arbitrary code; that is the feature. Commercial hosting requires:

- **MicroVM isolation (Level 4) at minimum.** Containers are insufficient for untrusted multi-tenant code execution. Container escapes are a real attack surface. Firecracker-style microVMs are what serious code execution platforms use (Lambda, Fly.io).
- **Network isolation** so one customer's agents cannot reach another's.
- **Credential security.** Customers provide repo access (GitHub OAuth, SSH keys) and agents discuss proprietary code. High-trust position. SOC2, encryption at rest, audit logs: enterprise buyers will ask.
- **Resource limits.** CPU, memory, disk per office to prevent abuse and control costs.

### Risks

**Upstream dependency.** The biggest cost center is controlled by Anthropic, who could change pricing, rate limit you, or ship their own multi-agent product. The moat must be in orchestration and workflow UX, not in "we run Claude for you."

**Competition.** Cursor, Windsurf, GitHub Copilot Workspace, Devin are all in the space with different UX models. Isomux's differentiator is the multi-agent office metaphor, but that differentiation needs to be deep enough to survive if Anthropic ships native multi-agent tooling.

**Infrastructure complexity.** The cloud version needs a control plane (office CRUD, billing, auth), an orchestrator (spinning up/down VMs), persistent storage, auto-sleep for inactive offices. This starts looking like a Kubernetes deployment, not a single binary.

### Recommended path

1. **Now.** Make isomux excellent for self-hosted power users. Validate the multi-agent workflow. Ship the hub for self-hosted multi-office.
2. **Next.** Build community around self-hosted. Prove the workflow solves real problems.
3. **Then.** Offer hosted version for people who do not want to run infra. The hub becomes the conceptual foundation; the cloud version replaces the spawn layer with a VM orchestrator.

Commercializing too early means solving infra/security/billing problems before the product is nailed. The self-hosted path validates the core while the hub design leaves the door open.

---

## Alternatives considered

### In-process multi-office

Modify isomux internals to support multiple offices within a single process. AgentManager becomes one instance per office in a `Map<string, AgentManager>`. All API routes namespaced under `/o/:office/`. WebSocket connections tagged with office at upgrade time, broadcast scoped per-office.

**Pros:**
- Single process, simpler deployment
- No proxy hop for WebSocket latency
- No port/socket management

**Cons:**
- Significant isomux architecture changes (AgentManager singleton → map, broadcast scoping, route namespacing, frontend office parsing)
- One office crashing takes down all offices
- No process isolation, shared memory space
- Cannot run different isomux versions per office during upgrades
- Harder to evolve toward stronger isolation (Linux users, containers)

**Verdict:** More invasive to implement and harder to evolve toward commercial isolation requirements. The hub approach achieves the same user-facing result with minimal isomux changes and a clear path to stronger isolation.

### Separate Linux user per person

Each Tailscale user maps to a Linux user. Each user runs their own isomux instance as a systemd user service on a separate port.

**Pros:**
- True filesystem isolation enforced by the OS
- No application changes needed

**Cons:**
- Per-user binary/dependency installation, or shared `/opt/isomux` setup
- Per-user port management
- Deploying updates requires pulling code and restarting every instance
- State format changes require migrations across all user instances independently

**Verdict:** Strong isolation but high operational overhead. Better suited as a future hardening step (Level 1 in the escalation matrix).

### Single process, sudo -u per office

Single isomux server runs as a privileged user. Each office has a `runAsUser` field. Agent processes are spawned with `sudo -u <user> claude ...`.

**Pros:**
- Single deployment, filesystem isolation for execution

**Cons:**
- Agent cwds must be under the target user's home directory
- Isomux process needs root or sudo privileges
- Cascading complexity: "home" means different things per office
- Couples the application to the OS user model

**Verdict:** Rejected. The cascading complexity of remapping paths and home directories outweighs the benefit.

### Per-agent Linux user field

Each agent gets a `user` field. Claude Code is spawned as that user.

**Pros:**
- Granular: different agents can run as different users

**Cons:**
- Same path/cwd problems as sudo-u per office
- No conversation or state isolation
- Mixed concern: agent config should not know about OS users

**Verdict:** Rejected for the same reasons as sudo-u per office, plus no application-level isolation.

### Reverse proxy with Tailscale identity

nginx/caddy resolves Tailscale identity via `tailscale whois`, proxies to per-user backends.

**Pros:**
- Single URL for all users; identity is invisible
- Full isolation (separate processes)

**Cons:**
- All the operational overhead of separate instances, plus a proxy layer
- Requires Tailscale-specific infrastructure

**Verdict:** Clean UX but compounds operational overhead. Over-engineered for current scale.

### Room-based isolation (without namespaces)

Rooms become the isolation boundary with access control at the application layer.

**Pros:**
- Natural collaboration model

**Cons:**
- Requires an access control system
- Agents moving between rooms conflicts with isolation
- Tasks and office prompt do not belong to a room
- Application-layer access control does not stop a misbehaving agent from reading another room's credentials off disk

**Verdict:** Rooms are a spatial metaphor within an office, not an isolation boundary by themselves. The room env layer (shipped) makes rooms an *identity* boundary. Hardening that identity boundary at the OS level is what the namespace section addresses, with the recommendation to do it at the office layer first.

### Auto-create office on first visit

Navigate to `/o/alice/` and the office springs into existence.

**Pros:**
- Lowest friction

**Cons:**
- Typos create empty offices that look like data loss

**Verdict:** Rejected in favor of a confirmation page.

### Per-agent env vars

Add `envFile` to each agent.

**Pros:**
- Maximum granularity

**Cons:**
- Identity is naturally per-room (all agents in a room act as the same user); per-agent env makes the model harder to reason about without a clear use case

**Verdict:** Trivially addable later (new field on the agent type) if a real need surfaces.

---

## Out of scope

- Authentication or authorization at the hub layer
- Office deletion UI
- Cross-office features
- Office management UI (list, rename)
- Commercial hosting infrastructure (control plane, billing, auto-sleep)
- Encryption at rest (inherent limitation of single Linux user; real isolation needs the hub plus namespaces)
- Validating env file contents beyond basic dotenv parsing (key names, value shapes, duplicate detection)
- Prompt stack inspector (read-only "full stack" inspector that shows Office + Room + Agent concatenated)
- Network namespaces in the first namespace slice (Level 2 first iteration shares host network)
