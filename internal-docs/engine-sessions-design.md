# Engine sessions: the office's own link to an agent's conversation

Task 3a2de351, Nil's choice of 2026-11-21 ("Keep our own link to each agent's conversation").

An agent resumes from its engine's own files (for Claude Code, the project transcript). An engine deletes those by its own rules: Claude Code 2.1.322 deletes a transcript, its `<id>.ccr-tip.json` and `<id>.precompact.json`, and its `<id>/` folder once they are past `cleanupPeriodDays` (default 30). The sweep runs in the background about 5 s after a process starts, at most once per 24 h per config folder, skips no session (also the one the process resumes), and is skipped only when `--setting-sources` leaves out user settings. A person's own `claude` on the same folder sweeps too. Isomux keeps the engine's cleanup on: it stays the garbage collector for files no agent holds.

## The store

`<agent root>/engine-sessions/<agentId>/<sessionId>/` holds a second name of each file of the agent's current session, in the layout the files have under the engine's root (`server/engine-session-store.ts`). A hard link, so it costs no space and shows every append; a copy across file systems (recopied when size or mtime changes). The agent root is the host's: `AGENT_ROOT` on an office host, `<member home>/.isomux-agent` for an isolated member, whose runner makes the links as the member (`fs.protected_hardlinks` stops the office user from linking a member's file).

- `Backend.sessionFiles(id, {cwd, env})` names the files by id, with no IO: Claude gives the transcript, the two side files and `<id>/` (walked, never following a link). Codex and OpenCode have none yet: their agents are not linked.
- **Keep**, at each `turn_completed` of the agent's installed session (`keepEngineSession` in `server/agent-manager.ts`), with the env the session launched with. A store file always follows the engine's current file, also when the engine replaces it with a smaller one: Claude Code rewrites a transcript of 5 MB or more through a temp file and a rename after a compaction, and the result is smaller. A sweep under a live process would leave a fragment (Claude Code recreates the file with only the new lines, probe of 2026-11-21), which the store would then follow; the touch before each resume prevents that sweep, and Isomux releases an idle session long before `cleanupPeriodDays`.
- **Retention**: keep removes the agent's other session folders, so the store holds one session per agent. A killed agent keeps its folder (a revive resumes it). A prune of a transcript removes that session's folder on the office host.
- **Before each resume**, before the engine process starts (`prepareResume`): each store file the engine lacks is linked back, and every file of the session is touched, so the new process's sweep does not take it. The Claude backend runs it in process on a local host; a runner host (split office, isolated member) runs it in its spawn handler (`SpawnChildOptions.prepare`). A schedule run has no store: only the touch runs. It never writes over an engine file and never throws.
- **A cwd change** puts the files back in the old folder before it moves them.

## When nothing helps

Isomux runs no missing-file preflight for Claude. When the engine answers that it has no conversation for the current session ("No conversation found"), the office drops the id, starts a new conversation and says so in the chat (`recoverGoneSession`), for office and member agents alike. A cwd change on a session gone at both ends applies the folder and starts fresh.

## Backup, move, export

The backup leaves `engine-sessions/` out (it would store each linked file twice where the engine home is in the state root), so a conversation only the store kept is not in a copy. The office move carries it; on the new box the links arrive as copies, and the first keep after the engine file changes links the store to it again. The office export copies an allowlist, which does not name it.

## Left out

Conversations lost before this change. A conversation that is not an agent's current one is not linked (a `/resume` to it makes it current, and the next turn end links it), and neither are schedule-run forks. Codex and OpenCode (no `sessionFiles` yet).
