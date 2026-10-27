// The checks of the conformance run (run.ts): each reads what the scratch
// office recorded after one step - its tasks, asks, agent logs, the agents'
// office-call record and the git log of the agent's repo - and never what
// the model said.
import { basename, dirname, resolve } from "node:path";
import type { AgentReferenceUsageEvent } from "../../server/agent-reference-telemetry.ts";
import type { AskMemberWire, LogEntry, TaskItem } from "../../shared/types.ts";
import type { Engine } from "../install-smoke/check.ts";

// The task an office call made: its title is "<marker> <code>", and the
// office stamped the creating agent. Null when there is none.
export function findMarkerTask(
  tasks: TaskItem[],
  marker: string,
  code: string,
  agentId: string,
): TaskItem | null {
  const title = `${marker} ${code}`;
  return (
    tasks.find(
      (task) =>
        task.title.trim() === title && task.createdByAgentId === agentId,
    ) ?? null
  );
}

// The lines of the office's office-call record (ISOMUX_HOME/
// agent-reference-usage.jsonl). A line that does not parse is left out.
export function parseUsageLog(text: string): AgentReferenceUsageEvent[] {
  const events: AgentReferenceUsageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AgentReferenceUsageEvent;
      if (event && typeof event === "object") events.push(event);
    } catch {
      // A line cut by a crash or a concurrent append.
    }
  }
  return events;
}

// The agent's calls at or after `since`: feature calls with that opId, or
// reference page fetches of that topic.
export function usageCallsSince(
  events: AgentReferenceUsageEvent[],
  agentId: string,
  match: { opId: string } | { topic: string },
  since: number,
): AgentReferenceUsageEvent[] {
  return events.filter((event) => {
    if (event.agentId !== agentId || event.at < since) return false;
    if ("topic" in match)
      return event.kind === "reference_fetch" && event.topic === match.topic;
    return event.kind === "feature_call" && event.opId === match.opId;
  });
}

// The message the office delivered from another agent (metadata
// sender_agent_id) that carries the nonce, in the receiving agent's log, at
// or after `since`. Used for both legs of the messaging step.
export function replyFrom(
  entries: LogEntry[],
  senderAgentId: string,
  nonce: string,
  since: number,
): LogEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.kind === "user_message" &&
        entry.timestamp >= since &&
        entry.metadata?.sender_agent_id === senderAgentId &&
        entry.content.includes(nonce),
    ) ?? null
  );
}

export interface CommitLine {
  subject: string;
  authorName: string;
  authorEmail: string;
}

// Why the agent's last commit fails the git step, or null: its message must
// carry the nonce and its author must be the identity git resolves for the
// OS user in that repo.
export function judgeCommit(
  commit: CommitLine | null,
  identity: { name: string; email: string },
  nonce: string,
): string | null {
  if (!commit) return "the repo has no commit";
  if (!commit.subject.includes(nonce))
    return `the last commit "${commit.subject}" does not carry the nonce ${nonce}`;
  if (
    commit.authorName !== identity.name ||
    commit.authorEmail !== identity.email
  )
    return `the commit author is ${commit.authorName} <${commit.authorEmail}>, not the OS user's ${identity.name} <${identity.email}>`;
  return null;
}

// An ask the agent opened at or after `since` and that is still open.
export function newOpenAsk(
  asks: AskMemberWire[],
  agentId: string,
  since: number,
): AskMemberWire | null {
  return (
    asks.find((ask) => ask.agentId === agentId && ask.createdAt >= since) ??
    null
  );
}

// The tool call with which the engine loaded `skill` on its own, at or after
// `since`: Claude's Skill tool, OpenCode's skill tool, or for Codex a shell
// command that reads <root>/<skill>/SKILL.md for one of `fileRoots` (the
// skill roots the office gives the engine; a relative path resolves against
// the call's cwd). A read of the same skill anywhere else does not count.
export function skillLoaded(
  entries: LogEntry[],
  engine: Engine,
  skill: string,
  fileRoots: string[],
  since: number,
): LogEntry | null {
  const roots = fileRoots.map((root) => resolve(root));
  // A call counts only with its own result, and only when the tool did not
  // refuse it (Claude's "Unknown skill", OpenCode's "Unable to load skill"):
  // a call cut off before its result proves nothing.
  const loaded = new Set(
    entries
      .filter(
        (e) =>
          e.kind === "tool_result" &&
          typeof e.metadata?.toolUseId === "string" &&
          e.metadata.isError !== true,
      )
      .map((e) => e.metadata?.toolUseId as string),
  );
  return (
    entries.find((entry) => {
      if (entry.kind !== "tool_call" || entry.timestamp < since) return false;
      const toolId = entry.metadata?.toolId;
      if (typeof toolId !== "string" || !loaded.has(toolId)) return false;
      const input = (entry.metadata?.input ?? {}) as Record<string, unknown>;
      if (engine === "claude")
        return entry.content === "Skill" && input.skill === skill;
      if (engine === "opencode")
        return entry.content === "skill" && input.id === skill;
      if (typeof input.command !== "string") return false;
      const cwd = typeof input.cwd === "string" ? input.cwd : "/";
      return skillFileReads(input.command).some((path) => {
        const file = resolve(cwd, path);
        return (
          basename(dirname(file)) === skill &&
          roots.includes(dirname(dirname(file)))
        );
      });
    }) ?? null
  );
}

// The member's `/<command>` as the office resolved it to a skill: the
// user_message entry whose metadata holds the expanded text (sdkText).
export function slashResolved(
  entries: LogEntry[],
  command: string,
  since: number,
): LogEntry | null {
  const typed = `/${command}`;
  return (
    entries.find((entry) => {
      if (entry.kind !== "user_message" || entry.timestamp < since)
        return false;
      const text = entry.content.trim();
      if (text !== typed && !text.startsWith(`${typed} `)) return false;
      const expanded = entry.metadata?.sdkText;
      return typeof expanded === "string" && expanded.trim() !== "";
    }) ?? null
  );
}

// The paths of the SKILL.md files a shell command names, as written.
function skillFileReads(command: string): string[] {
  return [...command.matchAll(/[^\s'"`;|&()<>]*SKILL\.md/g)].map((m) => m[0]);
}

// The office's error body, {"error":{"code":...}}.
const OFFICE_ERROR = /"error"\s*:\s*\{\s*"code"\s*:/;

// The member's line that failed in a step: the tool results at or after
// `since` whose call (by toolUseId) ran a command that holds the step's
// marker, and that failed - the office's error shape {"error":{"code":...}}
// or a tool error. Steps 1-4 are red on one, even when the agent then found
// another way.
export function failedOfficeCalls(
  entries: LogEntry[],
  marker: string,
  since: number,
): LogEntry[] {
  const lineCalls = new Set(
    entries
      .filter((e) => {
        const command = (e.metadata?.input as { command?: unknown } | undefined)
          ?.command;
        return (
          e.kind === "tool_call" &&
          typeof e.metadata?.toolId === "string" &&
          typeof command === "string" &&
          command.includes(marker)
        );
      })
      .map((e) => e.metadata?.toolId as string),
  );
  return entries.filter((e) => {
    if (e.kind !== "tool_result" || e.timestamp < since) return false;
    const id = e.metadata?.toolUseId;
    if (typeof id !== "string" || !lineCalls.has(id)) return false;
    return e.metadata?.isError === true || OFFICE_ERROR.test(e.content);
  });
}

// Why the messaging step is red, or null when both legs were delivered. The
// leading clause names the missing leg; the suffix says what the sender's
// log shows: its send accepted (agent_outbound) but not in the receiver's
// log, its send refused by the office, other messages it sent, or no send.
export function messagingFailure(
  subjectEntries: LogEntry[],
  peerEntries: LogEntry[],
  subjectId: string,
  peerId: string,
  nonce: string,
  since: number,
): string | null {
  // One line of the report: whitespace folded, cut at 120 characters.
  const quote = (text: string) =>
    `"${text.replace(/\s+/g, " ").trim().slice(0, 120)}"`;
  const sent = (entries: LogEntry[]) =>
    entries.filter((e) => e.kind === "agent_outbound" && e.timestamp >= since);
  // What the sender's log shows about its send to the receiver, or null.
  const sendStory = (
    senderEntries: LogEntry[],
    receiverId: string,
    sender: string,
    receiver: string,
  ): string | null => {
    const accepted = sent(senderEntries).find(
      (e) =>
        e.metadata?.recipient_agent_id === receiverId &&
        e.content.includes(nonce),
    );
    if (accepted)
      return `; ${sender} sent it (message ${String(accepted.metadata?.message_id)}) and ${receiver}'s log has no such message`;
    const refused = failedOfficeCalls(senderEntries, receiverId, since)[0];
    if (refused) return `; ${sender}'s send failed: ${quote(refused.content)}`;
    return null;
  };

  if (!replyFrom(peerEntries, subjectId, nonce, since)) {
    const reason = `the peer got no message with ${nonce} from the agent`;
    return (
      reason +
      (sendStory(subjectEntries, peerId, "the agent", "the peer") ?? "")
    );
  }
  if (replyFrom(subjectEntries, peerId, nonce, since)) return null;
  const reason = `the agent got no reply with ${nonce} from the peer`;
  const story = sendStory(peerEntries, subjectId, "the peer", "the agent");
  if (story) return reason + story;
  const others = sent(peerEntries).slice(0, 3);
  if (others.length)
    return `${reason}; the peer sent: ${others
      .map(
        (e) =>
          `to ${String(e.metadata?.recipient_agent_name ?? e.metadata?.recipient_agent_id)}: ${quote(e.content)}`,
      )
      .join("; ")}`;
  const said = peerEntries
    .filter(
      (e) => e.kind === "text" && e.timestamp >= since && e.content.trim(),
    )
    .pop();
  return `${reason}; the peer sent no message${said ? ` and said ${quote(said.content)}` : ""}`;
}
