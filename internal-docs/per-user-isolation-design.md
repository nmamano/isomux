# Per-user isolation in a shared office

> Status: partially shipped. The first slice — explicit Manager field on agents — is live in main (commit `cb9fa3c`). The privacy story (personal folder primitive + forbiddenRoots ACL + bwrap) is scoped but not yet implemented. See the Roadmap section for task IDs.

This document covers the design for closing the cross-member credential-leak gap within a single isomux office: who controls an agent, which files cross-user agents can surface, and how those rules get enforced across the SDK and HTTP surfaces. For the broader isolation story (hub model, escalation matrix from same-user to microVMs), see `internal-docs/isolation-design.md`.

## Terminology

- **Office owner**: the user holding the office-owner role from the auth system. Has admin authority over the whole office. Typically a single human per office.
- **Manager** (of an agent): the user who controls a specific agent. Set at spawn time and **immutable** for the agent's lifetime. Drives the agent's envFile loading and its system-prompt user section. Stored as `userId` on `AgentInfo` / `PersistedAgent`.
- **Member**: a user with the member role from the auth system. Can manage their own agents but cannot administer the office.
- **Personal folder**: a per-user top-level directory under `~/` (the host running-user's home) that the user designates as their workspace. Used by the privacy ACL — cross-user agents are denied access to it. Opt-in; users without one have no carve-out (solo-dev default).

"Owner" without "office" is **not** used. Use "manager" for the per-agent role.

## Goals

1. A member's agent cannot read another member's credentials, OAuth tokens, project files, or chat history.
2. A member cannot read the office owner's personal credentials (`~/.ssh`, billing, personal OAuth, private repos) when those live inside the owner's personal folder.
3. A member cannot exploit another member's agent as a confused deputy to surface another user's files via the agent's chat output.
4. A member cannot bypass the boundary via the HTTP file-affordance endpoints (`read-file`, `diff`, `edit-file`).
5. Manager attribution is unambiguous (set at spawn, can't be tampered with).

## Non-goals

- **Protection against a malicious office owner.** The office owner has full server access by design.
- **Protection against server-process compromise.** A bug that exposes server memory exposes everything.
- **Network egress filtering.** Out of scope for this design; covered in `isolation-design.md` as a Level 2+ optional extension.
- **Cross-office isolation.** That's the hub design; per-user isolation lives within one office.
- **Inter-member workspace isolation for non-personal-folder content.** The host running-user's home outside any personal folder is the shared workspace — collaborative by design.

## Threat model summary

**Closed by this design**:
- Goals 1, 2, 3: by the per-agent forbiddenRoots ACL at the application layer (Claude SDK PreToolUse + HTTP endpoints). Goals 1 and 2 fully closed only after bwrap (Phase B) lands, since autonomous bash-tool walks of the FS bypass the application layer.
- Goal 4: by adding path-deny checks to the HTTP file-affordance endpoints (today they have none).
- Goal 5: by making the manager field immutable post-spawn (live as of commit `cb9fa3c`).

**Accepted residual risk**:
- **"Trust users" model**: a member's agent could still walk the filesystem via its bash tool and read past the application-layer deny-list. Closed by bwrap (Phase B) on Linux. On macOS this gap is permanent unless a `sandbox-exec` backend is built.
- **Codex SDK gap**: Codex doesn't expose a PreToolUse hook (`hooks: false` in the adapter). Codex tool calls aren't intercepted at the application layer; closed only by bwrap.
- **Cross-user collab inside a personal folder**: anything in user X's personal folder is unreachable to other users' agents. If users want to collaborate on something inside one of their folders, they need to move it out first.

## The model

### Per-agent fields

Every agent has:

- `userId: string | null` — the manager. Set at spawn from the spawning user; immutable. Drives `buildEnvForUserId` (envFile selection at spawn/resume/cronjob-fire) and appears in the agent's system prompt user section.
- `username: string | null` — display snapshot of the manager's name at spawn time. Goes stale on rename; not authoritative for any behavior. Kept for UI/audit purposes.

Both null on legacy unowned agents that pre-date the user/device split.

The manager-as-immutable-spawn-stamp framing replaces an earlier design that exposed manager reassignment via `edit_agent`. Reassignment was dropped because (a) the field's powers in main today are env-source-selection and display only; (b) handoff use cases are rare and serviceable by killing the agent and respawning under the new manager.

### Per-user `privateFolder` field

Every user record has an optional `privateFolder: string | null` field, set in user settings alongside `envFile`. The field's purpose is to mark a directory as a privacy carve-out: cross-user agents (managed by anyone except this user) are denied access to anything under this folder.

**Constraint: top-level only.** The folder must be a direct child of the host running-user's home (`~/`). No nesting, no symlink-escape. Validation rules:

1. **Lexical**: accept `~/seg` or `/home/<host>/seg` form (trailing slash normalized). `seg` is a single non-empty path component — no `/`, no `.`, no `..`.
2. **Resolved**: `realpath` both the candidate and `os.homedir()`. Require `dirname(realCandidate) === realHomedir`. This catches symlink-escapes where `~/escape` is a symlink to `/mnt/external/foo`.
3. **Existence**: the resolved path must exist and be a directory. Save refuses otherwise; no auto-create (raises ownership/permission/UI questions out of scope).
4. **Overlap**: no other user's stored `privateFolder` equals this canonical path. Top-level + canonicalization makes exact-equality sufficient.
5. **Storage**: store the canonical absolute path, not the user-typed form. UI renders `/home/<host>/` → `~/` for display.

**Opt-in.** A user without a `privateFolder` set has no carve-out — their stuff in the shared host home is readable by all agents. Solo-dev default; multi-user offices configure per-user.

UI naming: data field is `privateFolder` (describes the future policy role). UI label is "Personal folder" (friendly).

### Per-agent forbidden-roots ACL

A single per-agent abstraction:

```ts
forbiddenRootsForAgent(agent: AgentInfo): string[]
```

Returns every OTHER user's canonical `privateFolder`. Computed from `listUsers()` filtered to exclude the agent's manager (`agent.userId`). One source of truth, two consumers (described below).

This is intentionally narrow: it covers cross-user privateFolder protection only. Existing global rules (the `~/.isomux/` write-block in safety-hooks, the sensitive-basename read-block for `.env`/`.pem`/`credentials.json`/etc.) stay as global static rules — they're not per-agent and don't need this abstraction.

### Enforcement layers

| Surface | Current state | Target state |
|---|---|---|
| Claude SDK tool calls (Read, Bash, Edit, Write) | `server/safety-hooks.ts` PreToolUse intercepts; static rules only. | Refactor to per-agent hook closure that consults `forbiddenRootsForAgent`. Existing global rules stay separate. |
| Codex SDK tool calls | **No interception** — Codex adapter has `hooks: false`. No upstream hook mechanism. | **Application-layer gap stays open.** Phase B (bwrap) closes it at the kernel boundary. |
| HTTP file-affordance endpoints (`read-file`, `diff`, `edit-file`) | **No path check at all.** Server reads/diffs anything the agent's POST body asks for. | Each endpoint canonicalizes the requested path via realpath, denies if under any `forbiddenRootsForAgent` root, returns 403. |
| HTTP `/terminal-command` endpoint | No path check (and none needed). | **Skip.** The command card is local-terminal-only — server doesn't execute, doesn't read the FS. |
| Linux kernel (mounts/namespaces) | No isolation. | Phase B: bwrap mount profile excludes other users' `privateFolder`s from the agent's mount layout. Closes Codex + autonomous-agent gaps. |
| macOS kernel | No isolation. | Out of scope unless someone builds a `sandbox-exec` / SBPL backend. Documented residual gap. |

The "convergence" point: the same `forbiddenRootsForAgent(agent)` function is the single source of truth for the per-agent deny-list. The Claude hook and the HTTP endpoints both consult it. Codex stays gapped at the application layer (no hook exists); Phase B bwrap brings it under the same deny-list via mounts.

### What's deliberately NOT in the model

- **No `visibility` flag (private/shared).** An earlier design had a per-agent visibility toggle controlling chime-in semantics. The room ACL is the right axis for social privacy (who can chat with the agent); the personal folder is the right axis for data privacy. Two orthogonal concerns; the visibility flag conflated them.
- **No `sharedEnvFile`.** An earlier design had per-user dual envFiles to give shared agents scoped credentials. The new model: put your envFile inside your personal folder. Other users' agents can't read it. One envFile per user; one mechanism.
- **No system-managed `~/.isomux-data/private/<userId>/`.** An earlier design lazily created per-user private dirs at a known prefix. The new model: user picks any folder under `~/`. More flexible, matches user mental models ("my work goes in `~/work`"), no magic paths.
- **No `manager` reassignment.** An earlier design exposed `edit_agent.manager`. The new model: spawn the agent under the right user from the start; kill+respawn if the wrong user owns it.
- **No per-room shared folder primitive.** Considered as a complementary axis (room-level shared workspace); decided against — adds a second carve-out dimension without clear demand.

## Roadmap

Pickup pointer on the task board: **`bab9f929`** ("Per-user isolation: pick up implementation"). This doc is the source of truth for the work items below — the task is just the entry point.

The slices land in this order:

1. **Manager field surfaced (DONE)** — commit `cb9fa3c`. Read-only Manager badge in EditAgentDialog (spawn + edit), styled like the Engine badge. Comments on `AgentInfo` and `PersistedAgent` document the field as set-at-spawn and immutable.

2. **Add `privateFolder` field to UserRecord (storage only, no enforcement).** Schema + UI + save-time validation per the rules in "Per-user `privateFolder` field" above. Lays the contract; behavior unchanged.

3. **`forbiddenRootsForAgent` abstraction + HTTP enforcement + per-agent Claude PreToolUse refactor.** First enforcement step. Introduces the per-agent deny-list and wires it into the Claude SDK hook surface and the HTTP file-affordance endpoints (read-file / diff / edit-file; skip terminal-command). Codex SDK stays gapped at the application layer (no PreToolUse equivalent). Existing global rules in `safety-hooks.ts` (~/.isomux/ writes, sensitive basenames) stay separate from the per-agent layer.

4. **envFile-inside-personal-folder warning.** Non-blocking UI nudge in UserSettingsView if the user has set both fields and the envFile isn't inside the privateFolder. Meaningful only after enforcement (slice 3) lands.

5. **Bwrap mount profile (Phase B / Linux).** Kernel-level enforcement of the same deny-list via mount namespaces. Closes the Codex SDK and autonomous-agent gaps that the application layer can't. Linux only; macOS would need a parallel `sandbox-exec` / SBPL backend (residual macOS gap).

6. **Inject manager's privateFolder into agent system prompt.** Tells agents which directory is implicitly theirs. Works across backends. Meaningful after enforcement (slice 3).

7. **Audit log of cross-folder file-affordance attempts.** Append-only record (timestamp, actor agent, manager userId, requested path, target userId, action, decision) of every cross-folder touch. Investigation surface.

8. **Cronjob inheritance of privateFolder policy.** Cronjob-spawned agents inherit their manager's userId for env — confirm they inherit the same ACL surface too.

9. **User-deletion behavior for privateFolder.** Decide whether a deleted user's privateFolder stays in the deny-list (data preservation, slight state cost) or drops out (simpler). Defer until enforcement lands and the question is concrete.

## Platform support

| Layer | Linux | macOS |
|---|---|---|
| Manager field (immutable) | ✓ | ✓ |
| Personal folder field + validation | ✓ | ✓ |
| forbiddenRootsForAgent (application layer) | ✓ | ✓ |
| Claude PreToolUse per-agent hook | ✓ | ✓ |
| HTTP file-affordance enforcement | ✓ | ✓ |
| Codex SDK enforcement | ✗ (no PreToolUse) | ✗ (no PreToolUse) |
| Kernel-level enforcement (mounts) | ✓ (bwrap, Phase B) | ✗ (would need sandbox-exec backend) |

What this means in practice:

- **Linux multi-user installs**: full design works after Phase B. The Codex SDK gap is closed by bwrap.
- **macOS multi-user installs**: application-layer pieces close the intentional cross-user vectors. The autonomous-agent vector (an agent walking the FS via bash) and the Codex tool-call vector stay open. Document and rely on "trust users" — agents don't go hostile on their own under normal operation.
- **Single-user installs (any OS)**: unaffected; no other users to isolate from.

## References

- `internal-docs/isolation-design.md`: broader isolation story (hub model, escalation matrix from same-user to microVMs).
- `internal-docs/auth-system-redesign.md`: office owner / member roles, invite flow.
- `shared/types.ts`: `AgentInfo.userId` + `UserRecord` schemas.
- `server/agent-manager.ts`: agent spawn path; userId is set from the spawning session.
- `server/safety-hooks.ts`: current static rules (`~/.isomux/` writes, sensitive basenames). The convergence task refactors this surface.
- `server/index.ts`: HTTP file-affordance endpoints (`read-file`, `diff`, `edit-file`, `terminal-command`).
- `server/backends/codex/adapter.ts`: `hooks: false` — the Codex gap.
- `ui/components/UserSettingsView.tsx`: where the personal folder input will live.
- `ui/components/EditAgentDialog.tsx`: where the Manager badge already lives (post `cb9fa3c`).
