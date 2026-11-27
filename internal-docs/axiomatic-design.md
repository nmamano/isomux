# Axiomatic Design check of the Isomux server

Snapshot of main at `fe9fc7806`, 2026-11-26 (task 41aa4d16). Numbers will rot;
the Method section says how to make them again. Scope: the server only; the UI
is not in the matrix.

Axiomatic Design maps each functional requirement (FR, what the system must do)
to a design parameter (DP, the module that does it). A mark at (FR i, DP j) means
FR i cannot change without DP j changing. A design is decoupled when some order
of rows and columns puts every mark on or below the diagonal: change the DPs in
that order and no change undoes an earlier one. It is coupled when no order
does, which means the marks form a cycle.

## Method

- Commits: the 1,777 non-merge commits from 2026-08-26 to 2026-11-26 that change
  a non-test file under `server/`, `shared/` or `ui/` (2,722 non-merge commits in
  all). Every share below uses 1,777 or the commits of one DP in it.
- Mark at (i, j), with FR i met by DP i, so row i reads "FR i needs DP j": 40%
  or more of the commits that change DP i also change DP j, or DP i imports DP j
  at runtime. These route handlers count in their feature's DP: apps,
  app-sign-in, app-widget (Apps); asks, denied-command-runs (Asks); cron (Cron);
  secrets, secret-requests (Secrets); tasks, rooms, floors, office-settings
  (OfficeState); account-usage, provider-accounts, usage (Accounts); access,
  invites, sessions, api-tokens (Identity); agents (AgentMgr); conversation,
  messaging (AgentParts). The other handlers stay in Routes.
- Order: the one with the fewest marks above the diagonal, by an exact search
  over all orders (dynamic programming over subsets of the 14 DPs).
- File cycles: Tarjan's strongly connected components over relative imports
  between non-test `.ts`/`.tsx` files in `server/`, `shared/`, `ui/` (2,025
  files). Runtime imports and `import()` count; `import type` does not.
- Fields: lines at two-space indent that declare a member of
  `interface ManagedAgent` in `server/internal-types.ts` (nested fields not
  counted).
- Engine branches: the regex
  `(agentType|backend|engine|type)\s*[!=]==\s*"(claude|codex|opencode)"` in
  non-test server files outside `server/backends/`.

## Result: files are in order, modules are coupled

Files: only 5 groups import each other in a cycle. Two are couplings (C5). The
office-move pairs (`office-move-members`/`office-move-pull`,
`member-user-admin`/`office-move-member-wiring`) are two files of one feature
each, and the `ui/office` pair is out of scope.

Modules: no order is triangular. The best order has 25 of its 87 marks above the
diagonal. 11 are in the Root column (C3), 6 are on the agent manager and its
parts (C1, C2 and four more), 1 is Hosts to Engines (C5), and 7 small ones are
around Routes, Identity and Accounts.

| FR                                            | DP                                     |
| --------------------------------------------- | -------------------------------------- |
| 1 Run a process as the office or a member     | Hosts: `member-hosts`, `agent-host`, `agent-runner/` |
| 2 Know who calls and what they may do         | Identity: `server/identity/`, access, invites, sessions, tokens |
| 3 Keep rooms, desks, tasks, office settings   | OfficeState: `shared/office-state`, `office-persistence` |
| 4 Stop unsafe tool calls                      | Safety: `safety-*`                     |
| 5 Serve the API                               | Routes: `server/routes/` (table, executor, other handlers) |
| 6 Speak each engine's protocol                | Engines: `server/backends/`            |
| 7 Track provider accounts, usage and caps     | Accounts: `provider-account-manager`, `usage-*`, `member-usage-cap` |
| 8 Ask members to decide or act                | Asks: `asks`, `step-asks`, `ask-*`     |
| 9 Keep secrets out of prompts                 | Secrets: `secret*`                     |
| 10 Run an agent: spawn, resume, kill, transfer | AgentMgr: `agent-manager.ts`          |
| 11 Host agent apps                            | Apps: `app-*`                          |
| 12 Deliver turns: queue, permissions, handoff | AgentParts: `message-queue`, `agent-turn`, `session-manager`, `handoff-and-wake`, `agent-restore` |
| 13 Run schedules                              | Cron: `cronjob-manager`, `cron-*`      |
| 14 Boot the office and wire it                | Root: `isomux-office.ts`               |

`X` diagonal, `l` below (allowed), `U` above: the marks that the best order
still leaves above the diagonal. The number is the co-change share; `i` is a
runtime import with a lower share.

```
               1   2   3   4   5   6   7   8   9  10  11  12  13  14
 1 Hosts       X   .   .   .   . U48   .   .   . U40   .   .   . U57
 2 Identity    .   X   .   . U78   .   .   .   .   .  Ui   .   . U74
 3 OfficeSt    .  li   X   . U40   .  Ui   .   . U62   .   .   . U65
 4 Safety     li   .   .   X   .   .   .   .   .   .   .   .   .   .
 5 Routes      .  li  li   .   X   .   .  Ui  Ui   .   .   .   . U77
 6 Engines    li  li  li  li  li   X   .   .   .   .   .   .   .   .
 7 Accounts   li  li  li   .  li l41   X   .   . U56   .  Ui  Ui U58
 8 Asks       li  li  li   . l53   .   .   X   .   .   .   .   . U55
 9 Secrets     .  li   .   . l55   .   . l41   X   .   .   .   . U79
10 AgentMgr   li  li  li   .  li  li  li  li   .   X   .  Ui  Ui U49
11 Apps        .  li  li   .  li   .   .   .  li   .   X   .   . U59
12 AgentPrt   li  li  li   .  li  li  li  li   . l80  li   X   . U49
13 Cron       li  li  li   .  li  li  li  li   . l67   .  li   X U57
14 Root       li  li  li   . l46  li  li  li  li  li  li  li  li   X
```

In order, so not couplings: `shared/types.ts` (3,417 lines, in 257 commits)
imports nothing from `server/` or `ui/`; 216 of its commits also change both, in
the one direction type, then server emit, then UI reducer. The i18n catalogs
(597 commits) go en first, then es, ca and zh. `ui/demo-server.ts` (181 commits)
follows features and never leads.

## Couplings and splits, worst first

**C3. The boot file holds feature rules.** Root imports 12 of the 13 other DPs,
so it belongs last, and it is. But 11 of the 13 other rows mark it: a feature cannot change
without the boot file changing. `buildExecutorDeps` is 2,767 lines and had 568
changed hunks in the window; `isomux-office.ts` is in 24% of commits. It holds
rules and member copy, for example which skill folders an isolated member sees.
Split: each handler group gets its own deps factory next to its handlers, as
`office-storage-routes.ts` and `office-agents-routes.ts` do; the boot file
keeps `register(group(core))` lines. This finishes the thin transport over a
core of `generic-runtime-refactor.md`. Removes: the `U` marks in column 14.

**C1. One record and one closure for every per-agent concern.** `ManagedAgent`
has 91 fields, and `createAgentManager` is one closure of about 10,000 lines.
Queue, permissions, topics, context and subscription usage, automatic handoff,
terminal, free-model search and member moves share both. The earlier size splits
(task b887b41d) moved text, not coupling: the manager imports its parts, and
the parts take the `agents` map and call back into the closure (32 callbacks in
`message-queue.ts`, 52 in `handoff-and-wake.ts`). They change with
`agent-manager.ts` in 12 of 13, 7 of 7, 28 of 29 (`agent-restore.ts`) and 27 of
29 (`session-manager.ts`) commits. The flag clusters in
`implicit-state-machines.md` sit on the same record. Split: each part owns its
slice of the state, in the order lifecycle (the manager), queue, turn, handoff.
A part uses only the parts before it; to tell a later part something, an earlier
one emits an event. Removes: `Ui` at (10, 12), the cycle with `l80` at (12, 10).

**C2. The office event bus belongs to the agent manager.** The manager uses
`OfficeState` (agents sit at desks in rooms), which is in order. But every route
reaches tasks, rooms and settings through `agentManager.addTask`, `createRoom`,
`setOfficeSettings` and similar, which only call `OfficeState` and pass its
events to the manager's one sink (read by `office-event-fanout.ts`). The manager
also wires the task store into `OfficeState` (`officeState.beforeTaskChange =
taskStore.change`). Split: an office event bus that `OfficeState`, the manager
and feature modules publish to; the boot file wires the task store; task, room
and settings handlers call `OfficeState` directly. This revises one line of
`generic-runtime-refactor.md` (the manager takes `officeState` in its deps).
Removes: `U62` at (3, 10).

**C5. The 10-file and the 4-file import cycles.** 10 files: `cwd-utils.ts`
imports `member-hosts.ts`, which reaches `cwd-utils.ts` again through
`agent-runner/client.ts` and `split/start.ts` for `CLAUDE_NATIVE_BIN`, and
`agent-host.ts` and `backends/codex/native-bin.ts` import each other. 4 files:
`provider-account-manager.ts`, `member-usage-cap.ts`, `office-login-sync.ts` and
`usage-account.ts`, all inside Accounts. Split: move the shared constants and
lookups to leaf modules. Removes: the 10 imports under `U48` at (1, 6), and the
cycle inside row 7. The co-change mark stays until Hosts and Engines stop
changing together (Hosts has only 42 commits, so that share moves fast).
Done 2026-11-27 (task 52b70fe1): `engine-binaries.ts` and `provider-folders.ts`
are the leaves, and `isomux-office.ts` wires the Codex hook into
`member-runtime.ts` when it loads. Left: `codex/client.ts`, `safety-hook-install.ts` and
`safety-hook-trust-probe.ts` still import each other, a recursion inside the
Codex engine (the start check measures the hook with a client that skips it).

## One-way, but wide

**C4. Engine choices are spread through the server.** 169 engine-name branches
in 41 files outside `server/backends/`; `backends/claude.ts` changes with
`agent-manager.ts` in 52 of 82 commits. The changes go one way, so this is not a
coupling, but adding an engine or changing one edits the orchestrator in many
places. Split: each engine declares traits on its backend (a fixed working
folder, a free-model search); callers read the trait.

Not filed: Hosts and Accounts to AgentMgr (`U40`, `U56`), Accounts to
AgentParts and AgentMgr to Cron (`Ui`), and the 7 small marks around Routes,
Identity and Accounts. Recount after C1 to C3.

Order: C5 (small), then C2 and C1, which both change the manager's event path,
then C3. C4 does not depend on them. Tasks: C5 52b70fe1, C2 f71e6df4, C1 slice
1 d635ea4d, C3 a75a4a13, C4 265b4a97.
