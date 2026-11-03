# OpenCode 2.2.5 re-run of the gate

Date: 2026-11-03\
Task: `6dca5910` (a plugin reload during a turn unregistered the Isomux
`execute.before` hook on 2.1.4)\
Result: **the pin moves to `@opencode/cli` 2.2.5**, with the Isomux changes
below

Nil picked "Upgrade, re-test safety and migration" on 2026-11-03: the safety,
permission, config and migration items of [`report-2.1.4.md`](report-2.1.4.md)
ran again on 2.2.5, with the reload repro and `bun run test:opencode`. The
event, restart, concurrency and memory items (S2-S6, P7, P9, S8, S10) did not
run again.

## Tested versions and host

- `@opencode/cli` 2.2.5 (npm `latest`, 2026-11-03), from the Isomux install.
- `@opencode/cli` 2.1.4 as the baseline, in a scratch install.
- Host `auntie-2`. Model calls went to the gate mock
  (`harness-2.1.4/mock-openai.ts`). Each server ran under its own HOME, XDG
  and TMPDIR directories below `GATE_ROOT`.

The probes are the scripts of [`harness-2.1.4/`](harness-2.1.4/). Where 2.2.5
or a gone Isomux export broke a script, [`harness-2.2.5/`](harness-2.2.5/)
holds a copy with that one change (named on its first line), plus the new
probes of this run. The evidence is in [`evidence/2.2.5/`](evidence/2.2.5/).

## Verdicts

| # | Check | 2.2.5 | Evidence |
|---|---|---|---|
| Reload | A tool call while an earlier plugin reloads | FIXED. The call waits for the reload: the hook ran after the reloaded plugin's setup ended and denied, read 3/3 and shell 3/3. On 2.1.4 the read ran with no hook call and the file reached the events 3/3; the shell call had no hook call and stopped at `permission.asked` 3/3. Upstream: `session/runner/llm.ts` waits for `plugins.awaitActivation` before each tool call. The guard decides before it records (reviewer condition 1). The reviewer re-ran it on the final branch: the same. | `reload-window.json` |
| P3 | Safety plugin, load check, order | PASS, as 2.1.4. The plugin is active in 20 of 20 new folders, median 509 ms, max 3228 ms (2.1.4: 441 ms, 1842 ms). An active plugin row now names the plugin's folder, not `index.js`. | `sp-p3-plugin-order.json`, `sp-p3-failclosed-race.json` |
| S9 | Secrets | PASS, as 2.1.4. The password and key sentinels appear 0 times in each location; only the control counts move. | `sp-s9-secrets.json` |
| P6 | Process identity and footprint | PASS, as 2.1.4. The broker accepts and refuses the same cases. Outside the profile 2.2.5 writes only the `/tmp/opencode-pty-<uid>/` socket. | `sp-p6-ancestry.json`, `sp-p6-census-v2.json`, `sp-p6-pty-sigkill.json` |
| P1 | Permission keys | PASS, as 2.1.4: the 45 cells give the same results. `GET /api/agent` now lists the top-level rules in each agent's list too. | `pm-p1-observed.json` |
| P2 | "Always" scope | PASS, as 2.1.4. | `pm-p2-always-scope.json` |
| P4 | Config layers and environment | PASS, as 2.1.4. 2.2.5 adds a built-in rule `skill` `browser` deny. | `pm-p4-layers.json` |
| P8 | Migration and rollback | PASS. A 2.1.4 profile (3 sessions, 2 repositories) on 2.2.5, back on 2.1.4, and on 2.2.5 again: each step lists every session with the same messages, continues a session with its history, and Isomux's storage check reads each session as present. The reviewer re-ran it on the final branch: the same. | `mg-p8-migration-rollback.json`, `mg-p8-schemas.json` |
| Live | `bun run test:opencode`, with `OPENCODE_API_KEY` set | 164 of 164 pass with the changes below. The Folder and Web probes now expect one more tool (Code Mode tools, below). | - |

## What moved, and the Isomux changes

- **The OpenCode Console layer.** With `OPENCODE_API_KEY` set, 2.2.5 fetches
  the Console's config and adds it as a config document without a path
  (`core/src/config/integration.ts`). It can hold only providers, remote MCP
  servers, policies and web search. The check below Standard allowed one
  document without a path, so every turn below Standard failed for a member
  with that key. `openCodeConfigLayersRefusal` now passes a document whose
  keys are all of those four, and still requires exactly one other document
  without a path, Isomux's.
- **`bash` runs as `shell`.** 2.2.5's own `execute.before` hook
  (`plugin/tool-input-repair.ts`) runs a call to a `bash` tool as `shell`.
  Today the Isomux hook sees `shell`, but the safety plugin also checks
  `bash`, so the check does not depend on the hook order.
- **A new image tool.** `experimental_image_generate` is on when an image
  model is available. It reads each local image it is given and writes to
  `path`. The safety plugin checks each local image as a read and `path` as a
  write.
- **Code Mode tools at the stops below Standard.** The stops deny every tool
  and allow some by name, so Code Mode's `execute` is denied. 2.1.4 then
  offered no Code Mode tool; 2.2.5 offers each one directly whose permission
  is allowed (`core/src/tool.ts`). At Folder and Web that adds
  `opencode_worktree_remove`, whose permission is `edit`. The safety plugin
  refuses a call to it, because it is not on the session's exact list. A
  safety plugin test pins the refusal at each stop.
- **Plugin rows.** The transport's plugin check already accepted a row named
  by the folder.
- **Storage.** 9 new migrations. `session_v2` gains `time_busy` and
  `session_message` is unchanged, so the columns that `storage.ts` requires
  are still present. New tables: `blob` and `blob_ref` (attachment bytes),
  `session_part` (message parts), `schedule`, `job`; `session_pending` goes.
  Isomux deletes a session with `DELETE /api/session/:id`, and OpenCode then
  removes its rows from these tables too (foreign keys, `session.ts:395`,
  `session/projector.ts:648`).
- **Skill folders.** The same four folders as on 2.1.4
  (`member-skill-folder.ts`). Evidence: `skill-folders.json`.
- **`/goal`.** `POST /api/session/:id/prompt` sends the text to the model as
  it is (`packages/server/src/handlers/session.ts:290-303`). Commands run
  only through `session.command`, which Isomux does not call. Evidence:
  `goal-prompt.json`.
- **Project config files.** `config/discovery.ts` is the same as in 2.1.4, so
  the folder deny list of task `195fcb59` holds.

## Console policies

- A Console `tool.use` allow does not override a session deny. The policy
  hook acts only on a deny (`config/plugin/policy.ts:94-108`).
- A Console `plugin.use` deny of the Isomux plugin removes it without a
  failure row (`plugin/module.ts:53-54`, `plugin/supervisor.ts:67-72`). The
  transport's plugin check then refuses at its deadline, so the turn does not
  run.

## Residual risks

- The Console layer arrives a moment after the start: absent 2 s after it,
  present 4 s after it. A Console MCP server named like the office one that
  arrives during a turn below Standard is seen only at the next turn's check.
  It can be a remote server only, from the member's own organization.
- A Console policy that blocks the Isomux plugin and arrives after the plugin
  loaded takes effect at the next plugin reload. During that turn the hook is
  gone, the same class as the 2.1.4 reload window. It is the member's own
  organization's policy.
- The image tool saves with the extension of the image's real format, in the
  folder of `path`. The check sees that folder, not the final file name.

## Reproduction

Install a scratch 2.1.4 for the baseline:

```sh
mkdir -p "$GATE_ROOT/oc214" && cd "$GATE_ROOT/oc214"
echo '{"private":true}' > package.json && bun add --exact @opencode/cli@2.1.4
```

Run each probe with Bun from its own folder, with `GATE_ROOT`,
`GATE_V2_BIN` (the 2.2.5 binary in the Isomux `node_modules`) and
`GATE_V1_BIN` (the scratch 2.1.4) set. `reload.ts` takes `TOOL=read` or
`TOOL=shell`, and `sp-p6-census.ts` takes `v2`.
