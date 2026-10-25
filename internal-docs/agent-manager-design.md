# Reassigning an agent's manager

Status: implemented in task 6a9deaba (2026-10-20). Designed 2026-09-15; Nil's
rulings of 2026-09-15 and 2026-10-20 are at the end and win where the text
differs. References name files and symbols, not line numbers.

## What manager means

An agent has two persisted manager fields (`AgentInfo.userId`, `username` in
`shared/types.ts`). `userId` is the stable identity of the member who manages
the agent; `username` is a display snapshot. Both are set at spawn from the
authenticated identity, never the request body, and change together at a
transfer. They are saved in the live-agent file and in agent history
(`persistAll`, `updateAgentHistory` in `server/agent-manager.ts`).

The code reads the manager for these behaviors:

- **Process environment and sign-in.** Every backend create, resume, stored-
  session check and terminal launch selects the member's managed variables with
  `userId` (`buildSessionEnv` in `server/agent-manager.ts`; `server/terminal.ts`).
  Member variables override office variables. An active personal Claude or
  Codex connection also selects that member's `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` (`server/env-loader.ts`; `server/provider-homes.ts`).
- **Provider-account guidance.** Sign-in checks and sign-in-required cards read
  the manager's provider accounts. The provider card is shown only to the
  manager (`ui/log-view/LogView.tsx`).
- **Agent bearer identity and authority.** The token stores the manager
  `userId`; a privileged token gets the privileged capability set
  (`server/identity/tokens.ts`). Room guards resolve an agent's access through
  that `userId` (`server/identity/guard-deps.ts`). A privileged agent operates
  only on cronjobs owned by its manager, and an app has its creator agent's
  reach only while the agent's manager owns the app (`server/identity/guards.ts`;
  `appIdentityFromToken` in `server/app-tokens.ts`).
- **Who may change privilege.** The manager or an office owner, by cookie
  session (`agents.setPrivileged` in `server/routes/table.ts`).
- **Prompt and language.** A new backend session loads the manager's member
  memory, member prompt and language. Server log lines and choice cards are not
  in anyone's language: each stores English text plus the message keys, and
  each member's UI words the keys in that member's language
  (`shared/i18n/log-message.ts`). Agents read the English.
- **Killed agents and transcripts.** Kill copies both fields into history. The
  killed list and killed-log guard use the recorded `userId`: the recorded
  manager and office owners can read them.
- **Browser controls.** Actions use the current manager's paired Chrome
  connection and a tab that member offered. The bridge checks on every action
  that the agent's current manager is the paired member (`mayUseExtension` in
  `server/isomux-office.ts`; `ExtensionBrowserSessions.run` in
  `server/browser-extension-session.ts`), so a transfer needs no browser step:
  the old member's offer answers "ended" on the next action.
- **Remote API-token inboxes.** API tokens belong to members. An agent replies
  only through a token its manager owns, derived from the live agent. A transfer
  does not move or revoke API tokens.
- **App secrets.** An app reads the member-scope secrets of its owner only
  (`envFor` in `server/app-secrets.ts`).

## The transfer

`PUT /api/agents/:id/manager` with `{userId}` (`agents.setManager`). Only an
office owner by cookie session: `agent:privilege` plus `userScope`. No agent
and no API token, an owner's included, can call it: no agent reads a member's
secret values and a token reads only its own user's, so moving an agent onto a
member would give either of them another member's credentials. Errors: 422
`invalid_request` for a bad body, 422 `unknown_member`, 404 `agent_not_found`.
The same manager is a 200 no-op.

`transferAgentManager` (`server/isomux-office.ts`) calls
`agentManager.setManager`, then moves what the agent made. `setManager`, in
this order:

1. stamps every session of the agent that has no manager stamp with the old
   manager (`stampSessionManagers`: `userId` plus a name snapshot in
   `sessions.json`). An unstamped session was born under the current manager;
2. writes the new `userId` and the member's current name;
3. re-mints the token with the new `userId` and the same privilege flag;
4. resets the allowance reading, the limited Claude families, and marks the
   terminal's environment stale;
5. kills the running session with `newConversation`: the process closes, a
   pending choice is cancelled, the chat clears and shows one line naming the
   actor and the new manager, and the next message starts a fresh conversation
   under the new manager's environment, prompt, memory and token.

Steps 2 and 3 run before step 5 with no await between them, because
`newConversation` flushes the held queue during its drain and that flush starts
the fresh session with the identity set at that moment.

The privilege toggle's session swap is not used: it resumes the same session,
which for Claude keeps the old manager's pinned config directory.

Then the office moves, for each record the agent made that its old manager
still owns (`createdByAgentId === agent` and owner `=== old manager`):

- apps: `appRegistry.update(name, {owner})`, then `appSecrets.syncNow()`. The
  app loses the old manager's secrets, gets the new owner's, and a running app
  whose secrets file changed restarts;
- cronjobs: `setCronjobOwner`. A job records its creating agent since this
  task (`Cronjob.createdByAgentId`). For an older job the audit log's
  `cron.create` row by that agent, with the job id as target and a time within
  10 seconds of `createdAt`, stands in (the id alone is not enough: a deleted
  job's id can come back). Jobs older than the audit log stay with the old
  member. A run in flight keeps its environment;
- webhooks: `webhookRegistry.setOwner`. Ingress checks that the owner can reach
  the target agent, so a hook left behind would stop.

A record the agent made that a third member owns stays with that member. The
old manager's own schedules and webhooks that target the agent stay with the
old manager.

### Resume

A session born under an earlier manager may be resumed. After a successful
resume (`resume()` in `server/agent-manager.ts`) the chat shows "This session
still has X as manager and uses their connections." with X the member's
current name, or the snapshot when the member was deleted. A session of an
agent that had no manager gets no line.

The sentence is exact for Claude: a session is pinned to the config directory
that created it (`getSessionClaudeConfigDir`). Codex resumes under the new
manager's `CODEX_HOME`: with a personal Codex connection the rollout is not
there and the resume fails its preflight, so no line shows. OpenCode looks for
the session in the profile of the new manager's environment, and does not find
it either.

### Room access

There is no room-access check (ruling 1). A manager without access to the
agent's room leaves the agent without room reach (discovery, board, messaging,
logs), and the manager does not see it. The edit dialog shows a hint when the
chosen member has no grant for the agent's room.

### What does not move

API tokens, member memory, provider state and managed variables stay with the
old member. The old member loses manager-only browser control, killed-history
ownership for a later kill, the agent's inherited room reach, privilege
control and API inbox reply reach. Room-visible conversation logs remain
governed by room access; a transfer is not transcript redaction.

## Member deletion

`users.delete` (a member deleting their own record, or an owner) passes the
member's agents to the oldest office owner other than the member, by
`createdAt` (`heirOwnerFor`). It runs after the last-owner 409 check, so a
refused delete moves nothing, and before the record and secrets go, so the
session stamps find the member's name. Live agents go through
`transferAgentManager` with the caller as actor. Killed agents get the owner in
their history entry and their sessions are stamped
(`agentManager.reassignKilledAgents`), so a revived agent warns on resume. The
member's own apps and schedules that no agent made are not part of this.

## Nil's rulings

2026-09-15:

1. Only office owners can change an agent's manager. There is no consent step,
   no room-access precondition and no confirmation.
2. A session started under a previous manager may still be resumed. On resume,
   the chat shows a warning: "This session still has X as manager and uses their
   connections."
3. Member deletion is not blocked while the member manages agents; that was
   rejected as annoying. The agents they manage pass to an office owner
   automatically instead.

2026-10-20:

4. Apps and schedules the agent created move with the agent: their owner
   changes to the new manager.
5. A deleted member's agents pass to the oldest office owner.
6. A transfer kills the agent's running session, for an owner change and a
   member deletion alike.
7. Privilege carries over on transfer.

Implication of rulings 4 and 5, applied in task 6a9deaba: the webhooks the
agent created move too, by the same rule. A webhook left with a deleted member
stops at ingress, so the agent's own wake (a GitHub hook, for example) would
fail without a message.

Task 438900d2: a deleted member's own schedules and webhooks pass to the
oldest office owner too. Every webhook the member owned, also one that moved
with an agent, passes turned off with a new secret, because the member could
read its secret. The heir gives the sender the new secret and turns it on.

Task be7708d3 (Nil, 2026-10-25): the member's schedules, also those that move
with an agent, pass turned off too: a passed schedule would otherwise run on
its own with the heir's environment and secrets, on a prompt the member wrote.
The heir reads each schedule and turns it back on. The schedules and webhooks
turn off before the agent transfers, because the delete awaits the next
agent's drain after a transfer moves its agent's records to the heir.
