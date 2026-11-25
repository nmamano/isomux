# OpenCode 2.2.7 re-run of the gate

Date: 2026-11-25\
Task: `3cc9d863` (Dependabot proposed `@opencode/cli` 2.2.5 -> 2.2.7 in PR #74)\
Result: **the pin moves to `@opencode/cli` 2.2.7. No Isomux code change is needed.**

The items of [`report-2.2.5.md`](report-2.2.5.md) ran again on 2.2.7: the
reload window, P3, S9, P6, P1, P2, P4, P8, skill folders and `/goal`. Two new
probes ran too: flag-gated tools and the edited credential migration. An
audit of the upstream source, tag v2.2.5 to tag v2.2.7, checked each
behavior that Isomux code names as "2.2.5". The event, restart, concurrency
and memory items (S2-S6, P7, P9, S8, S10) did not run again. The audit found
no change to the events or the session status values that the transport
reads (below).

## Tested versions and host

- `@opencode/cli` 2.2.7 (released 2026-11-10; npm `latest` is 2.4.1), from
  the worktree install.
- `@opencode/cli` 2.2.5 as the baseline, from the main checkout.
- Host `auntie-2`. Model calls went to the gate mock. Each server ran under
  its own HOME, XDG and TMPDIR directories below `GATE_ROOT`.

The probes are the scripts of [`harness-2.1.4/`](harness-2.1.4/) and
[`harness-2.2.5/`](harness-2.2.5/), run as they are, with `GATE_V1_BIN` =
2.2.5 and `GATE_V2_BIN` = 2.2.7. The labels inside the copied scripts
("2.1.4", "2.2.5") name the role, not the version; each evidence file records
the version from `GET /api/info`. [`harness-2.2.7/`](harness-2.2.7/) holds the
two new probes. The evidence is in [`evidence/2.2.7/`](evidence/2.2.7/).

## Verdicts

| # | Check | 2.2.7 | Evidence |
|---|---|---|---|
| Reload | A tool call while an earlier plugin reloads | PASS, as 2.2.5. The call waits for the reload: the hook ran 100-200 ms after the reloaded plugin's setup ended and denied, read 3/3 and shell 3/3. No permission ask, no secret in the events, no side file. | `reload-window.json` |
| P3 | Safety plugin, load check, order | PASS, as 2.2.5: every deny, remove and same-id case gives the same result. The plugin is active in 20 of 20 new folders, median 540 ms, max 4456 ms (2.2.5: 509 ms, 3228 ms). A prompt sent with no plugin check, right after the session was created, was denied 8 of 8. `GET /api/agent` as the first request to a new folder lists 0 agents (2.2.5: 8); see "Fewer endpoints wait for plugins". | `sp-p3-plugin-order.json`, `sp-p3-failclosed-race.json` |
| S9 | Secrets | PASS, as 2.2.5. The sentinels appear 0 times in each location; only the control counts move. | `sp-s9-secrets.json` |
| P6 | Process identity and footprint | PASS, as 2.2.5. The broker accepts and refuses the same cases. Outside the profile 2.2.7 writes only the `/tmp/opencode-pty-<uid>/` socket. | `sp-p6-ancestry.json`, `sp-p6-census-v2.json`, `sp-p6-pty-sigkill.json` |
| P1 | Permission keys | PASS, as 2.2.5: the 45 cells give the same results. `GET /api/agent`, read right after a `GET /api/config` for the folder, lists only `build` and `general` with their built-in rules (2.2.5: also `isomux-cron` and `isomux-interactive-bypass`, with Isomux's rules); see "Fewer endpoints wait for plugins". | `pm-p1-observed.json` |
| P2 | "Always" scope | PASS, as 2.2.5. A permissions PATCH now also emits a `session.permissions` event; the transport ignores event types it does not handle. | `pm-p2-always-scope.json` |
| P4 | Config layers and environment | PASS, as 2.2.5. `/etc/opencode` and the environment variables give the same results. Project config discovery now lists each folder once, so the strace control sees half the `opencode.json` opens (4, 2.2.5: 8). With no `OPENCODE_CONFIG`, the control turn went to OpenCode's free model and succeeded (on 2.2.5 the free limit had run out); Isomux always sets `OPENCODE_CONFIG`. | `pm-p4-layers.json` |
| P8 | Migration and rollback | PASS. A 2.2.5 profile (3 sessions, 2 repositories) on 2.2.7, back on 2.2.5, and on 2.2.7 again: each step lists every session with the same messages, continues a session with its history, and Isomux's storage check reads each session as present. Same tables and `session_v2` columns. | `mg-p8-migration-rollback.json` |
| Migration 20260805200742 | The edited legacy credential import | See below. | `migration-200742.json` |
| Flags | Tools that a feature flag turns on | See below. No new path past Isomux's checks. | `flags.json` |
| Skills | Skill folders | PASS: the same four folders as on 2.2.5. | `skill-folders.json` |
| `/goal` | Prompt text with a slash command | PASS, as 2.2.5: the text reaches the model as it is; no command runs. | `goal-prompt.json` |
| Live | `bun run test:opencode`, with `OPENCODE_API_KEY` set | 199 of 199 pass, 0 fail, 0 skip, on the 2.2.7 binary. The Folder and Web probes still see `opencode_worktree_remove`, and the safety plugin refuses it. | - |

## What moved

- **Fewer endpoints wait for plugins.** In 2.2.7, `agent.list`,
  `integration.list`, `usage.limits`, `vcs.init`, `rpc.call` and `artifact.*`
  no longer wait for the folder's plugins. `GET /api/agent` lists what has
  loaded when it is read: 0 agents as the first request to a new folder (P3,
  and P4 part a), `build` and `general` with built-in rules after a
  `GET /api/config` for the folder (P1), and every agent, the folder's own
  too, after a `GET /api/model` (P3 control). Isomux calls none of these
  routes. The
  routes Isomux uses keep their behavior: `GET /api/plugin` (the transport's
  safety plugin check) never waited and is polled until the Isomux row is
  active; `GET /api/model` and `GET /api/provider` (the catalog) still wait
  up to 5 s (`server/src/handlers/model.ts`, `provider.ts`); a prompt waits
  for activation (`core/src/session/prompt.ts:40`) and so does each tool call
  (`session/runner/llm.ts:299`). Measured: a prompt with no check reaches no
  tool before the hook is live (P3, 8 of 8 denied; reload 6 of 6).
- **Feature flags.** 2.2.7 adds `OPENCODE_FLAGS` (environment) and
  `experimental.all_flags` (config), beside the `experimental.<key>` config
  keys 2.2.5 already read. The flags that add tools are `todo` (`todowrite`),
  `schedules` (`schedule_*`) and `artifacts` (`artifact_*`); `codemode_vm`
  swaps the Code Mode interpreter; `console_watches` lets Console events wake
  a session; `media_blob` and `background_compaction` change storage and
  compaction only. A release build has every flag off by default (channel
  `latest`, `core/src/flag.ts`). Measured (`flags.json`):
  - `OPENCODE_FLAGS` from the member's or the office's environment does not
    reach the server: `openCodeServerEnvironment` drops every `OPENCODE_`
    variable but `OPENCODE_API_KEY`. In a raw server it turns the tools on.
  - A project config (`opencode.json` in the repository) turns them on with
    `experimental.all_flags` or `experimental.<key>`. On 2.2.5 the named keys
    did the same, so this path is not new. Below Standard the server runs
    with project config off, and the tools stay off.
  - The member's own config folder turns them on. It is the member's own
    choice.
  - The OpenCode Console layer cannot: it keeps only `providers`, `mcp`,
    `policies` and `websearch` (`core/src/config/integration.ts`).
  What each tool can do, and what stops it:
  - `todowrite`: session state only.
  - `artifact_create` and `artifact_update`: write the model's files to
    `<profile>/data/opencode/artifacts/<id>/`. Each path is relative with no
    `..` (`core/src/artifact.ts` `normalizePath`); the id is new on create
    and must name a stored record on update and delete. The safety plugin does
    not check these calls. They cannot write outside that folder.
  - `schedule_*`: a schedule later sends a prompt to the session on the
    OpenCode server, not through the transport. Each tool call of that run
    still waits for plugin activation and goes through the safety plugin hook.
  - `codemode_vm`: both interpreters call each tool through the same
    `execute.before` path (`core/src/codemode/tool.ts`), so the hook still runs.
  At Standard, the same project config can also load a project plugin, which
  runs any code in the server (P3). So the flags give a repository no power
  it does not have today.
- **`session_move`** (a Code Mode tool) now asks `external_directory`
  before it moves the session out of the project. Isomux's rules ask it at
  Standard (the safety adapter decides) and deny it at the stops below
  Standard. 2.2.5 moved the session with no ask. Stricter, no change needed.
- **`read` of a `skill://` path** reads an OpenCode Console skill file from
  memory and asks the `skill` permission. Below Standard `skill` is denied.
- **Shell results** add an `Exit code: N` line to the output text.
  `metadata.exit`, which the transport reads, is unchanged.
- **Migration 20260805200742** (import a legacy `auth.json` into the
  `credential` table) changed twice. A non-object `auth.json` now logs a
  warning instead of failing the migration. And a new, empty database now
  runs the import at the first start (2.2.5 marked it done without running
  it, report-2.1.4 M6a). The migration table keeps ids only, with no hash.
  Measured: a profile that 2.2.5 made keeps the migration's row on 2.2.7 and
  back on 2.2.5, and nothing imports again. A new profile whose data folder
  holds an `auth.json` with one key gets 1 credential row on 2.2.7 (0 on
  2.2.5). Isomux wrote such a file only with the OpenCode 1 sign-in card
  (2026-08-28 to 2026-09-02), and every profile that has run OpenCode 2
  already has its database. The credential table is in the database file,
  which the read deny and the backup exclusion already cover
  (`backend-credential-paths.ts`).
- **Storage.** No new migration. `experimental.part_rows` (off by default)
  writes assistant parts as `session_part` rows. Isomux reads messages through
  the API and checks only the `session_v2` and `session_message` columns.
- **Events.** The event types the transport reads have the same schemas.
  `usage.recorded` adds the source `generate`, and `credential.updated`
  names the credential. The transport reads neither.
- **Steers.** The inbox, interrupt and cancel code that
  `steer-delivery-design.md` §3.5 cites is unchanged in behavior
  (`session/inbox.ts` is a refactor; `run-coordinator.ts` is unchanged).

## Residual risks

- A member's project at Standard can turn on the artifact tools, which write
  into the member's own OpenCode profile with no safety check. 2.2.5 had the
  same path through `experimental.artifacts`.
- A schedule (project config at Standard) can start a turn on the OpenCode
  server that the transport did not send. Its tool calls are checked. Isomux
  does not show that turn, and nobody measured the agent's Isomux state while
  it runs (busy or idle), or what a member message that comes in during it
  does.
- A stored schedule does not fire while the flag is off for the session's
  folder: each due row checks the flag first and, when it is off, is marked
  `disabled` and checked again in an hour; it catches up once the flag is back
  on (`core/src/schedule.ts:429-434`, from the source). The flag is read on
  the server that holds the schedule. A session below Standard runs on its own
  server with project config off, so a schedule stored earlier on the
  member's Standard server reads the flag from that server, where project
  config is on, and can still fire there while that server runs (from the
  source, not measured).
- A schedule's shell check runs its command directly, not through the shell
  tool (`core/src/schedule/check.ts`, `runShell`). The command is asked as
  `shell` once, when the schedule is made, so the office policy sees it then;
  each later run is allowed without an ask, the safety plugin's hooks do not
  run, and the process gets the server's environment (`env: process.env`),
  which holds `OPENCODE_SERVER_PASSWORD`. 2.2.5 has the same code. From the
  source, not measured. Task `25ac1be4` holds the probe and the fix options.

## Reproduction

Run each probe with Bun from its own folder, with `GATE_ROOT`, `GATE_V2_BIN`
(the 2.2.7 binary in the Isomux `node_modules`) and `GATE_V1_BIN` (a 2.2.5
binary). `reload.ts` takes `TOOL=read` or `TOOL=shell`, and `sp-p6-census.ts`
takes `v2`.
