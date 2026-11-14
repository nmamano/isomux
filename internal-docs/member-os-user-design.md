# Design: a member's agents on their own OS user

Board task b94dfd25. Status: design, 2026-11-14, waiting for Nil. Reviewed by Isomux Reviewer 3 (round 1: five holes closed in this version). It replaces the direction of task 01f5038c (the server moves to its own OS user, [os-user-split-design.md](os-user-split-design.md)) and reuses its runner, its `AgentHost` seam and its inventory of spawn sites (that document, sections 1-4).

## 0. Summary

- **Default: no change.** The server, its state and every agent run as the office's OS user, as today. Nothing migrates on an office that does not use the feature.
- **Opt-in, per member.** An owner turns on "Own OS user" for one member who is not an owner (an owner sets office variables and manages other members, so no OS user can fence an owner). The member's agents, terminals, apps and schedules then run as a new OS user, for example `isomux-alice`. All agents of one member share that user. No per-agent users (Nil, 2026-11-14).
- **What it gives.** The member's agents cannot read the office user's home (with `~/.isomux`: tokens, secrets, other members' sign-ins and variables) or the processes of other members, and cannot act as another agent. The member cannot use an agent that runs as the office user as a shell (section 3.1).
- **What it does not give.** The office user, and every agent that still runs as the office user, can read the isolated member's files and act as their user. Nil accepted this: the owner chooses which members to isolate. Messages to other agents stay a soft boundary.
- **Root, only for the account.** Turning it on or off needs one root command. Root makes or locks the user, its home, the share and a system unit that runs the member's runner. Root never walks or changes owner of a file tree: the member's files move through the runner. No root process stays running, and no pool of users is made in advance.
- **Collaboration.** Messages, asks, tasks, memory and history go through the office API with each agent's token, so agent-to-agent work does not change. Folders are shared with POSIX ACLs, which need no root; write sharing with an office-user agent removes the isolation (section 3.2).

## 1. Mechanism

### 1.1 One runner per isolated member

The agent runner of the split design (server/agent-runner/, on main, switched off) runs as the member's user, one process per isolated member. The server connects to it and asks it to start processes and do file work as that user. The direction is the reverse of the split: there, the server user was the trusted one and moved out; here, the server stays and the less trusted member moves out.

- **Code.** The runner, its fixed entries and the terminal sidecar are one `bun build` bundle. It lives with a copy of `bun` and the engine binaries that the office uses (Claude, Codex, OpenCode, same versions) in the member's agent space. The server writes them there through the runner, and again after each office update, by content hash. When the server has written a new bundle, the runner exits and the unit (`Restart=always`) starts the new one; that cuts the member's turns, as an office restart does. The runner env turns off each engine's own updater (`DISABLE_AUTOUPDATER=1` for Claude, and the Codex and OpenCode equivalents), so a copy never moves away from the version that the server checks. The member can change its own copy; that gives it nothing it does not have (rule below). The member user needs no read on the code tree or on anything in the office user's home.
- **Unit.** A system unit template, `isomux-member-runner@<osuser>.service`, `User=%i`, `RuntimeDirectory=isomux-runner-%i`, mode 0711, running the bundle from the member's agent space. In the container (no systemd), the entrypoint starts one runner per recorded member user while it is root.
- **Socket.** `runner.sock` in that directory, mode 0666. The runner accepts only the office uid (`SO_PEERCRED`), so the member's agents cannot drive it. Every process of the office user can connect. That is the accepted reverse direction.
- **Rule: every runner reply is member data.** The member owns the socket's directory, so any member process can replace the socket with its own listener. The server therefore treats a pid, path, home, env or file that a runner sends as data of that member: it never signals a runner-sent pid as the office user (a kill goes through the runner), never opens a runner-sent path itself, bounds every size and every wait, and sends a runner only what that member's agents may have. Slice 1 checks the 18 `process.kill` sites of the server for pids that come from a runner.
- **Server side.** `getAgentHost()` is renamed `officeAgentHost()`, and `hostFor(userId)` (server/member-hosts.ts) picks the host: the office host for a member without an OS user (and for agents without a manager), the member's `RunnerAgentHost` otherwise, and a host that fails every operation while that runner is not connected. The record of OS users is `STATE_ROOT/member-os-users.json` (server/member-os-users.ts), not users.json, so a removed member or a users.json that does not parse never moves an isolated member to the office user. An env built for an isolated member carries the member's tag: the member's host refuses any other env, and an office host refuses a tagged one. Most of the 32 call sites build an env per manager, so the manager's id is at hand; slice 1 lists the rest. The base env (HOME, USER, PATH, `XDG_RUNTIME_DIR=/run/user/<uid>`) comes from the runner, never from the server's `process.env`.
- **When the runner is down.** The member's agents do not start; the turn fails with "the member's OS user is not ready" and the Members page shows the state. The server never falls back to the office user for an isolated member.

### 1.2 Trusted checks, per member

The split design's trusted checks (section 2.4 there; server/split/trusted-checks.ts) run for each isolated member when the server connects to its runner, and the root command runs them before it reports success. For the member user:

- its uid is not 0 and not the office uid;
- it is not in any group of the office user, nor in `sudo`, `wheel`, `admin`, `adm` or `docker`;
- it has no effective search on the office user's home, and no effective write on `STATE_ROOT`, the code tree or their ancestors (mode bits and ACLs; on a self-hosted box whose home is `o+x`, the command refuses and names the `chmod`);
- it cannot become root (the installer's hardening gate, for that user).

A failed check stops that member's agents, not the office. The runner diagnostic (denied reads tried by the runner) is logged and is never the proof.

### 1.3 Files

| Area | Where | Owner | Holds |
|---|---|---|---|
| Office state | `STATE_ROOT`, unchanged | office user, 0700 | as today |
| Member agent space | `<member home>/.isomux-agent/` | member user | the runner bundle, `bun` and engine binaries; the member's `provider-homes/<userId>/`, OpenCode profiles, the codex-home of their sessions, and the data, units and env files of their apps |
| Member share | `/var/lib/isomux-share/<osuser>/` | office user, group = the member user's group, 2750 | what the server writes and the member's agents only read or run: their uploads and shown files, the Codex safety hook, the CA bundle of the secret proxy, the OpenCode authority socket |

- The share is outside the office user's home and uses the member user's own group, so one member cannot read another member's share. Root makes it once; after that the server writes into it with no root.
- Docker: member homes and shares live on the data volume, because the image keeps neither `/home` nor `/var/lib`. The office user owns `/var/data`, so the entrypoint makes one root-owned parent, `/var/data/members` (0755), and refuses to go on when it is a link or not owned by root. Homes and shares go under it.
- Workspaces stay where they are. New agents of an isolated member start in the member's home. Section 3.3 covers the agents whose folder the new user cannot reach.

### 1.4 What an office-user process opens, starts in or runs

An office-user process must never run code that an isolated member can write, and never read a path for them. Two parts:

**Paths that an isolated agent names go through its host** (the fence of the split design, section 4 there, per member):

- read-file, the editor (open, save, watch), the app thumbnail `{path}`, browser upload, Codex image views, skills in the cwd and in the engine home, the file tools that Isomux serves to agents at Folder and Web, and cwd checks;
- the `/isomux-diff` and the diff route, whole: git runs `.git/config` hooks (`core.fsmonitor`), so a diff that the server runs in an isolated agent's repo runs that agent's code as the office user;
- transcript reads and the session store (Claude fork and history), the Codex rollout walk and the OpenCode database check (the parked slice 4 of task 01f5038c);
- ask commands that a member runs, account and usage probes, and preview capture.

**An isolated member does not steer an office-user agent** (section 3.1). The folder of an agent is where its engine loads project settings, hooks, MCP config and git config, with no model in the loop.

### 1.5 Secrets and variables

- Office variables and the member's own variables reach the isolated agents as today. Other members' variables and every secret value stay in `STATE_ROOT` and in other users' processes, which the member user cannot read.
- The secret proxy serves a client that gives the proxy password, so isolated agents keep using their secrets (`HTTPS_PROXY` carries it). Placeholders are per scope and random, so a placeholder of another member is unknown to them. The CA bundle is copied into the member share.
- Headless Chrome drops the password, and the proxy's same-uid exception does not cover the member user, so a preview of a page on a secret's host gets 407. Noted, not fixed.

### 1.6 Sign-ins and the office fallback

- The member's own Claude, Codex and OpenCode sign-ins move to their agent space.
- **Claude fallback.** Today the fallback points `CLAUDE_CONFIG_DIR` at the office account's directory, so the conversation runs next to every office agent's transcripts. An isolated agent must not get that. In its place, an isolated member's agents keep their own `CLAUDE_CONFIG_DIR` and get the office credential as `CLAUDE_CODE_OAUTH_TOKEN`: a long-lived inference token that the owner makes once (`claude setup-token`, an Integrations step shown when the first isolated member has the fallback on). It only runs inference and is easy to revoke, unlike the office refresh token. It expires after one year: Integrations shows the date, and the office pages the owner before it. Slice 4 proves that the env token wins over a sign-in in the member's own config dir. Nil, 2026-11-14: that the isolated agents can read this token is a documented limit that the owner accepts with the setting.
- **Codex fallback: off for isolated members.** Codex keeps a refresh token in `auth.json`, and a refresh rotates it. A copy that the member's Codex refreshes signs the office out; a shared file that the member can write lets the member put in their own account, and then every office Codex agent sends its turns to that account. The Members page says why the setting is off.
- **OpenCode** reads its sign-in from the member's profile, which moves with the member.
- Usage readings run as the user that owns each sign-in, so they keep working.

## 2. Turning it on and off

### 2.1 What the owner sees

Settings → Members → a member → **Own OS user**. Off by default. Turning it on shows one command and what it does, in two lines. Where the office's user has sudo, a button puts the command in a terminal panel, where the owner types the sudo password. The section then shows "waiting for the command", and after it, "on: runs as `isomux-alice`", or the failed check.

The command never runs a file that the office's user can write (an agent could change it before the owner runs it as root):

- installer and Hosted: `/usr/local/sbin/isomux-member-user`, installed root-owned by the installer and the updater;
- container: the same file in the image, run with `docker exec -u 0`;
- self-hosted from a checkout: the script at the office's release tag, fetched from GitHub over HTTPS and piped to `sudo bash`.

Until the last slice ships, the server answers "not ready" on `admin.sock` and the command stops before it changes anything.

### 2.2 `isomux-member-user enable <member> [--user <osuser>]`

Root acts only on the account and on new, empty places it makes:

1. Ask the server about the member over `admin.sock` (it answers uid 0 only).
2. Create the user (default `isomux-<member slug>`, a home, no password, no extra groups) and make the share. Refuse an owner.
3. Write the runner bundle, which the server sends over `admin.sock`, into the new, empty agent space as the member user (`setpriv` with the member's uid, exclusive creates), so no `chown` is needed. Then enable the user's linger, so its apps run without a login, and write and start the runner unit. No member process runs while root writes in the home.
4. Run the trusted checks. Tell the server to go on (`admin.sock`).

The server then does the rest with no root: it stops the member's running turns, as a restart does, and refuses new ones; it streams the member's agent files from `STATE_ROOT` to the runner, which writes them as the member; it deletes its copy after the runner confirms; it records the OS user on the member, rewrites the pinned paths of the moved sessions, makes its own checks and resumes the turns. The command waits for that result and prints each agent folder that the new user cannot reach. If a step fails, the steps before it are undone.

### 2.3 `isomux-member-user disable <member> [--delete-user]`

1. The server stops the member's turns and streams their agent files back from the runner. It writes them into `STATE_ROOT` itself: no link is followed, only regular files and folders, with a size bound.
2. Root stops the runner unit, ends every process of the user (`loginctl terminate-user`), disables its linger, removes its crontab and `at` jobs, removes the share and locks the account.
3. The server runs the member's agents as the office user again.

The OS user and its home stay, locked, unless `--delete-user`. Files the member's agents made outside their agent space keep their owner.

A removed member: the office deletes their agent files through the runner, and the list of removed members shows the `disable --delete-user` command until the OS user is gone.

### 2.4 A change of manager

An owner who gives an agent to a manager on another host (or the reassignment of a deleted member's agents) moves the agent: its running turn stops, and its files move through the runner as in 2.2 or 2.3.

## 3. Working together across users

### 3.1 What an isolated member can do to office-user agents (the question for Nil)

**Owners cannot be isolated.** An owner sets office variables, which reach every office-user agent (`NODE_OPTIONS`, `LD_PRELOAD` or `GIT_CONFIG_*` would run the owner's code as the office user at the next spawn), and manages secrets, Integrations, other members and managers. The enable command and the Members page refuse an owner, and the office refuses to make an isolated member an owner until the owner runs disable.

My pick: no mechanical reach. An isolated member, their API tokens and their agents cannot:

- open a terminal on an agent that runs as the office user (that is a shell as the office user);
- change the folder, instructions, engine or schedules of an agent on another host, or set the folder of a room;
- make an agent that runs as the office user.

They still see those agents' chat and logs in shared rooms, and can message them. A message is the soft boundary of docs/isolation-model.md ("Agents of another member"): the agent treats it as data and confirms before it acts as its manager.

The other choice is that only the member's agents are isolated, and the member keeps the reach above. Then the member can read every office file through a terminal or a folder change, so the feature protects against the member's agents, not against the member.

### 3.2 Shared folders

- **ACLs, not groups.** Groups need root, so agents cannot make them. The owner of a folder grants another user access with an access ACL and a default ACL (`setfacl -R -m u:<user>:rX,d:u:<user>:rX <dir>`; `rwX` for write) and `x` on each ancestor. The other agent adds the repo to its own `git config --global safe.directory`. No shared folder is imposed (Nil, 2026-11-14).
- **Read sharing is safe; write sharing with an office-user agent is not.** git config (`core.fsmonitor`, hooks), `.claude/settings.json`, package scripts and tests in a repo run as every user that works in it, and `safe.directory` turns off git's one guard. So when an isolated member can write a folder that an office-user agent works in, the member's code runs as the office user, and the isolation is gone for that member. Write sharing between two isolated members is fine: each can only reach the other.
- **System prompt.** Once one member has an OS user, every agent gets one line: share with ACLs; read sharing is safe; write sharing with an agent on another user lets that user run code as you. An isolated agent is told its user name.

### 3.3 An agent's folder that the new user cannot reach

The agent does not start there: its turn fails with the folder and the ACL command for read sharing, and the member or an office agent shares the folder or changes the agent's folder. The enable command lists these folders.

## 4. Hosting

| Shape | Supported | Note |
|---|---|---|
| Installer (VPS) and Hosted | yes | root over SSH; the command is installed with the host tools |
| Self-hosted Linux, office as the owner's login | yes | the owner's home must not be `o+x` (trusted check) |
| Docker | yes | the entrypoint, as root, recreates the recorded member users with the same uids at each start and starts their runners; homes and shares on the volume (1.3) |
| Kubernetes | no | the pod never has root; a note in the docs (Nil, 2026-11-14) |
| macOS, local | no | |

## 5. What stays open (residual risk, for the docs)

- The office user and its agents can read and act as an isolated member (accepted).
- A message to an agent that runs as the office user with a shell can ask it to read office files for the sender (soft, as today).
- Shared memory and skills that an isolated member writes are loaded by office-user agents; a skill can ship a script that an office agent runs (soft: the agent decides to run it).
- A loopback service of the office user without its own auth is reachable from any user on the box (for example a local database with trust auth on a dev box). The office's own services (the API, OpenCode serve, the secret proxy) check a token or password.
- With the Claude fallback on, the member's agents can read the office inference token (accepted, 1.6).
- The member's agents see other users' process lists, as today; each agent session has its own PID namespace on Linux.

## 6. Slices

Each slice keeps an office with no isolated member unchanged and is tested with the two-user container rig of the split design (scripts/split-rig.sh), changed to one office user and one member user. The server answers "not ready" to the enable command until slice 4.

1. **The runner per member.** `hostFor(userId)`, the runner bundle and its update, the unit template, `isomux-member-user enable/disable` and the `admin.sock` verbs, the file moves through the runner, the per-member trusted checks, the runner-reply rule (the `process.kill` audit), and Claude, Codex and OpenCode sessions (spawn, session store, resume checks) through the member's host.
2. **The fence, the reach and the share.** Every item of section 1.4, the limits of section 3.1 (terminals, agent and room edits, spawns), the member share (uploads, shown files, the Codex hook, the authority socket, the CA bundle) and secrets.
3. **Terminals, apps, schedules, backups, removal, manager change.** Apps under the member user's systemd manager (the runner env carries `XDG_RUNTIME_DIR`); the backup streams each member's agent space through its runner, with the usual credential exclusions; section 2.4.
4. **The product.** The Members page, the office fallback (the Claude token and its expiry page, Codex off), the system-prompt lines, routes for the two agent-reference pages that tell agents to read `~/.isomux` files (discovery, cronjobs), the docs (docs/isolation-model.md, docs/security-audit.md, docs/access-and-invites.md, docs/hosting-reference.md, docs/features.md), and the switch that lets the enable command run.
