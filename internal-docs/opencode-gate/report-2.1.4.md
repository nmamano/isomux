# OpenCode 2.1.4 safety and feasibility gate

Date: 2026-10-25\
Task: `4840abc5`, the first slice of the move from OpenCode 1 to OpenCode 2\
Recommendation: **GO for the cut-over to `@opencode/cli` 2.1.4**, with the
conditions below

No item meets a hard-fail condition. Every finding that the cut-over must handle
is a condition, and each condition goes into one of the cut-over tasks as an
acceptance line. Two upstream risks stay open (see "Upstream risks").

## Tested versions and host

- OpenCode 2: `@opencode/cli` 2.1.4 (npm `latest`, 2026-10-25), with
  `@opencode/client` and `@opencode/plugin` 2.1.4 for types only.
- OpenCode 1 baseline: `opencode-ai` 1.18.35, the current pin.
- Host: `auntie-2`, Linux `6.8.0-147-generic`, 8 CPUs, 23 GiB RAM.
- Model calls went to a deterministic local OpenAI-compatible mock
  (`harness-2.1.4/mock-openai.ts`), and no real credential was used. The one
  cloud call of the gate was a control in P4: with no model configured, 2.1.4
  sent the gate's canary prompt to OpenCode's free model `opencode/big-pickle`
  (`pm-p4-free-models.json`).
- Each server ran under its own HOME, XDG and TMPDIR directories below
  `/tmp/t-4840abc5`, on loopback with a password. Item P8 used copies of two
  real office profiles (history only; office profiles hold no credential file)
  with fake credential files of the version 1 format.

The probe scripts are in [`harness-2.1.4/`](harness-2.1.4/) and the evidence is
in [`evidence/2.1.4/`](evidence/2.1.4/). Evidence files hold counts, hashes,
event shapes and the gate's own sentinels, never real transcript text, session
titles, paths or secret values.

## Verdicts

S items are the gate in `opencode-backend-scope.md`. P items are the nine gate
items in the 2026-10-23 packet, with the method changes Reviewer 4 required.

| # | Check | Verdict | Reason | Evidence |
|---|---|---|---|---|
| S2 | Parallel sessions in two repositories | PASS | Canaries, events, files, tool and permission ids, and durable sequences stay in their own session. A permission reply under the other session's path returns 404. | `ev-s2s3.json`, `ev-s2-*.json*` |
| S3 | Restart and resume | PASS | After SIGTERM and a new start, both sessions keep their message ids and the next turn recalls the first turn's canary. | `ev-s2s3.json`, `ev-s3-events.jsonl` |
| S4 | Fixtures | PASS-with-condition | Fixtures for text, reasoning, shell allow and deny, edit and write, a failed tool and recovery, abort (6 variants), fork, compaction and an authentication error. Conditions T3-T5. | `ev-fx-*.jsonl`, `ev-s4*.json`, `ev-compact.json` |
| S5 | Tool call pairing | PASS-with-condition | 13 of 13 calls keep one id from input to terminal, with exactly one terminal event each. The id is the provider's tool call id, which can repeat across sessions and turns. Condition T6. | `ev-analysis.json`, `ev-fx-fixed-ids.jsonl` |
| S6 | One completion signal per turn | PASS-with-condition | 50 of 53 busy periods have exactly one terminal event, after the last text and tool event; none has two. A follow-up prompt sent during a turn shares that turn's terminal event, a SIGTERM mid-turn gives none, and `session.status`/`session.idle` are never sent. Conditions T1-T2. | `ev-analysis.json`, `ev-s4-restart-c-*` |
| S7 | `--pure` | Superseded | Isomux loads project and user code since 2026-10-15 (Nil, 2026-10-11). P5 records what loads. | - |
| S8 | Memory | PASS | One idle 2.1.4 server uses about 226 MiB RSS, and 16 sessions mid-turn add about 57 MiB, against about 380 MiB and 202 MiB for 1.18.23 on 2026-08-27. See "S8 memory". | `fx-rss.json` |
| S9 | Secrets | PASS-with-condition | The password and the provider key sentinel appear 0 times in server output, the log, every file of the data directory including the database, the event stream, nine API bodies and process command lines; each location had a positive control. The provider's response header does not reach events, messages or the log. The password does reach the tool environment. Condition E2. | `sp-s9-secrets.json`, `ev-s4.json` |
| S10 | Pin, platforms, advisories, update | PASS-with-condition | A repeated exact install changes no hash. 2.1.4 ships the same 12 platform builds as 1.18.35, under new package names. `bun audit`, `npm audit` and GitHub list no advisory for `@opencode/*` (a control audit of `opencode-ai@1.0.200` finds one). `serve` makes no update request. The profile survives a reinstall. Condition E6. | `mg-s10-update-pin.json` |
| P1 | Permission keys | PASS-with-condition | Expected matrix first, then a real tool call per agent and action. Ask for shell and edit and deny for question hold on `build`, `isomux-interactive-bypass` and `isomux-cron` (45 of 45 cells inside the session folder). A key-for-key rename loses OpenCode 1's default ask for paths outside the folder. Condition C1. | `pm-p1-expected.json`, `pm-p1-observed.json`, `pm-v1-effective-rules.json` |
| P2 | "Always" scope | PASS-with-condition | "Always" saves a command-prefix rule for the whole project: other sessions, clones with the same root commit and sessions after a restart are not asked. Answering "once" and adding the rule to the session's own rules keeps it in that session, also after a restart. Condition C2. | `pm-p2-always-scope.json` |
| P3 | Safety plugin, load check, order | PASS-with-condition | A thrown error in `execute.before` blocks shell and edit calls, also in a subagent's child session, and the turn continues. The Isomux plugin runs after a project plugin that rewrites the command and denies the rewritten command. A project config cannot remove it. Plugin load fails open, and a project plugin with the same id displaces it; a per-folder check by path detects both. Conditions S1-S3. | `sp-p3-plugin-order.json`, `sp-p3-failclosed-race.json` |
| P4 | Config layers and environment | PASS-with-condition | Isomux's top layer wins single-value keys over a project file. A project agent block with allow-all beats a rule that Isomux sets only at the top level; rules in Isomux's own agent blocks and rules set at session create win. Each environment variable that `start-server.ts` sets was checked by behaviour. Conditions C1, C3, E1-E5 and E4a. | `pm-p4-layers-a.json`, `pm-p4-layers-b.json`, `pm-p4-layers-c.json` |
| P5 | Project code | Recorded | At folder open 2.1.4 imports `.opencode/plugins` code and starts local MCP commands without a prompt; formatters run after an edit; skills, AGENTS.md, agents and commands load. `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops all of these except nested AGENTS.md files read later. 2.1.4 no longer installs its plugin SDK into config folders; npm plugin entries install only below `$XDG_CACHE_HOME/opencode/npm`. | `sp-p5-project-code.json` |
| P6 | Process identity and footprint | PASS-with-condition | The real `OpenCodeAuthorityBroker` accepts foreground and background shell calls and a persistent terminal, and refuses a detached process, a process the server did not start and a wrong turn handle. Compared with 1.18.35, 2.1.4 adds two things outside the profile: probes of 127.0.0.1 ports 1234, 11434 and 8000 at start, and a persistent-terminal socket below a fixed `/tmp/opencode-pty-<uid>/`. Condition E5. | `sp-p6-ancestry.json`, `sp-p6-census-v1.json`, `sp-p6-census-v2.json`, `sp-p6-pty-sigkill.json` |
| P7 | Concurrency (#53146) | PASS-with-condition | Soak: 3 runs, 528 turns, 16 sessions in 2 repositories, a SIGTERM and a SIGKILL mid-turn per run: 0 sequence or UNIQUE errors, every turn outside the kill rounds succeeded, every killed session continued, and every database check after a restart was clean. OpenCode itself does not stop two servers on one profile; Isomux can, and must. Conditions M1-M4, M9 and T9. | `cc-p7b-run{1,2,3}.json`, `cc-p7a-overlap.json`, `cc-p7a-alternate.json`, `cc-p7-codereading.json`, `fx-seq-migrated.json` |
| P8 | Migration and rollback | PASS-with-condition | On a copy of a real profile (28 sessions) 2.1.4 imported every session in 2.05 s, including sessions from folders without git, and continued an old session with its history. 1.18.35 on the kept copy listed the same sessions and continued one with its history. Conditions M5-M9. | `mg-p8-migration-rollback.json`, `mg-p8-census-diff.json` |
| P9 | Member config with version 1 keys and plugins | PASS | The server starts and runs a turn. A version 1 plugin runs its top-level code and is then reported as failed; its hooks never run. Condition R1. | `mg-p9-v1-config-plugin.json` |

## S8 memory

Measured 2026-10-25 with the mock holding one response open per session, so
every session stayed busy (checked before and after each sample). RSS and PSS
are of the server process; no child process existed in any sample. Each run had
its own `systemd-run --user --scope -p MemoryMax=4G` cgroup, and `oom_kill`
stayed 0 in all 9 runs. `free -m` showed 18569 MB available before the
16-session runs.

| Load | 2.1.4 (2026-10-25) | 1.18.23 (2026-08-27, `report.md`) |
|---|---:|---:|
| Idle server, RSS (3 runs) | 227.5 / 227.6 / 224.2 MiB | 351-381 MiB |
| 1 session mid-turn, above idle | +1.0 MiB | +94.1 MiB |
| 8 sessions mid-turn, above idle | +27.7 MiB | +96.9 MiB |
| 16 sessions mid-turn, above idle (3 runs) | +60.9 / +52.7 / +57.2 MiB | +201.5 MiB |

These are floors: the mock sends almost no tokens and no tool output. Live
certification measures real provider streams.

## Conditions for the cut-over

Each line below is an acceptance line for the cut-over task named in its
heading.

### Transport rewrite

- **T1.** A turn ends at the first `session.execution.succeeded`, `failed` or
  `interrupted` for the session. Isomux does not count terminal events per
  prompt: a follow-up sent during a turn belongs to that busy period.
  `session.status` and
  `session.idle` are never sent and are not a completion signal.
- **T2.** `/api/event` is volatile and `/api/experimental/session/:id/log`
  replays nothing on `opencode serve` (event persistence is off outside
  workerd). After a lost stream or a server restart, Isomux reads the session's
  messages and its outcome fields, as today it fails the turn on stream loss.
  A SIGTERM mid-turn gives no terminal event, and `serve` does not resume a
  suspended turn; the next prompt works.
- **T3.** A denied permission (`reject`) ends the turn as `interrupted` with
  reason `shutdown`, not as a failure; a user interrupt has reason `user`.
  A shell command that exits non-zero is `session.tool.success` with
  `metadata.exit`, not `session.tool.failed`.
- **T4.** A failed compaction (`session.compaction.failed`) does not fail the
  turn; Isomux shows it from the compaction event.
- **T5.** Fork with `before` gives a child with the history before that
  message and new message ids; the parent stays unchanged. Abort is
  `POST /api/session/:id/interrupt`; with `resume=true` a steered follow-up
  runs at once.
- **T6.** Tool state is keyed by `(sessionID, assistantMessageID, id)`.
- **T7.** `GET /api/session/:id/message` refuses `cursor` together with
  `order`.
- **T8.** `--log-level` takes lowercase values only (`INFO` fails at start).
  2.1.4 needs an explicit `--port` (no port 0), and its health route is
  `GET /api/info`.
- **T9.** A sequence collision (#53146) leaves the turn running with no
  terminal event: a positive control that set one session's counter to 0 made
  the next turn fail its insert (`UNIQUE constraint failed`, in the log only)
  and never end (`fx-seq-migrated.json`). The transport gives such a turn an
  end that the member sees, for example from the server log or a no-progress
  deadline; Stop stays the fallback.
- **T10.** An authentication error arrives as `session.step.failed` and
  `session.execution.failed` with `error.type` `provider.auth` and status 401,
  with no retries. The error body text reaches events and the log; the
  redaction boundary in `errors.ts` stays.

### Safety plugin

- **S1.** The plugin is rewritten for `Plugin.define({ id, setup })` with
  `ctx.tool.hook("execute.before")`, as a directory entry (a file path is
  skipped), listed last in `OPENCODE_CONFIG_CONTENT` `plugins`.
- **S2.** Before every prompt, as the OC1 transport checks the safety plugin
  before every turn (`requireSafetyPlugin`), Isomux reads `GET /api/plugin`
  for the session's folder and refuses the turn unless the row whose
  `source.path` is the Isomux plugin is `active` and no other row claims its
  id. An empty list means "still loading"; a deadline ends the wait with a
  refusal. A folder can reload (`POST /api/location/reload`, a config change)
  and a project plugin with the Isomux id displaces it, so a check at the first
  prompt only is not enough. Measured 2026-10-25 in 20 new folders: active after
  357-1842 ms (median 441 ms); the list was empty before that in 20 of 20, and
  never showed other plugins without the Isomux plugin. A warm folder answers
  at once. This replaces the
  `isomux_safety_active` tool check, since 2.1.4 has no tool-id route.
- **S3.** Because a shell command now asks for paths outside the folder only
  through `workdir` and `cd`, the safety policy covers outside paths in
  command arguments (`cat`, `rm`, `cp` and similar), as 1.18.35 did through
  its `external_directory` check.

### Config layers and environment

- **C1.** Isomux sends its full rule list at session create, including
  `{external_directory, *, ask}`, repeats it in each of its agent blocks in the
  top layer, and passes `agent` explicitly (`build` for a normal session).
  Tool names change: `bash` to `shell`, `task` to `subagent`, `write` and
  `patch` to `edit`. The config keys change: `permission` to `permissions`
  (a rule list), `provider` to `providers`, `autoupdate` to `update`.
- **C2.** Isomux never sends `always`. It answers `once` and replaces the
  session's rule list (`PATCH /api/session/:id`, which replaces the whole
  list) with its base rules plus the new allow. A child session copies the
  parent's rules only at create.
- **C3.** A malformed `OPENCODE_CONFIG_CONTENT` is dropped with a warning only.
  Isomux checks that `GET /api/config` lists the pathless top-layer document
  before the first prompt. `GET /api/agent` returns an empty list for a new
  folder for about 2 s; Isomux does not read rules from an early answer.
- **E1.** `OPENCODE_CONFIG_DIR` replaces the global config directory (in
  1.18.35 it added a layer). Isomux keeps pointing it at the member's config
  directory only when that directory exists.
- **E2.** Outcome: after the cut-over, no agent tool call can get the server
  password or call `GET /api/credential`. With the password, a caller reads
  every stored provider secret from that route, which goes around the read
  deny on `auth.json`. The sources and their controls:
  - the tool environment: 2.1.4 in `serve` mode keeps the password there
    (`sp-s9-secrets.json`); Isomux removes `OPENCODE_SERVER_PASSWORD` and
    `OPENCODE_PASSWORD` from it, or starts the server so that OpenCode does;
  - the server record `<profile>/server.lock`, which holds the password
    (`ServerRecord.password` in `supervisor.ts`) and has no read deny: the
    read deny covers it;
  - the server's `/proc/<pid>/environ`, which can keep the start environment
    even after OpenCode deletes the variable, and which every process of the
    same OS user can read. The safety policy refuses reads of another
    process's environment (since 71f232bf, task f35d6442); the cut-over checks
    that the version 2 safety plugin applies that rule to the shell and read
    tools, as for the other sources. Same-user isolation stays out of scope (`opencode-oc1-scope.md`, a uid per
    agent is a separate project), so this is a policy check, not a boundary.

  This gap is not new. On 1.18.35 today the shell tool also inherits
  `OPENCODE_SERVER_PASSWORD` (and the username), and `GET /provider` and
  `GET /config/providers` return the stored key; `opencode-oc1-scope.md`
  accepts that an agent can read the shared server password. 2.1.4 returns
  the key from one route (`/api/credential`) instead of two
  (`r2-v1-credential.json`). The cut-over closes the gap, because in 2.1.4 the
  password is also the way to the credentials.
- **E3.** `OPENCODE_SERVER_USERNAME` and `OPENCODE_DISABLE_SHARE` are gone: the
  username is always `opencode`, and 2.1.4 has no share feature.
- **E4.** Isomux keeps an explicit model on every prompt, as the OC1
  transport does, and refuses a turn without one: without a model, 2.1.4 sends
  the prompt to its default free cloud model (`opencode/big-pickle`). Isomux
  does not set `OPENCODE_DISABLE_FREE_MODELS=1`: it removes the 9 free models
  that Isomux's Free model group, the Free Welcome Agent and the receptionist
  use. Isomux does not set `OPENCODE_DISABLE_MODELS_FETCH=1` either, which
  matches today: on 2.1.4 the flag stops the catalog fetch and its refresh and
  falls back to the catalog bundled in the binary, with the same 9 free models
  on 2026-10-25; on 1.18.35 it falls back to an older bundled list
  (`r2-models.json`). A later bundled snapshot can differ from the live
  catalog, so a change to this flag is a separate decision.
- **E4a.** Model discovery changes: `GET /api/model` lists only the enabled
  models of active providers (9 with no key), the full provider catalog is in
  `GET /api/integration`, and `GET /api/provider` is empty for the first few
  seconds after a start. Isomux's model list does not read an early empty
  answer as final.
- **E5.** Isomux sets `TMPDIR` inside the profile. The persistent-terminal
  daemon ignores it (fixed `/tmp/opencode-pty-<uid>/`); Isomux does not create
  persistent terminals, and only the client API can. 2.1.4 always probes
  local ports 1234, 11434 and 8000 for local model servers.
- **E6.** `runtime.ts` resolves the new package names
  (`@opencode/cli-<platform>`); the variant list stays the same.

### Migration and rollback

- **M1.** All starts and stops of a profile's server stay serialized under the
  `server.lock` record lock, with the prior server stopped before a start.
  2.1.4 started and migrated the database below a live 1.18.35 server, and both
  then served the same database with separate histories (`cc-p7a-overlap.json`).
- **M2.** When the recorded server's identity cannot be verified (no
  `startTicks`, unreadable `/proc`), `stop()` refuses to signal it and a new
  server starts beside it. The cut-over closes this: the start refuses while
  the record names a live process it cannot verify.
- **M3.** Stop signals the server's process group and waits for its exit after
  SIGKILL: shell tools outlived a SIGKILLed server in every kill round, and
  2.1.4 needed up to 1.14 s to exit on SIGTERM with 16 turns running (today's
  grace is about 1 s).
- **M4.** The version 2 server record stays in `server.lock`, as valid JSON
  with `pid`, `startTicks` and the binary path, so that the previous Isomux
  release refuses to adopt a live 2.1.4 server and stops it.
- **M5.** Before the first 2.1.4 start on a profile, Isomux keeps a copy of
  `data/opencode/opencode.db` with its `-wal` and `-shm` files and the log.
  2.1.4 rewrites the database in place (it empties `event`, drops three tables,
  adds five, fills `credential`), and a version 1 session written after the
  import never reaches 2.1.4. A rollback restores the copy; version 2 history
  is lost.
- **M6.** 2.1.4 copies `auth.json` into the database's `credential` table
  (`data/opencode/opencode.db`, `-wal`, `-shm`; `opencode-<channel>.db*` for
  other channels), and `auth.json` stays where it is. Agent reads of these
  database files are denied, but office backups keep them, because the
  database also holds every OpenCode session. Today one list,
  `backend-credential-paths.ts`, drives both the read deny and the backup
  exclusion, so the migration task either splits the two policies for this
  entry or keeps credentials out of the database; it does not add the
  database to the list as it is.
- **M6a.** 2.1.4 imports `auth.json` only into a database that has version 1
  tables. A profile with `auth.json` but no `opencode.db` gets an empty
  `credential` table: the empty-database path marks every migration done
  without running the import (`core/src/database/migration.ts:22-50`,
  `r2-v1-credential.json`). The migration task covers that case.
- **M7.** 2.1.4 does not import `mcp-auth.json`: members sign in again to MCP
  servers that used OAuth.
- **M8.** A session whose folder no longer exists answers a prompt with
  `LocationNotFoundError` (1.18.35 also fails there).
  1.18.35 writes a 40-byte project id to `<gitdir>/opencode` in the folder of
  each session it reads (the rollback runs did so in member repositories),
  which is normal 1.18.35 behaviour; for a worktree the file goes to the
  common git directory.
  `POST /api/session/:id/move` answers 204 before the move is done when the
  old folder still exists (52-488 ms later, `core/src/session/move.ts:129-156`);
  a caller waits for the move before the next prompt.
- **M9.** The import lowers each imported session's sequence counter to the
  highest message sequence it keeps (for example 217 to 17), which is safe:
  on a copy of a real profile and on a profile made by 1.18.35, every session
  had counter equal to its highest message sequence after the import, after
  two tool turns each and after a restart, and every turn succeeded
  (`fx-seq-migrated.json`).

### Release note

- **R1.** Members' OpenCode 1 plugins stop working: 2.1.4 runs their top-level
  code, reports them as failed and never calls their hooks. 2.1.4 maps some
  OpenCode 1 config keys (`permission`, `plugin`, `autoupdate`) and ignores
  other unknown keys; `CLAUDE.md` is no longer read (`AGENTS.md` is). A rollback
  to the previous Isomux release loses OpenCode 2 history.

## Upstream risks

- **#53146** (sequence collisions in one `opencode.db`) is still open on
  2026-10-25, and the 2.1.4 changelog does not name it. The soak and the
  migrated-session check found no collision, including the single-server
  case on imported sessions (M9). Isomux runs one server per profile (M1-M4).
- The server API description still says "Experimental", and the event,
  permission and plugin route groups are marked experimental. Isomux pins the
  exact version and expects a small transport change at each bump.

## Reproduction

The scripts are a frozen record of the 2026-10-25 run, without a package
manifest. Install the exact pin into a scratch directory, then run each probe
with Bun from the harness directory:

```sh
mkdir -p /tmp/t-4840abc5/oc2 && cd /tmp/t-4840abc5/oc2
bun add --exact @opencode/cli@2.1.4 @opencode/client@2.1.4 @opencode/plugin@2.1.4
```

`common.ts` holds the binary paths and the scratch root (`GATE_ROOT`,
`GATE_V2_BIN`, `GATE_V1_BIN`). For P8, copy a profile that no server uses
(`cp -a`) to `copy1` and `keep` in the run directory, replace its credential
files with fakes, and run `mg-p8.ts` per phase (`MG_TARGET` names the copy).
