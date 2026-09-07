# Separate office Claude sign-in

Task cbea0f74. Design only; Nil must approve implementation. Source baseline
`08c4c8c`; source and provider docs checked 2026-09-07. No real provider home
was inspected. **Recommend C: move owned conversations at boot**, plus the
skill-sharing plan below. The addendum proposes that exact-id access, without
listing, keeps the office rule intact; Nil must confirm that premise before C
or D proceeds. This replaces the earlier conditional bridge recommendation.

## What breaks, and what stays compatible

Office Claude currently uses `~/.claude`, unless office/process
`CLAUDE_CONFIG_DIR` selects another root (`server/provider-account-manager.ts:248`).
Personal activation selects `<STATE_ROOT>/provider-homes/<userId>/claude`;
an explicit user value wins (`server/env-loader.ts:78`, `server/provider-homes.ts:35`).
Recommend `<STATE_ROOT>/claude-home` as the new office default, using the
existing `ISOMUX_HOME` resolver. Keep personal homes and all explicit office,
process and per-user roots unchanged. No new env variable.

The directory selects both login and `projects/<encoded-cwd>/<sessionId>.jsonl`
(`server/cwd-utils.ts:76`; encoding replaces non-alphanumeric/non-hyphen
characters with `-`). Resume recomputes the owner's current environment,
not its historical root (`server/agent-manager.ts:4648`). Thus a default-only
change moves every default-office agent's lookup at once. The picker still
reads Isomux logs (`server/persistence.ts:572`, `server/command-handlers.ts:574`),
but old native sessions fail preflight (`server/backends/claude.ts:1409`).
Restart restore uses the same path (`server/agent-manager.ts:1745`).

Scratch result, 2026-09-06, Bun 1.3.11 / SDK 0.3.257: old root → picker lists
session, preflight and diagnosis are null; new empty root → same picker entry,
preflight rejects, diagnosis says missing. Reproduction is below. This proves
the preflight failure, not live native resume. Both errors wrongly blame cwd:

> Cannot resume session 11111111…: its file is missing from <new-project-dir>. Most commonly this happens after the cwd was moved or renamed - the Claude CLI stores sessions under a path derived from cwd. Move the session .jsonl into the new project directory to recover it.

> Likely cause: session `11111111…` was not found in `<new-project-dir>`. This usually happens after cwd was moved/renamed - the Claude CLI locates session files by a path derived from cwd. Use /resume to pick another session, or move the session .jsonl into the new project dir.

Fix these strings (`server/backends/claude.ts:1412`, `server/cwd-utils.ts:425`)
to identify config-root/migration failure where known; no routine manual file
move advice. Preflight/diagnosis use one exact-file `existsSync` (`:84`), not
`readdir`. Shutdown detection reads that file's tail (`:108`); cwd edits check
exact paths, create the target directory, and rename transcript/sibling data
(`:344`). Migration must also cover cron resume (`server/cronjob-manager.ts:1692`)
and edit-fork SDK reads (`server/backends/claude.ts:1420`).

## Four options

Exact owned-session access is proposed, awaiting Nil's confirmation; listing
or scanning the legacy projects tree is excluded. None of these options copies credentials.

| Option | Loss risk and login result | Code kept long-term | Read rule and backup |
| --- | --- | --- | --- |
| A. Bridge `new/projects` to old tree | No move loss; independent office login. Permanently exposes all box conversations and writes new office history there. | Small setup plus permanent link/conflict handling. | Broad alias needs separate approval. Upgraded history stays outside state-root backups; fresh installs differ. |
| B. Pin each old session's root | No move loss; old sessions depend on valid box login. New sessions get new login/storage. | Permanent pin logic across resume, forks, diagnosis and cron. | Exact-file access; cwd edits still write legacy paths. Old history outside backup, new history inside. |
| **C. Move owned sessions at first updated boot** | Transfer interruption/conflict risks require a journal. After completion all owned history uses new login/storage. | Versioned upgrade helper retained for late upgraders; normal runtime has no old-root branch. | Only recorded ids/cwds and their owned files; no project-tree listing. Moved and new history enter backups. |
| D. Move each old session on first resume | Same transfer risks, spread across future resumes. Unused old history stays dependent on old disk retention. | Permanent lazy migration and concurrency logic on every resume/fork/cron path. | Same exact-id rule. Backup coverage grows only as old sessions move. |

**E. Floor:** the existing revival fallback (`server/agent-manager.ts:2016`,
`:7359`): keep displayed Isomux history, start fresh native context. It violates
“must not orphan resumable sessions”; do not select it silently.
B must pin sessions, not agents: `server/persistence.ts:199` stores all session
metadata; `:670` stores only the active id. `/clear` nulls the active id but
retains old metadata (`server/agent-manager.ts:7398`, `:7465`).

### C/D transfer contract

Moving owned entries removes them from the box CLI's old-root picker. Undo
requires a coordinated reverse transfer; it is not trivial after sessions have
continued in the new root. Extend `moveClaudeSessionFile`
(`server/cwd-utils.ts:344`) with distinct source/target roots instead of writing
a second mover. Its current single-env signature only moves between cwds in
one root. Retain its no-overwrite checks and sibling-directory handling, adding
the journal and cross-filesystem fallback below.

Inventory **Isomux's own state**, including live and killed agents' logs and
session metadata, all cron run rows (`rootSessionId`, `currentSessionId`,
`cwdSnapshot`), run log filenames, and fork maps. Sources:
`server/persistence.ts:199,572,670` and `server/cronjob-persistence.ts:148,239,251`.
Use each recorded session cwd; deduplicate ids/paths and exclude placeholder
ids. Missing legacy cwd/engine metadata uses existing recorded-agent fallback
only when unambiguous; otherwise preserve the record and report a blocker.
Move only sessions affected by the default change, never explicit/personal roots.

Construct exact source/destination paths for the transcript, its session-owned
sibling directory (subagents/tool results), and any id-keyed checkpoint/task
assets required by that session. Never enumerate project directories or import
project-wide memory. Descending within an already identified session-owned
asset subtree is not discovery of other sessions. Audit recorded absolute
asset references: preserve their exact legacy targets where relocation would
break them; do not delete a referenced asset or rewrite arbitrary transcript
text. This can leave ancillary files outside the state root; test and document
that limit before claiming complete portable backup. A native resume/fork with
spilled results and checkpoints is an implementation acceptance gate.

Journal each move under STATE_ROOT. Quiesce the affected session before any
move. Use rename on the same filesystem; on EXDEV, copy to a temporary target,
verify bytes and durability, publish without overwrite, then remove the source.
Keep per-file progress until transcript and required assets are complete. After
a crash, use the journal to finish/reconcile; matching targets are reusable,
different targets block that session. Never discard either version to resolve
a conflict. Missing source plus verified completed target means done; missing
both means a visible missing-session error with its picker/log retained. Do not
mark missing history as successfully migrated or replace it with fresh context.

For C, first boot runs after environment import and before agent restore or
cron dispatch. The old service must have stopped its subprocesses; an in-flight
turn is interrupted, and migration moves its durable transcript before the next
resume. It cannot recover unflushed output. Allow unaffected agents to start;
block only unresolved sessions. Retries resume the journal automatically.
For D, register legacy records at boot but move before native preflight and any
fork/read that needs them; serialize concurrent requests for the same session.
Both need current-source provenance checks: metadata has no historical root,
so an ambiguous past account switch must surface, not trigger an external scan.

**Codex does not need a transcript move in this change.** Its default already
uses `<STATE_ROOT>/codex-home` (`server/backends/codex/native-bin.ts:35,119`);
explicit homes remain intact. Commit `1f79f6d` did not preserve old auto-resume,
so it is only a default-resolver precedent. Codex's skill/config access still
needs the inventory below; no retroactive Codex history migration is implied.

## Keep skills and deliberate configuration

“Expected” below is a product recommendation about user expectations, not a
user-study result. **Share** means read named configuration/skill locations,
not share a whole provider home. **Copy once** means import selected non-login
configuration into the office-owned root, preserving relative-path meaning and
merging Isomux's settings; never copy a mixed file blindly. **Leave** preserves
the original. Explicit/personal homes keep their existing behavior.

| Item and source | Expected to follow? Proposed action |
| --- | --- |
| Claude `skills/`, `commands/`; Codex local skill directories | Yes: **share** skill trees and their resources so updates remain visible; include common locations below. |
| Claude `CLAUDE.md`, `rules/`, `agents/`, `output-styles/`; Codex `AGENTS.md`/`AGENTS.override.md`, custom agent instructions | Yes for authored guidance: **share** named files/trees, preserving provider precedence and Isomux instructions. Project guidance stays in cwd. |
| Claude `settings.json` (permissions, env, model, hooks, plugin enablement); Codex `config.toml`/profile files (provider, MCP, model, trust, agent settings), `rules/` | Yes for deliberate behavior: **copy once** selected settings/rules, rebase relative paths, retain office permission and native-memory overrides. Keep login/provider credentials out; review mixed secret values through the consuming importer, never chat output. |
| Hook definitions and referenced scripts: Claude settings/plugins; Codex `hooks.json` or inline config | Yes: **copy once** definitions; **share** referenced scripts. Merge the Isomux safety hooks and validate paths; never symlink Codex hooks/config because its installer writes them. |
| Claude plugin registry/cache; Codex plugin registrations/cache | Yes for installed capabilities: **share** code/skills from registered install paths; **copy once** selected enablement/registrations. Keep mutable plugin data and credentials in their original scope; separate native registration from mere skill discovery. |
| MCP configuration: Claude user `.claude.json` (outside the default home) and project `.mcp.json`; Codex config | Yes for tool definitions: **copy once** non-login server definitions, **share** project config unchanged. Leave OAuth and authentication state; reconnect where needed. Never copy the whole Claude app-state file. |
| Claude `projects/*/memory`, `agent-memory/`; Codex generated memories | Often expected by CLI users, but **leave**: Isomux deliberately disables native memory for both backends. Authored CLAUDE/AGENTS instructions above are separate. |
| Native transcripts and session-owned assets | Office conversations: C/D above; non-office conversations: **leave**. Codex session/archive/runtime database state: **leave** because its root is unchanged. |
| Claude `history.jsonl`, `debug/`, `file-history/`, `tasks/`, `paste-cache/`, `uploads/`, `shell-snapshots/`, `backups/`; Codex prompt history, logs, caches, shell snapshots | No bulk import: **leave**. Preserve exact assets referenced by owned sessions as specified above; prompt recall and CLI diagnostics are not office chat history. |
| Claude keybindings/themes and app state; Codex TUI preferences | No for this UI: **leave**. Newer workflow/plugin formats need backend-version support before import; never advertise unverified execution. |
| Claude `.credentials.json`, Codex `auth.json`/keyring | Re-sign-in accepted: **leave**, never copy or share. |

Inventory evidence: [Claude directory](https://code.claude.com/docs/en/claude-directory),
[Claude settings](https://code.claude.com/docs/en/settings),
[Codex config](https://learn.chatgpt.com/docs/config-file/config-advanced),
[Codex reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
These current docs describe optional/version-dependent files, not an assertion
that each exists on this box. Local SDK 0.3.257 types say omitted settingSources
loads user/project/local (`sdk.d.ts:2057`); `server/backends/claude.ts:1318`
omits it for agent sessions. Account/one-shot queries intentionally use `[]`.
Native memory is disabled for **agent sessions** by the settings applied at
`server/backends/claude.ts:1342` and
`server/backends/codex/adapter.ts:148`. Claude also supplies Isomux safety hooks
in code (`server/backends/claude.ts:1344`), so the home move does not remove
them. Codex writes its safety-hook config in
`server/backends/codex/safety-hook-install.ts:227,377`.

**Isomux's loader today:** `server/skills.ts:90,134,144,292` scans STATE_ROOT
skills, the selected Claude root's skills/commands, cwd `.isomux/skills`,
`.agents/skills`, `.claude/skills`/commands, registered Claude plugin install
paths, and bundled skills. Menu and prompt resolution share that precedence;
`server/agent-manager.ts:1882` supplies the root for all engines. It does not
walk repository parents or add home `.agents/skills` and external Codex skills.
Codex emits empty slashCommands (`server/backends/codex/adapter.ts:817,835`),
so native model discovery alone does not fill Isomux's menu.

Recommend one ordered list for menu, execution and native skill exposure:
keep existing precedence; include office/effective-root skills, then named
external Claude/Codex skill trees and `$HOME/.agents/skills`; walk project
`.agents/skills` to the repo root as [Codex documents](https://learn.chatgpt.com/docs/build-skills).
Include legacy `CODEX_HOME/skills` where supported by the pinned backend;
prefer native skills/list paths for Codex plugins/admin/system skills over
inventing cache paths. Deduplicate by canonical source and preserve namespaced
plugin identities. Native Claude can expose selected skills as per-skill links in the new
root, without linking a provider home. For Codex, test per-skill links and
`skills.config` path/enablement on 0.153.4; the docs describe enablement,
not a guarantee that an arbitrary path becomes discoverable.
Prove menu selection, resource resolution, and model invocation on scratch
fixtures for both engines. No scan of provider projects is part of skill loading.

## Flow, size and decision

Default office users sign in again. Keep the conditional external warning for
explicit external roots (`ui/components/ProviderSignInCard.tsx:268`); it vanishes
for the new default. C moves owned transcripts inside backup scope; retained
external assets need an explicit backup limit (`server/backup.ts:136`; default Claude backup row:
`internal-docs/backup-restore.md:88`). Update
`docs/features.md`, `docs/self-hosted.md`, `api/chat.ts`,
`internal-docs/backup-restore.md`, and `internal-docs/post-release-verification.md`,
as indexed by `internal-docs/documentation.md`. Nil approves user copy.

Estimate, 2026-09-07: C plus skill/config continuity 4–6 engineering days;
D 5–7 due to permanent resume-path support. Earlier A/B estimates excluded
this inventory. About 10–15 code and 8–12 test files: default/env/account paths,
agent and cron persistence/boot, transfer helper, cwd/backend resume/fork,
skill discovery/resolution and native exposure, config import, backup tests.
Gates cover interrupted/EXDEV transfers, conflicts/missing metadata, ownership
(non-office sentinel unchanged), cron/forks/checkpoints, explicit/personal
roots, logout independence and skill continuity. Build/scoped tests/ESLint on
committed code; tsc once before final PM handoff. No implementation or restart
yet. Suggested ruling: **C, keep personal/explicit roots, share skills and
import selected configuration as above.**

<details>
<summary>Scratch failure reproduction (no login or model request)</summary>

Run the following saved as `probe.ts` at the worktree root with
`ISOMUX_HOME="$PWD/.scratch-login-split/state" bun probe.ts`. Use an empty
scratch root. The 2026-09-06 worker probe was removed; Reviewer 4 also reproduced
it against `886fcfc` and reported `/tmp/claude-login-split/probe.ts` and
`probe-out.log` (attributed reviewer evidence). Exact error strings appear above.

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.ISOMUX_HOME!;
const { claudeProjectDir, diagnoseProcessExit } = await import("./server/cwd-utils.ts");
const { claudeBackend } = await import("./server/backends/claude.ts");
const { listAgentSessions } = await import("./server/persistence.ts");
const cwd = join(root, "cwd");
const oldEnv = { CLAUDE_CONFIG_DIR: join(root, "old-claude") };
const newEnv = { CLAUDE_CONFIG_DIR: join(root, "new-claude") };
const sid = "11111111-1111-4111-8111-111111111111";
mkdirSync(cwd, { recursive: true });
mkdirSync(claudeProjectDir(cwd, oldEnv), { recursive: true });
writeFileSync(join(claudeProjectDir(cwd, oldEnv), sid + ".jsonl"),
  JSON.stringify({ type: "user", sessionId: sid,
    message: { role: "user", content: "scratch" } }) + "\n");
const logs = join(root, "logs", "scratch-agent");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, sid + ".jsonl"),
  JSON.stringify({ type: "user_message", text: "scratch" }) + "\n");
for (const env of [oldEnv, newEnv]) {
  console.log({ picker: listAgentSessions("scratch-agent").map(s => s.sessionId),
    preflight: claudeBackend.checkSessionResumable(sid, { cwd, env }),
    diagnosis: diagnoseProcessExit(cwd, sid, env) });
}
```

</details>
