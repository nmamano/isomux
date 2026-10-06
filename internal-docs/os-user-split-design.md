# Design: the server gets its own OS user

Board task 01f5038c. Loop file: [os-user-loop.md](os-user-loop.md). Status: slice-1 design, written 2026-10-06. Items marked **PM** need a ruling from Isomux PM. Items marked **PARKED FOR NIL** are product tradeoffs.

Line numbers are from main at fbfe9335.

## 0. Summary

- **Two users.** The server user runs `bun server/isomux-office.ts` and owns the state, the credentials and the server code. The agent user runs everything that the office starts for a member or an agent.
- **Direction: the server moves out.** On an existing install, the agent user is the user that runs the office today (`isomux` on the installer, `node` in the container, the owner on a self-hosted box). A new user takes the server. Workspaces, provider sign-ins, app units and agent homes stay where they are. Only the server's state and the code change owner.
- **Mechanism: an agent runner.** This is a long-lived process that runs as the agent user and listens on a Unix socket. The server tells it to start processes and to do file operations in agent space. It needs no setuid, no sudo and no capability, so it works with `NoNewPrivileges` and on Kubernetes.
- **The switch.** When `ISOMUX_AGENT_RUNNER` (the socket path) is not set, the server works as today: it uses one user and spawns in process. Existing installs keep working with no action (ruling 3). Until the last slice lands, split mode is for the test rig only (section 8). No release offers it, and no slice before the last one claims a boundary.
- **The fence (ruling 5).** In split mode, every read, write or watch at a path that an agent names goes through the runner. The kernel then applies the agent user's permissions. The fence needs no denylist.
- **The proof.** Ownership and mode checks that the server makes itself, plus real two-user denial tests, establish the boundary. The runner's own report is a diagnostic only (section 2.4).

## 1. Process inventory

"Agent" means the process must run as the agent user. "Server" means it can stay with the server user.

Today every agent-facing env comes from `buildEnvForUserId` (server/env-loader.ts:82-112). It starts from the server's `process.env` (:98). In split mode the base env must be the runner's env (the agent user's HOME, USER, PATH) and never the server's `process.env`.

| # | Process | Spawn site | Run as | Note |
|---|---|---|---|---|
| 1 | Claude Code child, sessions | SDK `query()` server/backends/claude.ts:628,637; options from `buildSdkOpts` :1461 | agent | The SDK spawns the binary itself. See section 2.1 for the hook. |
| 2 | Claude one-shot (topic) | claude.ts:654 via :1678 | agent | Reads the provider sign-in. |
| 3 | Claude account and usage probes | server/backends/claude/account.ts:60-70; server/office-usage.ts:144-150 | agent | Same binary. They read and write sign-ins in agent space. |
| 4 | Codex app-server, all uses | one seam: `JsonRpcLiteClient.start` server/backends/codex/client.ts:190 | agent | Sessions, model list, one-shot, fork, read, account, usage probe, trust probe. |
| 5 | Codex safety hook | grandchild of #4 | agent | The binary is at `STATE_ROOT/bin`, mode 0700 (safety-hook-install.ts:22-29). The agent user cannot run it there. See section 3. |
| 6 | OpenCode helper and `opencode serve` | server/backends/opencode/supervisor.ts:309 (`flock … bun start-server.ts`), then start-server.ts:183 | agent | The serve process outlives its helper by design. The runner must support a detached spawn. |
| 6b | OpenCode stop helper | supervisor.ts:258 (`performShutdown`, the same helper command) | agent | It signals the serve process, which belongs to the agent user. |
| 7 | Terminal PTY sidecar and shell | server/terminal.ts:151 (`node pty-sidecar.cjs`); env at :126-137 | agent | Today HOME is forced to the server's `homedir()` (:130,135). It must be the agent user's HOME. |
| 7b | Real-Node probe (`node -e …`) | terminal.ts:46 (`probeRealNode`) | agent | It picks the `node` that runs #7, so it must resolve `node` on the agent user's PATH. |
| 8 | App processes, installer and dev boxes | `systemctl --user` through `createSystemdHost().run` server/app-supervisor.ts:201-216; units in `~/.config/systemd/user` (:172-176) | agent | The app command runs under the user manager of the user that calls `systemctl --user`. In split mode the runner calls it, so apps run under the agent user's manager. |
| 9 | App processes, container | `python3 supervisor.py client` server/container-app-supervisor.ts:29; the app is started by deploy/container/supervisor.py:112 | agent | The entrypoint starts supervisor.py as the agent user. The server's client call goes through the runner (control.sock belongs to the agent user). |
| 10 | Preview capture (headless Chrome) | server/preview-capture.ts:274 | agent | It runs page JS for any URL an agent names. The PNG comes back through the runner. |
| 11 | `git` for `/isomux-diff` and the diff route | server/isomux-diff.ts:110, `execSync` through a shell in the agent cwd | agent | **Escape after the split if left as server.** The agent controls `.git/config` (`core.fsmonitor`, `diff.external`, textconv), so it could run code as the server user. The git process is not the only problem. `computeIsomuxDiff` also opens and stats untracked paths in the server process (isomux-diff.ts:335-350), so an untracked symlink to a file outside the repo puts that file in the result. Reviewer 2 showed this with a synthetic repo on 2026-10-06. In split mode the whole `computeIsomuxDiff` runs as the agent user: the runner runs a fixed server-code entry that returns the result as JSON. |
| 12 | `claude auth status` probe (macOS only) | server/backends/claude-install-check.ts:147 | n/a | macOS stays single-user (section 5). |
| 13 | Log search child | server/log-search-runner.ts:49 | server | It reads `STATE_ROOT/logs` only. |
| 14 | Backup (`tar`, `df`) | server/backup.ts:104,115,374 | server | See section 3 for app data. |
| 15 | Update trigger | server/update-trigger.ts:131 (`systemctl start isomux-update@…`, `systemd-run --user`, `update-client.py`) | server | The polkit rule names the user that triggers (deploy/install.sh:3329-3342). It changes to the server user. |
| 16 | Version `git` | server/version.ts:35, on the server checkout | server | |
| 17 | Codex safety-hook build and stamp | server/backends/codex/safety-hook-build.ts:73,101; safety-hook-install.ts:79 | server | The output goes to the share dir (section 3). |
| 18 | `sysctl` (macOS OpenCode) | server/backends/opencode/runtime.ts:69 | n/a | macOS only. |

The inventory found no other runtime spawns. The inventory search covered `spawn`, `spawnSync`, `exec*`, `fork`, `Bun.spawn*`, `Bun.$`, pty and `new Worker` in server/, tests excluded. Probes that run only as standalone scripts (hook-latency-probe.ts, safety-hook-benchmark.ts) are not runtime.

## 2. Spawn mechanism

### 2.1 How each backend lets the caller control the spawn

- **Claude.** SDK 0.3.287 has `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2442). `SpawnOptions` carries `command, args, cwd, env, signal` (:9477). `SpawnedProcess` needs `stdin`, `stdout`, `killed`, `exitCode`, `kill()` and `on/once/off` for `exit` and `error` (:9425-9470). No server code uses the hook today. The single wrap point is `buildSdkOpts` (claude.ts:1461) plus the one-shot and probe call sites (#2, #3).
- **The SDK also touches files in process.** `forkSession` and `getSessionMessages` go through `claudeSessionStore` (server/backends/claude/session-store.ts:16-58). It reads `<projectDir>/<sid>.jsonl` and writes a forked transcript with mode 0600 (:51-55). In split mode the server user cannot read the agent user's transcripts. The forked file would also belong to the wrong user. `load` and `append` must go through the runner. The store is already a seam.
- **Codex.** All spawns go through `JsonRpcLiteClient.start` (client.ts:190). It is a plain `spawn` with a process group (`detached: true`). Wrap it there.
- **OpenCode.** Wrap the helper spawn (supervisor.ts:309). The helper then spawns `opencode serve` as the same user.

### 2.2 Candidates

1. **sudoers rule** (`<server> ALL=(<agent>) NOPASSWD:SETENV: ALL`). This needs the least new code: real pipes and ptys, and signals relayed by sudo. Against it:
   - The installer's hardening gate fails on any `NOPASSWD` entry for the service account (deploy/install.sh:1455-1458).
   - sudo is setuid. It cannot work with `NoNewPrivileges=yes` on the server unit, or on Kubernetes, where `allowPrivilegeEscalation: false` (deploy/kubernetes/deployment.yaml:79-81).
   - The container image has no sudo.
   - Each spawn writes an auth-log line and opens a PAM session.
   - File reads in agent space would still need a per-read sudo or a helper.
   - internal-docs/isolation-design.md:534-547 rejected "sudo -u per office" because the home of each office was different. Here there is one agent user, so that cost is smaller. The privilege cost stays.
2. **Root helper on a socket**, like the container-update helper (install.sh:4559-4591). The pattern exists, but it allows only one fixed verb with a 256-byte request. A spawn helper must accept argv, env and cwd and hand back stdio. Bun cannot receive file descriptors (no `SCM_RIGHTS`), so the helper must proxy stdio, and a root process would hold that proxy code. This puts the largest attack surface in root code. It does not work on Kubernetes (no root).
3. **systemd-run `--uid`**. This needs root or a polkit grant. A polkit rule cannot limit the target uid of a transient unit. There is no systemd in the container image, and stdio works only through `--pipe` or `--pty`.
4. **Capabilities** (`CAP_SETUID`, `CAP_SETGID` on the server unit). Then the server can become uid 0, so a server compromise becomes root. This is not acceptable on the installer.
5. **Agent runner (recommended).** This is a Bun process that runs as the agent user and listens on a Unix socket. The server connects. The runner checks the peer uid with `SO_PEERCRED` and accepts only the server uid. The precedent is server/unix-socket-server.ts:116-135, as used by server/admin-socket.ts:48-77. It spawns processes and does agent-space file operations, and it proxies stdio over the connection.
   - It needs no privilege anywhere.
   - It works with `NoNewPrivileges`, in the container and on Kubernetes (as a sidecar).
   - One component serves both the spawn need and the fence.
   - The model is the same as the container's app supervisor (container-app-supervisor.ts:1-34): a private Unix RPC to a process outside the server.

### 2.3 The agent runner

- **Code.** The runner lives at `server/agent-runner/` in the same checkout. The agent user reads the code but cannot write it. On the server side, an `AgentHost` interface has two implementations: `LocalAgentHost` (today's in-process behavior) and `RunnerAgentHost`. The spawn sites in section 1 and the agent-space file operations in section 3 call `AgentHost`. They never call `spawn` or `fs` directly.
- **Connection.** There is one Unix-socket connection per spawned process, plus one connection for file operations.
  - The first frame is a JSON request: `{argv, cwd, env, pty?, detached?}`. The runner never uses a shell.
  - After that, length-prefixed frames carry stdin, stdout, stderr, `signal`, `resize` and `exit`.
  - When the connection closes, the runner kills the process group, except for a `detached` spawn (OpenCode serve). This keeps today's lifecycle: a server restart ends agent turns as it does now.
- **SDK adapter.** `spawnClaudeCodeProcess` returns an object that implements `SpawnedProcess` over a connection. Codex `start()` and the PTY get similar adapters.
- **File operations.** These are `stat`, `readFile` (with a byte cap), `writeFile` (exclusive, or with an expected mtime), `mkdir`, `unlink`, `readdir`, `realpath`, `watch` and `home`. Each one runs as the agent user.
- **Fixed entries.** Some server work in agent space is more than one file operation: the diff (#11) and the OpenCode database check (section 3.2). For these, the runner runs a fixed entry from the server code (`bun server/agent-runner/entries/<name>.ts`) as the agent user and returns its JSON result. The server treats the result as agent-space data.
- **Socket ownership.**
  - The runner binds `runner.sock` in its systemd `RuntimeDirectory` (`/run/isomux-agent-runner`, agent:`<agent group>`, mode 0750), with socket mode 0660 and the group `<agent group>`. The server user is a member of `<agent group>` (section 3.1.1), so it can pass through the directory and connect. Other agent-user processes can also connect, but the runner refuses every peer uid except the server uid (`SO_PEERCRED`). In the container, the entrypoint (root) creates the directory with the same owner and mode.
  - The agent user owns that directory, so an agent can replace the socket. The trust-direction item below covers that case.
  - Socket activation (a root-owned directory and a socket that systemd passes in) would remove the swap. It needs Bun to listen on an inherited file descriptor, which is unchecked. Slice 1 checks it. If it works, the units use it.
- **Trust direction.** The server trusts nothing that the runner returns beyond "this is agent-space data". A process that impersonates the runner gets only data that is meant for the agent user. An agent can stop the runner, because it is the same uid. That is a denial of service, and systemd restarts the runner.

### 2.4 Proof of the boundary

An agent can impersonate the runner, so the runner cannot prove that its own uid is denied. The proof has two parts that do not depend on the runner.

**Trusted checks.** The server makes these checks itself at start in split mode. The migration command and the updater make them too. If one fails, the server does not start in split mode. It logs the failed check. It does not fall back to single-user mode.

- The agent uid is not 0 and is not the server uid.
- The server user's primary group is not among the agent user's groups (`id -G <agent>`). The opposite direction is intended: the server user is a member of `<agent group>`.
- **Private areas** are `STATE_ROOT`, the code tree and the ancestors of `STATE_ROOT`, `SHARE_ROOT` and the code tree.
  - Each entry is owned by root or the server user, never by the agent uid.
  - The agent user has no effective write on any entry. `STATE_ROOT` itself is mode 0700, so the agent has no read or search either.
  - "Effective" means the check reads the mode bits for owner, group (with the agent user's groups) and other, and also every POSIX ACL entry, including named-user and named-group grants and the mask. A symlink is checked at its resolved target, and so are the target's ancestors.
  - Ancestors matter because an owner of a parent directory can rename a child and put a different one in its place. For example, the image chowns `/var/data` to `node` (deploy/container/Dockerfile:9), so the container split must change that owner (section 6).
- **The share** is `SHARE_ROOT` and everything below it. Each entry is owned by the server user, with group `<agent group>`. Each directory keeps the setgid bit. For directories and regular files, the agent user has no effective write (the same mode, ACL and symlink rules). The one exception is `authority/authority.sock`. It must allow group write (0660), because a process needs write permission on a socket to connect to it. Its parent directory stays without agent write, and the broker's peer-uid check applies to every connection. Any other socket or entry type in the share fails the check.
- **Depth.** At start the server checks `STATE_ROOT`, the share, the ancestors and the top two levels of the code tree. `isomux-split-users --check` walks the full code tree. The migration and every update run it, and a failure stops them. The rig tests a deep code entry with `--check` and a top-level entry at start.
- The agent user cannot reach root. The installer's hardening gate (install.sh:1834-1867) runs for the agent user too.

**Runner diagnostic.** After the trusted checks pass, the server asks the runner to try a few denied operations. Each try must fail with `EACCES` or `EPERM`. Any other result (success, `ENOENT`, `EISDIR`, a transport error) is reported as "not proven" and the server logs it. A diagnostic never turns a failed trusted check into a pass. The tries are:
- read `STATE_ROOT/users.json`;
- open an existing code file for writing (`O_WRONLY`, no `O_TRUNC`, for example `<code>/package.json`);
- rename a code directory entry;
- create a file in `SHARE_ROOT`.

An `O_WRONLY` open on a directory fails with `EISDIR` even when the directory is writable (Reviewer 2, 2026-10-06), so the diagnostic never uses a directory open as a write test.

## 3. Files

### 3.1 Three areas

| Area | Owner and mode | Contents |
|---|---|---|
| **Server state** `STATE_ROOT` | server user, 0700 | Everything in `~/.isomux` today except the agent-space subtrees. This includes users, sessions, invites, API tokens, `user-env/`, `office-env/`, webhook secrets, pager settings, logs, cronjobs, memory, tasks, `provider-account-state.json`, `apps/apps.json`, `apps/app-tokens.json` (hashes) and `apps/thumbnails/`. |
| **Share** `SHARE_ROOT` | see section 3.1.1 | Files that the server writes and the agent user only reads, runs or connects to: `files/<agentId>/` (uploads and shown files), `bin/` (the Codex safety hook, today `STATE_ROOT/bin` at 0700, safety-hook-install.ts:22-29,509), and `authority/` (the OpenCode authority socket). |
| **Agent space** `AGENT_ROOT` | agent user | `provider-homes/` (server/provider-homes.ts:35-56), `codex-home/` (the office `CODEX_HOME`, server/backends/codex/native-bin.ts:35-36), the `bin/codex` wrapper that terminal cards name (native-bin.ts:185-222), `opencode/profiles/` (sign-ins inside), `apps/data/<name>`, `apps/units/<name>.sh` and `.env` (they hold the plaintext app token, as today), the agent user's `~/.claude`, `~/.codex` and `~/.config/systemd/user`, and all workspaces. |

In single-user mode, `AGENT_ROOT = SHARE_ROOT = STATE_ROOT`, so nothing moves.

In split mode, `AGENT_ROOT` is the old state root: the path that `STATE_ROOT` had before the migration. Usually that is `<agent home>/.isomux`. It can be a custom `ISOMUX_HOME` (server/config.ts:24-27). Because the path stays the same, the pinned `claudeConfigDir` values in `sessions.json` (server/agent-manager.ts:5183-5195) and every `CLAUDE_CONFIG_DIR`/`CODEX_HOME` path stay valid with no rewrite. A fresh split install sets `AGENT_ROOT` to `<agent home>/.isomux`.

The migration writes `STATE_ROOT/split.json`: `{agentUser, agentUid, agentRoot, agentRootWasDefault, shareRoot}`. `agentRootWasDefault` records whether the old root was the default `~/.isomux` of its user (`IS_DEFAULT_STATE_ROOT`, config.ts:36).

**PM:** the state layout. The server state moves to `<server home>/.isomux`. The agent-space subtrees stay at the old path. The share dir and `split.json` are new.

#### 3.1.1 Share paths and modes

Group access, not the setgid bit, gives the agent user access. The setgid bit on a directory only makes new entries take its group, and Linux also gives a new subdirectory the setgid bit. The server user is a member of `<agent group>`, so its own `chmod 2750` keeps the setgid bit. (A `chmod` by an owner who is not in the file's group clears it.) The server writes every mode explicitly with `chmod` after it creates an entry, and never relies on its umask.

| Path | Installer | Container | Owner:group | Mode |
|---|---|---|---|---|
| server home | `/var/lib/isomux-server` | `/var/data/server` | server:server | 0711 (agent can pass through, cannot list) |
| `STATE_ROOT` | `<server home>/.isomux` | same | server:server | 0700 |
| `SHARE_ROOT` | `<server home>/share` | same | server:`<agent group>` | 2750 |
| `files/`, `files/<agentId>/` | | | server:`<agent group>` | 2750 |
| upload and shown-file files | | | server:`<agent group>` | 0640 |
| `bin/` | | | server:`<agent group>` | 2750 |
| `bin/isomux-codex-safety-hook` | | | server:`<agent group>` | 0750 (today 0700) |
| `authority/` | | | server:`<agent group>` | 2750 |
| `authority/authority.sock` | | | server:`<agent group>` | 0660 |

- `<agent group>` is the agent user's primary group. The server user is a member of it, and the agent user is never a member of the server user's group. Group membership gives the server user no more than it needs: it can read agent files that are group-readable, but it reads agent space through the runner in any case.
- To connect to a Unix socket, a process needs write permission on the socket and search permission on its directory. It does not need write permission on the directory. Thus `authority/` stays 2750, and the socket is 0660.
- The authority broker today creates its directory with mode 0700 and calls `chmod` on it (authority-broker.ts:181-182). In split mode it uses the modes above and calls `chmod` on the socket after `listen`. Until that `chmod`, the socket is closed to the group. That is the safe direction.
- The agent user cannot create, rename or delete anything in `SHARE_ROOT`. Thus the agent cannot replace the safety hook or the authority socket.
- Container: `/var/data` itself changes to root:root 0755. `/var/data/home` and `/var/data/workspaces` stay with `node` (section 2.4).

#### 3.1.2 Identities derived from the state root

Three identities hash or embed the path of the state root. A path change moves the identity, so the migration must keep each one stable.

- **OpenCode profile.** `environmentSourceKeyForUserId` hashes the absolute paths of the managed env files (server/env-loader.ts:135-147). Those files live under `STATE_ROOT` (server/user-env.ts:18-20), and `openCodeProfilePaths` hashes that key into the profile directory name (server/backends/opencode/profile-paths.ts:15-25). Reviewer 2 found on 2026-10-06 that two synthetic roots with identical `office.env` contents gave different keys. Thus a moved `office-env/` would orphan every OpenCode profile and its sessions.
- **App unit names.** `unitPrefixFor(STATE_ROOT, IS_DEFAULT_STATE_ROOT)` (server/app-supervisor.ts:246-249,707) gives `isomux-app-` for the default root and a digest of the root for a custom root.
- **Codex wrapper.** The `bin/codex` script embeds either the `$HOME/.isomux` form or the absolute `ISOMUX_CODEX_HOME` path (native-bin.ts:185-222).

Rule: in split mode, each of these uses `agentRoot` and `agentRootWasDefault` from `split.json` in place of `STATE_ROOT` and `IS_DEFAULT_STATE_ROOT`. The env-source key hashes the logical paths `<agentRoot>/office-env/office.env` and `<agentRoot>/user-env/<uid>.env`, not the real paths of the moved files. For a migrated install, these are byte-for-byte the values from before the migration. After an undo, the files are back at those paths, and the plain single-user code gives the same values. In single-user mode nothing changes. The OpenCode profile directory itself stays at `<agentRoot>/opencode/profiles/<key>`.

### 3.2 What the server does in agent space (all through the runner in split mode)

- **Claude transcripts.** It checks that they exist (claude.ts:1558, agent-manager.ts:1519), reads the last 256 KB (server/cwd-utils.ts:110-139), and does the session store load and append (section 2.1).
- **Codex rollouts.** The resume preflight walks `$CODEX_HOME/sessions` (cwd-utils.ts:206-240).
- **OpenCode.** It writes `opencode.json` (supervisor.ts:302-307). It inspects `opencode.db` read-only (server/backends/opencode/storage.ts:62-80). It copies the database and its WAL file into a private tmp directory only when a WAL file exists and the `-shm` file does not (:70-78); otherwise it opens the database in place. In split mode the runner runs `inspectOpenCodeDatabase` as a fixed entry (section 2.3) and returns only the resulting state. No database bytes cross to the server.
- **Uploads and shown files.** Today `saveFile` writes to `STATE_ROOT/logs/<agentId>/files/` (server/persistence.ts:1592-1602). `getFilePath` reads that directory, and falls back to the legacy `images/` directory (:1637-1645). The agent gets that absolute path (server/attachment-prompt.ts:50-66). In split mode both functions use `SHARE_ROOT/files/<agentId>/`, which the server writes directly (section 3.1.1). Storage usage and pruning count and prune the same directory (server/storage-usage.ts:140-152, server/storage-prune.ts:381-386).
- **Provider homes.** It creates them (provider-homes.ts:46-56), links skills (server/provider-skill-links.ts:66-103), and unlinks `.credentials.json` on logout (server/provider-account-manager.ts:879). Sign-in itself already happens in a CLI child (#3, #4), which now runs as the agent user.
- **Codex `hooks.json` and `config.toml` merge** (safety-hook-install.ts:227-244,377,509-537).
- **App launcher and unit files** (app-supervisor.ts:716-723). The runner also runs `systemctl --user` and `journalctl --user`.
- **Agent-named paths.** These are the fence in section 4: read-file, the editor, browser upload (server/browser-upload.ts:24-40), Codex image views (server/backends/codex/adapter.ts:1582-1594), skill discovery in the cwd and in `~/.claude` (server/skills.ts:326-342), and cwd existence checks.

### 3.3 What agents read from server space

Two agent-reference pages tell agents to read state files directly:
- server/agent-reference/discovery.md:7 points at `~/.isomux/users.json`.
- server/agent-reference/cronjobs.md:3,7 points at `~/.isomux/cronjobs/cronjobs.json`.

The `logDir` field of `GET /agents` points into `STATE_ROOT/logs`. In split mode all three are unreadable. Agents need API routes for member profiles and for cronjob inspection by ordinary agents. `logDir` stays in the response but has no use in split mode. **PM:** new or widened agent-facing routes, and the page and system-prompt text.

### 3.4 Sockets

- **`admin.sock`** answers uid 0 and `ISOMUX_RECOVERY_UID`, and refuses the server uid (admin-socket.ts:48-77). In split mode it must also refuse the agent uid, and it must reject an `ISOMUX_RECOVERY_UID` that equals the agent uid.
- **OpenCode `authority.sock`** accepts only `process.getuid()` (server/backends/opencode/authority-broker.ts:130,255) in a 0700 directory (:181-182). In split mode the expected uid is the agent uid, and the socket moves to `SHARE_ROOT/authority/` (modes in section 3.1.1). The ancestry walk goes from the peer up to `turn.serverPid`. That is the pid of the `opencode serve` process (set from `lease.pid` at server/backends/opencode/transport.ts:428 and checked at authority-broker.ts:257), not the office server. Both ends are agent-user processes, and `/proc/<pid>/stat` is readable by any user. Whether the walk works across the two users is unchecked. The rig tests it with a real authority request.
- **Container update socket** (`/run/isomux-update/request.sock`, mode 0666, install.sh:4559-4574). No change. It already accepts any local uid and allows only one fixed verb.

### 3.5 Backups

`backup.ts` archives `STATE_ROOT` (:558). App data moves to agent space. A slice must decide between two options: a runner `tar` stream that goes into the same archive, or a change to the backup docs. The credential exclusions (backup.ts:176-225) stay.

## 4. The fence (ruling 5)

The routes are:
- `POST /api/agents/:id/read-file` (agent-manager.ts:2595-2667)
- the cron variant (cronjob-manager.ts:1498-1512)
- the editor open, save and watch (agent-manager.ts:2480-2495, :9782-9818; isomux-office.ts:4650-4700; command-handlers.ts:938)
- `PUT /api/apps/:name/thumbnail` in its JSON `{path}` form (task a5ab665e)

All of them resolve the path with `resolveEditorPath` (server/file-editor.ts:247-258). Then the server opens the file itself.

Design:
- In split mode, `resolveEditorPath` expands `~` to the agent user's home, which the runner reports with `home`. Today it uses the server's `homedir()` (:254).
- Every open, read, write, `existsSync` and `fs.watch` on the result goes through `AgentHost.fs`. The kernel then refuses what the agent user cannot read or write.
- The editor also saves. A save through the runner gives the file the agent user as owner, which is correct, because a member shares the agent user.
- No denylist and no realpath check. A denylist must list everything that the server user can read and the agent user cannot. The server cannot compute that list. A path check also races with symlink swaps.
- In single-user mode the fence changes nothing. The agent can already read the same files with a shell.

The same rule covers the other agent-named reads in section 3.2: browser upload, Codex images and skills. It also covers the diff: the untracked-file reads in `computeIsomuxDiff` (isomux-diff.ts:335-350) follow symlinks, so the whole diff runs as the agent user (section 1, #11).

## 5. Hosting paths

| Path | Server user | Agent user | Runner start | Change |
|---|---|---|---|---|
| Installer (VPS) | new `isomux-server`, home `/var/lib/isomux-server` | `isomux` (today's service user; keeps its linger, its app units and `/home/isomux`) | system unit `isomux-agent-runner.service` (`User=isomux`), plus a `.socket` unit if slice 1 shows that Bun accepts an inherited listener (section 2.3) | The server unit gets `User=isomux-server` and `Environment=ISOMUX_AGENT_RUNNER=…`. `isomux-server` owns `/opt/isomux`. The polkit rule and `update.conf SERVICE_USER` name `isomux-server`. The hardening gate (install.sh:1834-1867) checks both users. |
| Container (Docker and the AWS installer mode; Render is unchecked: it must start the entrypoint as root) | new image user `isomux-server` (fixed uid, for example 999) | `node` (uid 1000, as today) | the entrypoint, while it is root (deploy/container/entrypoint.sh:11-13), starts the runner and supervisor.py with `runuser -u node`, and starts the office as `isomux-server` | Root already owns the code (deploy/container/Dockerfile:5-9). The state moves, and `/var/data` changes from `node` (Dockerfile:9) to root (section 2.4). |
| Kubernetes | — | — | — | **Stays single-user in this loop.** The pod never has root (`runAsNonRoot`, deployment.yaml:41-45). A split there means a second container with its own `runAsUser`, the runner as a sidecar, and the state volume mounted only into the office container. That is a manifest redesign, and `fsGroup` (:45) applies to the whole pod. Propose it as a later slice. |
| Self-hosted by its owner (Linux) | opt-in | the owner's login user | a documented `sudo` script installs the two units | **Stays single-user by default.** These guides run the office as the owner's user unit (docs/hosting/blocks/service.md:9-31). A split needs root once, a second user and system units. The script is offered, not required. |
| Local and macOS | — | — | — | **Stays single-user.** There is no systemd, and it is a dev setup (docs/hosting/local.md:3-6). |

**PARKED FOR NIL (P3):** should a fresh installer install use the split by default? Recommendation: yes, after the rig in section 7 passes on the release. Existing installer boxes move only when the owner runs the migration command, because ruling 3 requires that they keep working with no action. The updater never migrates on its own.

## 6. Migration

The installer gets a new command, `isomux-split-users` (root). The updater installs it with the other host tools. It does these steps, in this order:

1. **Find the old root.** The command reads `ISOMUX_HOME` from the environment of the existing unit. If it is not set, the old root is `<agent home>/.isomux`. A `--state-root` flag overrides both. This path becomes `agentRoot`, and the command records whether it was the default (section 3.1.2).
2. **Stop** `isomux.service`. Apps keep running, because they are units of the agent user.
3. **Back up** the whole old root to `/var/lib/isomux-install/split-backup-<date>.tgz` (root, 0600). This happens before the first move. The archive holds credentials, so root owns it and no backup rotation copies it.
4. **Create** `isomux-server` (system user, no login shell, no sudo), the server home, `STATE_ROOT` and `SHARE_ROOT` with the modes in section 3.1.1.
5. **Extract uploads.** For each `<old root>/logs/<agentId>/files/`, the command moves the directory to `SHARE_ROOT/files/<agentId>/`. Legacy `images/` directories go to `SHARE_ROOT/images/<agentId>/`, so the `getFilePath` fallback keeps working.
6. **Move server state.** The command moves the server-state entries, now including `logs/` without uploads, from the old root to `STATE_ROOT`. It works from an explicit list, which is the "Server state" row of section 3.1. The agent-space subtrees stay.
7. **Leave compatibility links.** Old transcripts hold absolute paths such as `<old root>/logs/<agentId>/files/<name>`. The command creates `<old root>/logs/<agentId>/` (agent-owned) with a `files` symlink, and an `images` symlink where one existed, into `SHARE_ROOT`. These links are in agent space. An agent that changes one only changes its own reads. The server never reads through them.
8. **Remove** `<old root>/bin/isomux-codex-safety-hook` and its golden copy. The server builds the hook into `SHARE_ROOT/bin` at start. `bin/codex` stays in agent space.
9. **Change owners and groups:** add the server user to `<agent group>`, set `STATE_ROOT` and `SHARE_ROOT` to `isomux-server` with the modes in section 3.1.1, the code to `isomux-server`, and (container only) `/var/data` to root.
10. **Write** `split.json`, the runner unit, the new server unit, `update.conf` and the polkit rule. The command first saves the old unit files, `update.conf` and the rule in `/var/lib/isomux-install/split-undo/`.
11. **Check and start.** The command runs the trusted checks (including the full `--check` walk) (section 2.4), and then starts the server and waits for `/readyz`. If a check or `/readyz` fails, it runs the undo on its own.

**Undo.** `isomux-split-users --undo` reads `split.json`. It stops the server and then works in this order:
1. It checks before any move. Each `<agentRoot>/logs/<agentId>/` must hold only the two compatibility links. Server state must have no `logs/<agentId>/files` or `images` (in split mode, uploads are written only to `SHARE_ROOT`). If either check fails, the undo stops and changes nothing.
2. It deletes the compatibility links and the then-empty `<agentRoot>/logs/` tree.
3. It moves the server-state entries back to `agentRoot`, including any state that changed after the split.
4. It moves `SHARE_ROOT/files/<agentId>/` and `images/<agentId>/` into `<agentRoot>/logs/<agentId>/`. Step 1 proved that these names are free, so nothing nests or is overwritten.
5. It deletes `split.json` and removes the server user from `<agent group>`. It gives everything back to the agent user, restores the saved units, `update.conf` and the polkit rule, and starts the server. The identities in section 3.1.2 are the same after the undo because the files are back at their old paths. If the undo itself fails, the archive from step 3 is the last resort.

**Container.** The entrypoint (root) decides on each start:
- `ISOMUX_SPLIT=1` and `/var/data/server/.isomux/split.json` is missing: it runs steps 3-10 against the data volume. The backup goes to `/var/data/split-backup-<date>.tgz` (root, 0600), and step 10 writes only `split.json`, because the container has no units. Then it starts as in the next case.
- `split.json` is present: no migration. It runs the trusted checks, starts the runner and supervisor.py as `node`, and starts the office as `isomux-server`.
- No `ISOMUX_SPLIT=1`: it starts single-user as today. If `split.json` is present, it refuses to start and names the undo command, so the office never mixes the two layouts.

The rig starts the container twice and checks that the second start does not migrate again. **PM:** whether the container switch is an env var or the default of a new image tag.

### 6.1 This office box (auntie): to run later, with Nil present

- The agent user is `nil`. The server user is a new `isomux-server`. Today the server is a user unit of `nil` (`~/.config/systemd/user/isomux.service`, which runs `/home/nil/nil/isomux`). It becomes a system unit. Nil's apps stay as `nil` user units.
- `/home/nil/.isomux` splits as described in section 6. A generic Linux script does the work, run with `--agent-user nil`, not a box-only fix (ruling 3).
- **PARKED FOR NIL (P1): `nil` is in the `sudo` and `docker` groups** (`id` output, 2026-10-06). Membership in the `docker` group is root-equivalent. While the agent user keeps it, the split is no boundary on this box (security-audit.md:62).
  - Recommendation: give agents rootless Docker as `nil`, take `nil` out of `docker` and `sudo`, and do admin work from a separate admin login.
  - The two-user rig (section 7) needs Docker. Rootless Docker keeps that working.
- **PARKED FOR NIL (P2): the served code is agent-writable on this box.** The server runs from `~/nil/isomux`, the main checkout that agents edit. The north star says that the agent user cannot change the server code.
  - Recommendation: the server runs from `/opt/isomux`, owned by `isomux-server`. A deploy step pulls `main` from `~/nil/isomux` into it.
  - This changes the flow on this box. Today "merge + `build:ui`" makes UI work live. After the change, "merge + deploy" does. A server change still needs a restart.
- **Recommended steps with Nil:**
  1. Fix P1 and P2.
  2. Run the split script with `--agent-user nil --code /opt/isomux`. The script makes its own backup first (section 6, step 3).
  3. From a terminal panel, check that `cat /var/lib/isomux-server/.isomux/users.json` fails with "Permission denied".

## 7. Testing for real

**Rig.** `scripts/split-rig.sh` builds a test image from deploy/container/Dockerfile with the split entrypoint. It runs the office as `isomux-server` and the runner as `node`, with a throwaway volume. It never touches the live office (ruling 7). The bun tests in `server/test-support/split-rig.integration.test.ts` drive it over HTTP. They are gated by `ISOMUX_TEST_SPLIT_RIG=1`, as `test:systemd` is gated today (package.json:24).

Every denial check asserts the exact errno: `EACCES` or `EPERM`. `ENOENT`, `EISDIR` or a transport error fails the test, so a wrong path cannot pass as a denial. The agent-side checks run with `docker exec -u node`, not through the runner, so that the runner cannot fake them.

**Tier 1 (always, no credentials):**
- **Boundary.** As the agent user: `id -u`, a read of `$STATE/users.json`, `ls $STATE`, an `O_WRONLY` open of an existing code file, a rename inside the code tree, and a file create in `SHARE_ROOT`. The rig expects the agent uid and a denial for each operation. A terminal panel runs `id -u` and must show the agent uid.
- **Trusted checks.** A correct split passes. Then, in separate runs, the rig breaks one thing at a time: it makes `STATE_ROOT` world-readable, gives a top-level code file to the agent user, adds a named-user ACL write grant for the agent user on a code file three levels deep, replaces a code file with a symlink to an agent-writable file, removes the setgid bit from a share directory, and makes `/var/data` owned by `node` again. The office refuses split mode at start for each top-level case. `isomux-split-users --check` fails for the deep cases. Each failure names the check.
- **False-denial runner.** A stub runner that answers `EACCES` to every diagnostic replaces the real one, and `STATE_ROOT` is world-readable. The office must still refuse split mode. This proves that the verdict does not depend on the runner.
- **Fence.** read-file, the editor open, save and watch, and the thumbnail `{path}`, each aimed at a state file, give the "cannot read" result. The same calls on a workspace file succeed. A save creates a file that the agent user owns.
- **Diff.** A repo with `core.fsmonitor` set to a script that writes `id -u` to a file: `/isomux-diff` runs it, and the file shows the agent uid. A second repo has an untracked symlink to a state file: the diff result does not contain that file's content.
- **Share.** The agent user reads an uploaded file at the path that the attachment prompt gives, and cannot write it. The agent user runs `SHARE_ROOT/bin/isomux-codex-safety-hook --source-hash` (the stamp call of safety-hook-install.ts:79). A process with the agent uid connects to the authority socket. A process with a third uid is refused.
- **Apps and preview.** The rig registers an app and checks the uid of its process. A preview capture runs Chromium (in the image, deploy/container/Dockerfile:3) and the rig checks its uid.
- **Single-user regression.** The existing suite runs unchanged with `ISOMUX_AGENT_RUNNER` unset.

**Tier 1, migration (slice 5):**
- The rig starts a single-user office with managed office and personal variables, and with an OpenCode profile, a Claude session and a Codex session. It records the env-source key, the OpenCode profile directory, the app unit names and one attachment path.
- It runs the migration, and then the undo. After each step, the key, the profile directory and the unit names are unchanged, no new profile directory exists, and the old attachment path is readable by the agent user.
- It repeats the run with a custom `ISOMUX_HOME`.
- It makes the migration fail at `/readyz` and checks that the automatic undo restores the single-user office.

**Tier 2 (live, an operator mounts a credential volume):** one Claude turn, one Codex turn (the safety hook runs as the agent user), one OpenCode turn (one real authority request across the two users) and one cron run. Each asks the agent to run `id -u` and to read a state file. The rig checks the agent uid and the denial. It also checks a resume after an office restart, and a resume after migration and after undo with the managed variables set.

Each slice report names the rig command and its result.

## 8. Slice plan

The single-user path stays unchanged in every slice. Slices 1-4 add split-mode wiring that only the rig uses: the server starts in split mode only when `ISOMUX_SPLIT_RIG=1` is also set, and no doc, installer or release mentions split mode. Until slice 5, a split office still runs some agent work as the server user, so none of those slices claims a boundary. Slice 5 removes the rig-only gate, but only after the full tier-1 rig, the migration tests and tier 2 pass.

1. **Runner, `AgentHost` and the proof.** This slice adds `server/agent-runner/`, the protocol, fixed entries, `LocalAgentHost`, `RunnerAgentHost`, the trusted checks and the runner diagnostic. It checks whether Bun accepts an inherited listener. It moves the terminal (#7), the Node probe (#7b) and the whole diff (#11) onto `AgentHost`. It brings up the tier-1 rig with the boundary, trusted-check, false-denial and diff tests.
2. **Agent backends.** This slice routes Claude (the spawn hook, the session store, the probes), Codex (`JsonRpcLiteClient.start`, the hook binary in `SHARE_ROOT/bin`, the hooks and config merge) and OpenCode (start and stop helpers, profile files, the database check as a fixed entry, the authority socket) through `AgentHost`. It also adds the identity rule of section 3.1.2 and the tier-2 tests.
3. **Fence and agent-space files.** This slice covers `resolveEditorPath` and every caller, read-file, the editor watch, browser upload, Codex images, skills, provider homes, uploads in `SHARE_ROOT/files`, storage usage and pruning, and the routes that replace direct state reads (after the PM rules on section 3.3). It adds the fence and share tests.
4. **Apps, preview, cron and backups.** This slice covers `systemctl --user` through the runner, the container supervisor as the agent user, preview capture, cron runs, the backup of app data, and `admin.sock` refusing the agent uid.
5. **Hosting, migration and the switch.** This slice covers the installer units, `isomux-split-users` with undo, the container entrypoint split, the hardening gate for both users, the migration tests, and the docs listed in section 9. When all gates pass, it removes `ISOMUX_SPLIT_RIG`. This is the first slice that offers split mode.

## 9. What changes in the public text

- **docs/security-audit.md**
  - L21 (Summary), the 3.1 table and L53, and the 3.2 bullets at L57-59: the server has its own user on the installer and the container, and the state and code are out of reach. Room access and cross-member secrets stay shared, because members share the agent user (ruling 1) and a process can read the env of other processes of the same uid.
  - L66 changes from "planned" to the result.
  - L167 and L231 (6.4: "does not close the class in section 3.2") change for split installs.
  - L235 (6.5 read-file: "any file that the server's OS user can read") changes to "the agent user".
  - L256 (8.1, the state location) and finding #1 (L292) change.
- **The other doc surfaces.** docs/hosting-reference.md (root access, both users), the installer and container guides, internal-docs/safety-hooks.md (the isolation boundary changes, documentation.md L93), and the two agent-reference pages in section 3.3.

## 10. Open items

- **PM:** the state layout and `split.json` (section 3.1), the identity rule (section 3.1.2), the upload move and its symlinks (section 6), the switch name `ISOMUX_AGENT_RUNNER` and the rig-only gate (section 8), the user names `isomux-server` and the image uid, the agent-facing routes (section 3.3), the container switch (section 6), and Kubernetes staying single-user (section 5).
- **PARKED FOR NIL:** P1 (`nil` holds `docker` and `sudo`), P2 (the served code on this box is agent-writable), P3 (split by default on fresh installer installs).
- **Unchecked:**
  - The OpenCode ancestry walk from the peer to the `opencode serve` pid when the two processes and the broker belong to different users (section 3.4).
  - Whether Bun can listen on an inherited socket (section 2.3).
  - Whether `forkSession` and `getSessionMessages` touch files outside the session store.
  - The file modes of the transcripts that the CLIs write. The design does not depend on them.
