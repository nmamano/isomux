# Reassigning an agent's manager

Status: design, 2026-09-15, with Nil's rulings at the end. Nothing here is
implemented.

## What manager means today

An agent has two persisted manager fields. `userId` is the stable identity of
the member who spawned it. `username` is a display snapshot and can become
stale. Both are set at spawn and are documented as immutable
(`shared/types.ts:540-550`). The REST spawn path derives both values from the
authenticated identity, not the request body (`server/isomux-office.ts:3272-3275,
3303-3329`); `OfficeState.spawn` writes them into `AgentInfo`
(`shared/office-state.ts:287-316`). They are saved in the live-agent file and in
agent history (`server/agent-manager.ts:1751-1769,1800-1828`).

The code reads the manager for these behaviors:

- **Process environment and sign-in.** Every backend create, resume, stored-
  session check, and terminal launch selects the
  member's managed variables with `userId` (`server/agent-manager.ts:4837-4853,
  4937-4954,5024-5142`; `server/terminal.ts:113-135`). Member variables override
  office variables. An active personal Claude or Codex connection also selects
  that member's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
  (`server/env-loader.ts:77-111`; `server/provider-homes.ts:35-63`). Therefore
  variables used by git or `gh` also change if they are present in the managed
  environment; the terminal forces the host `HOME`, `USER`, `PATH`, `SHELL`, and
  `LANG` after the merge (`server/terminal.ts:128-137`).
- **Provider-account guidance.** Sign-in checks and sign-in-required cards read
  the manager's active provider accounts and personal/office scope
  (`server/agent-manager.ts:560-592,613-720`). The provider card is shown only to
  the manager (`ui/log-view/LogView.tsx:2617-2620`).
- **Agent bearer identity and authority.** The token stores the manager
  `userId`. A privileged token receives the privileged capability set
  (`server/identity/tokens.ts:82-104,149-174`). Room guards resolve an agent's
  access through that `userId` (`server/identity/guard-deps.ts:55-63`). A
  privileged agent can operate only on cronjobs owned by the same member
  (`server/identity/guards.ts:402-438`), while agent-owned app access and
  office-owner inheritance also compare the token's member identity
  (`server/identity/guards.ts:349-399`).
- **Who may change privilege.** The current manager or an office owner may grant
  or revoke agent privilege. The route excludes every non-user identity with an
  outer `userScope`, and the edit dialog mirrors the same manager comparison
  (`server/routes/table.ts:375-396`; `server/identity/guards.ts:309-328`;
  `ui/components/EditAgentDialog.tsx:275-282`). A manager transfer changes who
  holds this power.
- **Prompt and language.** A new backend session loads the manager's member
  memory by `userId`, but looks up the member prompt and language by the
  `username` snapshot (`server/agent-manager.ts:4979-5007,5090-5113`). The prompt
  preview has the same split (`server/agent-system-prompt.ts:23-74`). Server log
  text without a known human actor uses the manager's language by `userId`
  (`server/agent-manager.ts:2887-2918`). A reassignment must update `userId` and
  `username` together to avoid a mixed identity.
- **Killed agents and transcripts.** Kill copies both fields into history
  (`server/agent-manager.ts:7557-7595`). The killed list and killed-log guard use
  the recorded `userId`: the recorded manager and office owners can read them
  (`server/agent-manager.ts:1899-1927`; `server/identity/guards.ts:609-638`;
  `server/isomux-office.ts:5831-5887`).
- **Browser profile and controls.** Agent browser actions select the persistent
  profile by manager `userId` (`server/agent-manager.ts:2648-2673`), and only a
  matching signed-in member can drive the panel (`server/isomux-office.ts:909-911`;
  `ui/log-view/LogView.tsx:787-799`). A live browser context keeps the profile id
  supplied when that context was created (`server/browser-session.ts:1054-1115`),
  and manager viewers keep it alive (`server/browser-session.ts:941-971`).
- **Remote API-token inboxes.** API tokens belong to members independently of
  agents. An agent can reply only through a token owned by its manager; both the
  precondition and handler derive that manager from the live agent
  (`server/isomux-office.ts:3776-3783,4010-4016`;
  `server/routes/handlers/api-tokens.ts:103-126`). Reassignment does not transfer
  or revoke a member's API tokens.
- **Manager-directed UI events.** A newly opened agent browser is announced
  only to the current manager (`server/isomux-office.ts:4737-4743`). Turn-end
  sound notifications are not manager-owned: each viewer receives visible
  agent state and applies their own room notification preference
  (`ui/store.tsx:110-113,1363-1384`).

Two related resources take a snapshot at creation and do not follow the agent.
A cronjob created by an agent stores the token's current `userId`, and later
uses that value for environment and authorization
(`server/routes/handlers/cron.ts:145-169`; `server/cronjob-manager.ts:836-902,
1122-1141`). An app registered by an agent also stores the current `userId`
(`server/routes/handlers/apps.ts:329-342`). Existing cronjobs and apps must stay
with their original member unless a separate transfer feature is approved. The
transferred agent then loses control of apps it registered and privileged
cronjobs it created: both guards compare the resource owner with the agent
token's now-new `userId` (`server/identity/guards.ts:395-397,435-437`). App logs,
app restart/update/delete, and cronjob management consequently deny it.

## Required live transition

Changing only the persisted fields is unsafe. The current backend process has
the old environment and system prompt, and its injected bearer token has the old
identity. The reassignment must be one server transaction that:

1. rejects a missing target member and writes the target's stable `userId` plus
   current display name;
2. closes any active browser context before changing the fields, so it saves to
   the old member's profile and the next action opens the new member's profile;
3. re-mints the agent token with the new `userId` and its unchanged privilege
   flag; and
4. replaces a live backend session with the target member's environment and a
   fresh conversation, unless Nil explicitly chooses one of the provider-
   specific continuity trade-offs below. A dormant agent needs no process
   replacement, but its next wake must use the same fresh-session rule.

This necessarily interrupts an in-flight turn. The existing privilege toggle
is the closest safe precedent: it persists, rotates the token, and session-swaps
the live process because the old process otherwise holds a revoked token
(`server/agent-manager.ts:4501-4528`). The replacement rebuilds the environment,
prompt, member memory, member prompt, language, skills, and token. The UI must
state that transfer stops current work and starts a new conversation; the old
transcript stays readable under the agent. A pending permission or interaction
must not silently become the new manager's decision; implementation must either
reject transfer while one is pending or cancel it visibly.

Conversation continuity and a clean credential transfer cannot both be promised:

- Claude pins each session to the config directory that created it. The pin
  overrides the current manager environment, explicitly so account changes do
  not recover a pinned session (`server/agent-manager.ts:4842-4852`;
  `server/persistence.ts:371-376`; `server/claude-session-root.ts:13-35`). Resume
  preserves context by continuing to use the old manager's provider home.
- OpenCode stores a session inside the profile derived from the environment
  source key (`server/backends/opencode/storage.ts:48-59`;
  `server/backends/opencode/profile-paths.ts:15-33`). That key hashes the member
  env-file path (`server/env-loader.ts:135-148`). A different target profile
  cannot find the old session; using the old profile also keeps the old
  environment boundary.
- Codex finds resumable rollouts under the effective `CODEX_HOME`
  (`server/cwd-utils.ts:145-164,185-217`). Resume uses the target environment
  (`server/backends/codex/adapter.ts:2656-2667`), so it fails its preflight when
  the target's `CODEX_HOME` does not contain that rollout
  (`server/backends/codex/adapter.ts:2670-2684`). Continuity is possible only
  when both managers resolve to a home containing the same rollout; retaining
  the old personal home retains the old account boundary.

Therefore the safe default is a fresh conversation under the target manager.
Resume under an old provider home must be a separate, explicit policy choice,
not an automatic part of manager transfer.

The target member must already have access to the agent's current room. Every
agent, not only a privileged one, derives room reach from its manager's live
grants (`server/isomux-office.ts:1563-1570,1687-1698`). Without this rule, the
agent loses its room-scoped agent discovery, task-board, messaging, and log
reach, and the target manager cannot see the agent. Recommend refusing the
transfer instead of silently granting a room.

After reassignment, the old manager loses manager-only browser control, killed-
history ownership for a later kill, the agent's inherited room reach, privilege
control, and API inbox reply reach. The new manager supplies those powers and
limits. Existing apps and cronjobs do not move. Room-visible conversation logs
remain governed by room access while the agent is live; reassignment is not
transcript redaction.

Member deletion needs a new invariant. Today deletion leaves agent and cronjob
`userId` references in place (`server/users.ts:405-408`) and evicts the member's
login sessions and their sockets (`server/isomux-office.ts:2957-2989`;
`server/auth.ts:1208-1231`). It does not close the agent's browser context.
Room lookup then finds no user record and denies the stale id
(`server/isomux-office.ts:1553-1555,1563-1569`).
The environment resolver itself checks files and provider activation by id, not
user existence (`server/env-loader.ts:58-111`), so dangling credentials can
remain selectable if their state remains on disk. Recommendation: block member
deletion while they manage live or killed agents, and require transfer or
permanent deletion first. Apply an equivalent explicit rule to their cronjobs,
apps, API tokens, provider state, managed variables, memory, and browser profile;
their cleanup/retention policy is outside this task.

## Nil's rulings (2026-09-15)

Not scheduled for implementation (task 6a9deaba, P2). These rulings override
anything above that conflicts with them, including the fresh-conversation
default, the room-access refusal and the consent flow first proposed.

1. Only office owners can change an agent's manager. There is no consent step,
   no room-access precondition and no confirmation.
2. A session started under a previous manager may still be resumed. On resume,
   the chat shows a warning: "This session still has X as manager and uses their
   connections."

Still open for implementation: member deletion while the member manages agents
(see above), and whether privilege carries over on transfer.
