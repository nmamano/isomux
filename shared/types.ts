import type { GhostVariant } from "./avatar.ts";
import type { SupportedLanguageCode } from "./languages.ts";

// Agent states derived from SDK stream events
export type AgentState =
  | "idle"
  | "thinking"
  | "tool_executing"
  | "waiting_for_response"
  | "error"
  | "stopped";

// The two-step prompts an agent can be parked on, waiting for a chat reply that
// is read as the answer (task 29daebe2). `state` cannot express this: all four
// park the agent at `waiting_for_response`, which is also where an agent that
// merely finished its turn sits. See AgentInfo.pendingPrompt.
export type PendingPromptKind = "permission" | "resume" | "model" | "effort";

// Deterministic outfit from name hash
export interface AgentOutfit {
  hat: "none" | "cap" | "beanie" | "bow" | "headband";
  color: string; // shirt color hex
  hair: string; // hair color hex
  hairStyle:
    | "short"
    | "long"
    | "ponytail"
    | "bun"
    | "pigtails"
    | "curly"
    | "bald";
  skin: string; // skin color hex
  beard: "none" | "stubble" | "full" | "goatee" | "mustache";
  accessory: "glasses" | "headphones" | "bow_tie" | "tie" | "earrings" | null;
}

// Agent engine. An agent is spawned with one of these, but its engine isn't
// frozen: it's a projection of the active conversation. Each session records the
// engine it ran under (sessions.json), so resuming a session restores its engine
// and starting a new conversation can target a different one. The edit dialog
// shows the current engine read-only; switching happens via resume / new
// conversation, not by editing this field.
export type AgentBackendType = "claude" | "codex";

// Claude's 4-mode permission enum.
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "auto";

// Codex's AskForApproval enum (the four string variants - the experimental
// `granular` object variant is deferred per the spec).
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "on-failure"
  | "never";

// Codex's SandboxMode enum.
export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

// Union of both backends' permission/approval modes. UI uses agentType to
// pick which set is valid.
export type AgentPermissionMode = ClaudePermissionMode | CodexApprovalPolicy;

// Static per-backend capability flags. Embedded in AgentInfo so the UI can
// hide affordances without knowing about specific backends - e.g. greying
// out the "branch" button when capabilities.fork is false. Same shape used
// internally by the Backend interface (server/backends/types.ts re-exports
// it as BackendCapabilities for symmetry).
export interface AgentCapabilities {
  fork: boolean;
  hooks: boolean;
  skills: boolean;
  oneShot: boolean;
  canUseTool: boolean;
  topicGen: boolean;
  edit: boolean;
  mcp: boolean;
}

// All-capabilities-on default. Real server-spawned agents pull capabilities
// from their Backend impl; this fallback is for demo-state fixtures and any
// other shared-code path that needs to instantiate an AgentInfo without
// reaching into the server-side Backend registry.
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = {
  fork: true,
  hooks: true,
  skills: true,
  oneShot: true,
  canUseTool: true,
  topicGen: true,
  edit: true,
  mcp: true,
};

// Model families - what users pick ("I want Opus"). Exact versions are an
// implementation detail that the system bumps centrally in FAMILY_TO_MODEL.
export type ModelFamily = "opus" | "fable" | "sonnet" | "haiku";

export type ClaudeModel = string;

// Repointing a family at a newer model the bundled CLI doesn't know yet? Bump
// @anthropic-ai/claude-agent-sdk in the same commit, the way c2f0946 and
// 136fc53 did -- the CLI reports the model's context window, and an
// unrecognized id makes it fall back to a 200k default (task 89925a7c).
export const FAMILY_TO_MODEL: Record<ModelFamily, ClaudeModel> = {
  opus: "claude-opus-5",
  fable: "claude-fable-5",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

// Default first (MODEL_FAMILIES[0]): opus. New-agent defaults, the welcome
// agent, and the validator fallback all key off MODEL_FAMILIES[0], mirroring
// CODEX_MODELS below.
export const MODEL_FAMILIES: { family: ModelFamily; label: string }[] = [
  { family: "opus", label: "Opus" },
  { family: "fable", label: "Fable" },
  { family: "sonnet", label: "Sonnet" },
  { family: "haiku", label: "Haiku" },
];

// Reasoning effort levels. Most are shared across Claude (--effort flag) and
// Codex (ReasoningEffort enum); `minimal` and `ultra` are Codex-only, and
// `max` is Claude top-tier families plus the Codex gpt-5.6 models. UI
// filters per-backend.
export type EffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export const EFFORT_LEVELS: { level: EffortLevel; label: string }[] = [
  { level: "minimal", label: "Minimal (Codex only)" },
  { level: "low", label: "Low" },
  { level: "medium", label: "Medium" },
  { level: "high", label: "High" },
  { level: "xhigh", label: "Extra high" },
  { level: "max", label: "Max" },
  { level: "ultra", label: "Ultra (Codex only)" },
];

// Shared across backends: the spawn default for new agents/cronjobs and the
// coercion target when validateEffort rejects a value.
export const DEFAULT_EFFORT: EffortLevel = "high";

export function effortDisplayLabel(level: EffortLevel): string {
  return EFFORT_LEVELS.find((e) => e.level === level)?.label ?? level;
}

// Codex model identifiers and their UI labels. Lives here (shared) so both
// the UI's display helpers and the server can reference the canonical set.
// Verified against `codex debug models` on codex-cli 0.144.1 (2026-07-11).
// Default first (CODEX_MODELS[0]): gpt-5.6-sol, the frontier agentic coding
// model. New-agent defaults, the welcome agent, and the dialogs'
// auth-error preferred-default branch all key off CODEX_MODELS[0].
export const CODEX_MODELS: { value: string; label: string }[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini" },
];

// Extract a display version from the exact model id: "claude-opus-4-8" -> "4.8",
// "claude-fable-5" -> "5". Matches one or two numeric components after the
// family prefix and stops before trailing date stamps
// ("claude-haiku-4-5-20251001" -> "4.5").
export function modelVersionLabel(family: ModelFamily): string {
  const exact = FAMILY_TO_MODEL[family];
  const match = exact.match(/-(\d+)(?:-(\d+))?/);
  if (!match) return exact;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

// Type guard for Claude's model families.
export function isClaudeFamily(s: string): s is ModelFamily {
  return s === "opus" || s === "fable" || s === "sonnet" || s === "haiku";
}

// "Opus 4.8" for Claude families; "GPT-5 mini" etc for Codex. Falls back to
// the raw value for unknown strings.
export function familyDisplayLabel(family: string): string {
  if (isClaudeFamily(family)) {
    const base =
      MODEL_FAMILIES.find((m) => m.family === family)?.label ?? family;
    return `${base} ${modelVersionLabel(family)}`;
  }
  const codex = CODEX_MODELS.find((m) => m.value === family);
  if (codex) return codex.label;
  return family;
}

// True when familyDisplayLabel's output already tells you which engine the
// agent runs on, so rendering the engine next to it would just repeat it
// ("GPT-5.6 Sol · codex"). Every Claude family reads as "Opus 5"/"Haiku 4.5",
// and every KNOWN Codex model reads as "GPT-…" - both unmistakable.
//
// The exception is a Codex slug missing from CODEX_MODELS: the model list is
// fetched live from the Codex app-server, so an agent can end up on a slug
// this table doesn't carry. familyDisplayLabel then falls back to the raw
// slug, which says nothing about the backend on its own - there the engine is
// the only signal, so callers should still show it.
export function modelLabelImpliesEngine(family: string): boolean {
  return isClaudeFamily(family) || CODEX_MODELS.some((m) => m.value === family);
}

// Migrate a legacy exact model ID (e.g. "claude-opus-4-6") to a family.
export function familyFromLegacyModel(model: string | undefined): ModelFamily {
  if (!model) return "opus";
  if (model.includes("fable")) return "fable";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "opus";
}

// Claude families that support the "max" effort level. Historically opus-only;
// Fable 5 (the 2.1.170 flagship) also supports it, verified end-to-end through
// the bundled binary. Single source so the UI effort filters, the backend's
// listModels metadata, and server-side validateEffort stay aligned.
export function claudeFamilySupportsMaxEffort(family: string): boolean {
  return family === "opus" || family === "fable";
}

// Static effort options for an agent, filtered by backend + model family.
// Claude: family-level rules ("minimal"/"ultra" are Codex-only; "max" is
// top-tier families only) - single source for claude.ts listModels and the
// /effort slash-command picker. Codex: the full static list; the real
// allow-list is the dynamic per-model supportedReasoningEfforts from
// model/list, and codex rejects unsupported values at thread/start,
// mirroring validateEffort's pass-through philosophy.
export function effortLevelsFor(
  agentType: AgentBackendType,
  modelFamily: string,
): { level: EffortLevel; label: string }[] {
  if (agentType === "codex") return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter((e) => {
    if (e.level === "minimal" || e.level === "ultra") return false;
    if (e.level === "max") return claudeFamilySupportsMaxEffort(modelFamily);
    return true;
  });
}

// Claude families allowed to use Isomux's "auto" permission mode (the /resolve
// auto-classifier). Gated to top-tier models for classifier reliability:
// opus historically, now opus + fable.
export function claudeFamilySupportsAutoPermission(family: string): boolean {
  return family === "opus" || family === "fable";
}

// A pending message waiting for the agent to flush it. Senders can be human
// bosses or other agents; both go through the same queue and flush together
// when the agent next transitions to an idle state. Durable (task 9870b472):
// the per-agent queue is mirrored to ~/.isomux/message-queues.json and
// replayed on boot, so a restart no longer drops queued messages (delivery is
// at-least-once - a crash between backend accept and the durable removal can
// replay an already-delivered message).
export interface QueuedMessage {
  id: string; // 8-char hex; UI uses this to cancel
  sender:
    | { kind: "user"; username?: string; device?: string }
    | { kind: "agent"; agentId: string; agentName: string; roomName: string }
    // A registered app messaging the agent that built it (POST /api/app/message).
    // Only the NAME is carried, and it comes from the app's token rather than its
    // request: an app cannot claim to be another app, an agent, or a boss. The
    // name is also the reason nothing here needs escaping - app names are
    // [a-z0-9-] by registration, so no name can forge the prefix delimiters the
    // flush text uses.
    | { kind: "app"; appName: string };
  text: string; // what we show in chat (raw user input)
  // What we send to the SDK in place of `text`. Set when the queued item is a
  // pre-expanded slash command (e.g. /subagent-review → full skill prompt).
  // Stays undefined for plain user messages.
  sdkText?: string;
  // True when the message landed while the agent was busy (thinking /
  // tool_executing). Used at flush time to warn the agent that the sender
  // hadn't yet seen its most recent reply when sending this.
  queuedDuringBusyTurn?: boolean;
  // Set when this message was created by the scheduled-message scheduler (a
  // sender agent's earlier POST with deliverAt): the epoch-ms time it was
  // scheduled to fire. Used at flush time to mark the message as scheduled -
  // and, for a self-addressed one, as coming from the agent's own past self -
  // so the receiver doesn't read it as a live conversational turn.
  scheduledFor?: number;
  // Set alongside scheduledFor when the sender agent no longer existed at fire
  // time (scheduled messages always deliver - Nil's decision, task 8ff369b5).
  // Surfaced in the flush prefix so the receiver knows a reply cannot land.
  scheduledSenderGone?: boolean;
  // Set when this is a self-handoff brief injected by POST /api/agents/:id/handoff
  // into the agent's own freshly-reset session (task 8883e45d). Used at flush
  // time to mark the message as coming from the agent's previous session, so the
  // fresh copy treats it as its own brief instead of replying to itself.
  handoff?: boolean;
  attachments?: Attachment[];
  queuedAt: number;
}

// A message scheduled for future delivery (POST /api/agents/:id/messages with
// deliverAt). Durable: persisted to ~/.isomux/scheduled-messages.json and
// reloaded on boot; at fire time it hands off to the (also durable)
// QueuedMessage queue. Sender name/room are SNAPSHOTS taken at schedule time: delivery
// re-resolves the live display when the sender still exists (fresher name) and
// falls back to the snapshot when it doesn't (scheduled messages always
// deliver; the receiver is told when the sender is gone).
export interface ScheduledMessageEntry {
  id: string; // "sm_" + 8-char hex; the list/cancel handle
  senderAgentId: string;
  senderName: string;
  senderRoomName: string;
  receiverAgentId: string;
  text: string;
  // Optional retry-dedup key, scoped per sender. Persisted so idempotency
  // survives restarts: a duplicate schedule POST returns the ORIGINAL id.
  clientMessageId?: string;
  deliverAt: number; // epoch ms (parsed from the RFC3339 request field)
  createdAt: number;
}

// Context-window fullness snapshot pushed to the UI over agent_updated
// (internal-docs/context-fullness-visibility.md). Same shape as the server's
// internal ContextUsageSnapshot minus `source`. `percentage` is the backend's
// raw float (0..100) - round only for display so the icon's color band and the
// injected [context check] notices key off the same value. Absent/undefined =>
// the indicator is hidden (no committed measurement: fresh/blank conversation,
// Codex before its first turn, right after a server restart).
export interface ContextUsageWire {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  sampledAtMs: number;
}

// One plan-allowance window (Claude's five_hour / seven_day / per-model
// windows, Codex's primary / secondary rate-limit windows). `usedPercent` is
// the backend's raw float (0..100) - round only for display, same rule as
// ContextUsageWire.percentage.
export interface SubscriptionWindowWire {
  // Display label already resolved server-side ("Weekly", "5-hour",
  // "Weekly (Opus)"), so the UI never has to know per-backend window names.
  label: string;
  usedPercent: number;
  resetsAtMs: number | null; // epoch ms, or null when the backend omits it
}

// How much of the BACKEND ACCOUNT's subscription allowance has been burned.
// Account-scoped, NOT conversation-scoped: every agent signed in to the same
// claude.ai account / CODEX_HOME reports the same figure, and it deliberately
// survives /clear, fork and resume (the quota doesn't reset when a
// conversation does). Absent/undefined => the pill shows its unknown "?" state
// (API key / Bedrock / Vertex Claude sessions, Codex before any rate-limit data
// has arrived, right after a server restart).
export interface SubscriptionUsageWire {
  // Backend-reported plan name ("max", "pro", "plus", ...), or null.
  plan: string | null;
  // At least one entry whenever this object exists, in a stable display order
  // (the plan-shaped window first). Every entry is a popover row.
  windows: SubscriptionWindowWire[];
  // Index into `windows` of the one the PILL shows: whichever is closest to
  // its limit, picked server-side. Named explicitly rather than relying on
  // windows[0], because display order and "the binding window" are different
  // questions and the UI must not have to guess which it's being handed.
  primaryIndex: number;
  sampledAtMs: number;
}

// What the browser knows about an agent
export interface AgentInfo {
  id: string;
  name: string;
  desk: number; // 0-7
  // Stable global room id (matches RoomWire.id) - the SOLE room reference on the
  // wire and the authority for all room logic. Phase 3c slice 4 removed the
  // legacy dense per-recipient `room` index; clients match agents to rooms by id.
  roomId: string;
  cwd: string;
  outfit: AgentOutfit;
  // Backend-specific permission/approval mode. For Claude this is the
  // canonical 4-mode enum; for Codex this is the AskForApproval enum
  // (untrusted/on-request/on-failure/never). Kept as a typed union that
  // covers both backends - the spawn UX picks one backend at a time so
  // we never need to combine them.
  permissionMode: AgentPermissionMode;
  // Backend-specific model identifier. For Claude this is a ModelFamily
  // ("opus"/"sonnet"/"haiku"); for Codex this is the GPT-5 family value
  // ("gpt-5.5"/"gpt-5.6-sol"/"gpt-5.6-terra"/"gpt-5.6-luna"/...). Display
  // logic narrows on agentType before rendering.
  modelFamily: string;
  effort: EffortLevel;
  state: AgentState;
  topic: string | null;
  topicStale: boolean;
  customInstructions: string | null;
  // Optimistic-concurrency token over the customInstructions blob (task
  // 44a2c98d): versionOf(customInstructions ?? "") from shared/blob-version.ts,
  // maintained in LOCKSTEP wherever customInstructions is set (OfficeState
  // spawn/editAgent + the server's load/restore paths). A PATCH that carries
  // customInstructions must echo this token back (customInstructionsVersion in
  // EditAgentReq); a mismatch is a 409 version_conflict. Scalar-only edits
  // (name/cwd/model/...) don't require it. READ surfaces: the UI edit dialog
  // reads the agent off full_state / agent_updated; agents read blob + version
  // via GET /api/agents/:id/instructions (agents.readInstructions, task
  // 68891fa1 - open to every authenticated identity with room access to the
  // agent; the version is a concurrency token, not an authorization gate).
  customInstructionsVersion: string;
  // Which engine this agent runs on. Fixed at spawn time. Existing agents
  // persisted before this field landed default to "claude" on load.
  agentType: AgentBackendType;
  // Static capabilities of this agent's backend. Populated server-side from
  // the Backend implementation; UI uses these to gate affordances.
  capabilities: AgentCapabilities;
  // Codex-only: sandbox mode (CodexSandboxMode). Stored separately from
  // permissionMode because Codex's permission model has two orthogonal axes
  // (sandbox + approval-policy) while Claude has one. Undefined for Claude
  // agents.
  codexSandbox?: CodexSandboxMode;
  // The user who spawned this agent. `userId` is the stable identity
  // reference used for per-user env lookup (drives buildEnvFor at spawn /
  // resume / cronjob-fire time) and identifies the agent's manager - the
  // user shown in the system prompt user section and whose envFile loads
  // on session recreate. Set at spawn and immutable: reassignment is not
  // exposed; the spawning user remains the manager for the agent's
  // lifetime. `username` is the matching display snapshot; goes stale
  // across renames but isn't authoritative for any behavior. Both null
  // on legacy unowned agents that pre-date the user/device split.
  userId: string | null;
  username: string | null;
  // Privileged agents carry their spawning user's room-scoped operator
  // capabilities in their bearer token (drive other agents' sessions: resume,
  // listSessions, sendNow, newConversation, lifecycle, cron over their own
  // jobs). Scope STAYS "agent" - privilege only adds capabilities, never
  // impersonates the user. Bound to the token (re-minted on toggle), mirrored
  // here for the UI toggle state. Settable only by a user via the dedicated
  // agents.setPrivileged route; never by an agent. Absent/false on normal
  // agents.
  privileged?: boolean;
  // Mirrored to ~/.isomux/message-queues.json and replayed on boot (task
  // 9870b472) - a restart no longer empties it. Live source of truth is the
  // manager's in-memory queue; this wire copy is spliced in by getAllAgents.
  queue: QueuedMessage[];
  // True while server is closing the old SDK session and installing a new one
  // (~3s drain). UI shows a "restarting session" hint while this is true.
  sessionSwapping: boolean;
  // True when the agent has no live backend subprocess - it was idle-evicted
  // (the inactivity sweep demoted it) or lazy-restored on boot. It keeps its
  // session on disk and resumes transparently on the next message. Tracks
  // `ManagedAgent.session === null` as the single source of truth (set in
  // lockstep wherever the session is closed/installed). Carried on the wire for
  // future presentation; v1 renders no badge. Absent/false on live agents.
  dormant?: boolean;
  // True iff the current (or most-recent) turn started by processing a human
  // message. The UI gates the turn-end notification sound on this so an
  // agent-only turn (one agent messages another, the receiver answers and
  // idles) stays silent.
  turnHadHumanInput: boolean;
  // Which two-step prompt the agent is parked on, or null/absent when it is not
  // parked (task 29daebe2). A parked agent sits at state
  // `waiting_for_response` - the same state as one that has simply finished a
  // turn - and the prompt itself is written as an EPHEMERAL log entry, so it
  // never reaches disk and never appears in the logs API. Without this field an
  // operator (or a manager agent) reading a transcript sees a turn that stops
  // mid-way and concludes the backend died.
  //
  // LIVE STATE, NOT HISTORY. It describes the agent right now; it is not part
  // of any recorded transcript. Carries the KIND of prompt only - never its
  // text, the tool name, or the command - so rendering it discloses nothing
  // beyond "this agent is waiting for an answer". In-memory server-side and NOT
  // part of PersistedAgent: a restart clears it, which is correct, because the
  // pending prompt does not survive a restart either. Clears go over the wire
  // as EXPLICIT null for the same JSON.stringify reason as contextUsage below.
  pendingPrompt?: PendingPromptKind | null;
  // Live context-window fullness of the CURRENT conversation, pushed over
  // agent_updated (internal-docs/context-fullness-visibility.md). Absent or
  // null while there's no committed measurement (fresh conversation, Codex
  // pre-first-turn, right after a server restart) - the UI battery indicator
  // shows its unknown state ("?", always visible; per Nil 2026-07-18).
  // Clears go over the wire as EXPLICIT null, never undefined:
  // JSON.stringify drops undefined-valued keys, so an undefined clear would
  // vanish in serialization and the client's spread-merge would keep the
  // stale reading. In-memory server-side and NOT part of PersistedAgent, so
  // a restart clears it until the next completed turn repopulates it.
  contextUsage?: ContextUsageWire | null;
  // Subscription-allowance usage of the account this agent's backend is signed
  // in to, pushed over agent_updated. Absent or null when the backend can't
  // report it - the UI hides the pill entirely (unlike the context battery,
  // which has a visible "unknown" state). Clears go over the wire as EXPLICIT
  // null for the same JSON.stringify reason as contextUsage above. In-memory
  // server-side and NOT part of PersistedAgent.
  subscriptionUsage?: SubscriptionUsageWire | null;
}

// File attachment metadata
export interface Attachment {
  filename: string; // on-disk hash name: "a1b2c3.png"
  originalName: string; // user-facing: "photo.png"
  mediaType: string; // "image/png", "application/pdf", etc.
  size: number; // bytes
}

// Per-file summary inside a kind:"diff" LogEntry. The server pre-computes
// inlineEligible so the client doesn't re-parse the patch to decide rendering.
export interface DiffFileSummary {
  path: string;
  oldPath?: string; // set on rename / copy
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "untracked"
    | "binary";
  additions: number;
  deletions: number;
  lineCount: number; // approx size of the per-file patch (additions + deletions)
  inlineEligible: boolean; // server-computed: lineCount <= 500 && !binary && patch present
}

// Structured payload attached to LogEntry when kind === "diff".
export interface DiffPayload {
  cwd: string;
  branch: string | null; // null on detached HEAD or fresh repo
  head: string | null; // short SHA, null on fresh repo with no commits
  // Present when the diff targets a specific commit/range rather than the
  // working tree. UI renders this under the headerLine for context (commit
  // subject for single commits, or the literal range string for ranges).
  // Optional so that diff log entries persisted before this field existed
  // still type-check on reload (the UI's null-coalescing handles undefined).
  subject?: string | null;
  stats: { additions: number; deletions: number; filesChanged: number };
  files: DiffFileSummary[];
  patchText: string | null; // null when over 2MB safety rail
  truncated: boolean; // true when patchText was dropped
}

// Structured payload attached to LogEntry when kind === "edit-request".
// Emitted by /isomux-edit or POST /api/agents/:id/edit-file. The card surfaces
// an [Open in editor] button that opens the side panel for this path.
export interface FilePayload {
  cwd: string; // agent cwd at emission time (for trimming display)
  path: string; // resolved absolute path
}

// Structured payload attached to LogEntry when kind === "terminal-command".
// Emitted by POST /api/agents/:id/terminal-command. The card surfaces a
// [Copy to terminal] button that opens the terminal side panel and types
// the command at the prompt without executing it (boss presses Enter).
export interface TerminalCommandPayload {
  command: string; // single-line shell command
}

// Which loop a tool call came from, when it was NOT the agent's own. A
// subagent (Claude's Agent/Task tool, Codex's collab child threads) runs its
// own tool calls on the same stream as the parent's - so an unmarked
// transcript reads as one flat run with no way to tell who made a call. Rides
// as `metadata.subagent` on tool_call / tool_result entries and is simply
// absent on the agent's own calls and on entries written before it existed.
//
// `parentToolUseId` is the id of the call that spawned the subagent (Claude:
// the Agent/Task tool_use id; Codex: the spawning collabAgentToolCall id, or
// the child thread id when no spawn call was seen) - the join back to the
// parent card. `type` and `description` are the backend's labels for the
// subagent and its assignment (model-authored free text, sanitized to one
// capped line by the backend); older SDKs omit both.
export interface SubagentOrigin {
  parentToolUseId: string;
  type?: string;
  description?: string;
}

// Log entry in the conversation view
export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: number;
  kind:
    | "text"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "error"
    | "system"
    | "user_message"
    | "diff"
    | "edit-request"
    | "terminal-command"
    | "file-view";
  content: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[]; // file attachments, served via /api/files/<agentId>/<filename>
  diff?: DiffPayload; // present only when kind === "diff"
  file?: FilePayload; // present only when kind === "edit-request"
  terminal?: TerminalCommandPayload; // present only when kind === "terminal-command"
  // UI-only markers (e.g. "Conversation cleared.") that must never reach disk.
  // appendLog and the system_init backfill both skip entries with this set.
  ephemeral?: true;
}

// Slide Mode (design: internal-docs/slide-mode-design.md). One rendered slide
// for one assistant turn, keyed server-side by the turn's user_message entry id.
// Why a turn has no slide to show. A CLOSED set of codes, deliberately: the
// underlying errors are backend/provider exception text and raw model output,
// which are neither a stable contract nor something to broadcast to every
// session that can see the room. Full detail stays in the server journal.
//   generation_failed - the formatter call itself failed.
//   invalid_output    - it answered, but broke the slide contract.
//   unavailable       - client-local: there is no live turn to render.
export type SlideFailureReason =
  | "generation_failed"
  | "invalid_output"
  | "unavailable";

// Shared by the sidecar store, the ensure-slide API, and the slide_ready WS push
// so all three agree on the shape.
export interface SlideRecord {
  // The self-contained inline-styled HTML fragment, or null for a
  // placeholder-only record (an empty / interrupted / tool-only turn that has
  // no text to format). Rendered ONLY inside a sandboxed iframe, never injected
  // into the app DOM.
  html: string | null;
  // True when the turn produced no assistant text - the deck still shows a
  // placeholder so it mirrors the conversation 1:1.
  placeholder: boolean;
  // The turn's error text (when it failed), shown on the placeholder. Null
  // otherwise.
  errorText: string | null;
  // The frozen prompt that started the turn (shown beneath the slide).
  promptText: string;
  // The backend model family the formatter ran on (e.g. "sonnet").
  model: string;
  createdAt: number;
  // Digest of the turn CONTENT this slide was generated from (prompt + answer +
  // error, via slideContentDigest). The cache-validity signal: a stored slide is
  // served only while this equals the live turn's digest - a turn that gained
  // text after a placeholder was recorded no longer matches and is regenerated.
  // Optional so slide files written before this field (self-hosters) still load;
  // a record with no digest is unverifiable and is regenerated once on next view.
  contentDigest?: string;
}

// Task item (replaces todos)
export type TaskStatus = "open" | "in_progress" | "done" | "backlog";
export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export interface TaskItem {
  id: string; // 8-char hex hash
  title: string;
  description?: string;
  priority?: TaskPriority;
  status: TaskStatus;
  assignee?: string;
  createdBy: string; // Actor that created the record (agent name or user name)
  username?: string; // Human boss this record is on behalf of
  createdAt: number;
  // Room this task belongs to. ABSENT/empty === office-global (visible to
  // everyone). A non-empty id scopes the task to that room: it is visible only
  // to callers who can access the room, UNION every global task. Existing tasks
  // (persisted before room-scoping) have no roomId and so are global - no
  // migration.
  roomId?: string;
}

// isomux-memory - one durable, attributed fact line. Persisted as a single raw
// markdown line ("- {Creator}, {date}: {text}") under STATE_ROOT/memory/. See
// internal-docs/isomux-memory-design.md.
export type MemoryScope = "office" | "room" | "agent" | "boss";

export interface MemoryItem {
  scope: MemoryScope;
  scopeId: string | null; // office has none
  // The in-file Creator (server-stamped on append; free-text after a rewrite).
  // null when the line names no author, which an APPEND writes only for an
  // agent's note to its OWN agent scope - there the author is the reader.
  author: string | null;
  date: string; // YYYY-MM-DD
  text: string; // the self-contained fact
  raw: string; // the exact persisted markdown line
}

// Generate a unique 8-char hex ID, avoiding collisions with `existing`.
function generateHexId(existing?: string[]): string {
  const ids = existing ? new Set(existing) : undefined;
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!ids || !ids.has(id)) return id;
  }
}

export function generateTaskId(existing?: string[]): string {
  return generateHexId(existing);
}

export function generateCronjobId(existing?: string[]): string {
  return generateHexId(existing);
}

export function generateCronjobRunId(existing?: string[]): string {
  return generateHexId(existing);
}

export function generateUserId(existing?: string[]): string {
  return generateHexId(existing);
}

// ---------------------------------------------------------------------------
// Agent-built apps
// ---------------------------------------------------------------------------
// An app is a web app an agent built and handed to isomux to run. Like a
// cronjob it is a thing isomux runs that is NOT an agent; unlike a cronjob it
// outlives the agent that made it, because it belongs to the USER (design doc
// section 3). See internal-docs/agent-apps-design.md.
//
// There is no separate id: the NAME is the key. A name is bound to one app for
// that app's whole life and there is no verb that changes it, so a second
// identifier would be dead weight and one more thing to disagree with itself.
// Everything derived from a name (the data directory, and the unit name once a
// supervisor exists) therefore has a stable value for as long as the app lives.
// Deleting an app frees the name for the next one.
export interface AppRecord {
  // Hostname label, unique across LIVE apps. Lowercase [a-z0-9-], never
  // starting or ending with a hyphen, at most 63 chars (one DNS label), so it
  // can become a hostname later without changing.
  name: string;
  // The lineage's stable hostname label and its historical label generation.
  // New lineages use the bare name at generation 1. Existing generated labels
  // remain unchanged across upgrades and later reuse, so a rollback cannot
  // move a wanted URL.
  hostLabel: string;
  hostGen: number;
  // Allocated by isomux at registration and fixed for the app's whole life:
  // moving a live app's port would break every bookmark pointing at it. A
  // deleted app's port returns to the pool.
  port: number;
  // Start command and working directory, stored verbatim / resolved. Whether
  // the command actually runs is the supervisor's problem, not the registry's.
  command: string;
  cwd: string; // absolute, verified to exist at registration
  description?: string;
  // Absolute path isomux created and handed over, so app state lands somewhere
  // known (and inside the backup set) instead of wherever the agent felt like
  // writing. Derived from the name, and always empty at registration: deleting
  // an app keeps its data by setting the directory aside, so a later app of the
  // same name never inherits it.
  dataDir: string;
  // OWNER: the user the app belongs to - for an agent caller, its manager. The
  // app survives the agent, so ownership can never be the agent.
  userId: string | null;
  username: string | null; // display snapshot of the owner (can go stale)
  // Attribution only: who registered it. createdByAgentId is also the default
  // message target once apps can message their agent.
  createdBy: string;
  createdByAgentId?: string;
  createdAt: number;
}

// What an app is doing. The registry persists NO state field: a stored
// "running" is a lie the moment the box reboots, so state is DERIVED at read
// time, by asking systemd.
//
// `unknown` is not a synonym for `stopped`, and the difference is the point of
// having it: `stopped` means systemd is holding the app still on purpose, while
// `unknown` means there is no unit at all, or systemd could not be asked. One
// of those is a state somebody chose and the other is a fault.
export type AppState =
  | "running"
  | "starting"
  | "stopped"
  | "failed"
  | "unknown";

// An app as it goes over the wire: the record plus what only the supervisor
// knows. Its canonical home is here rather than contract-shapes.ts because
// ServerMessage carries it (app_upserted), and contract-shapes.ts imports from
// this module - the same reason UserPublicWire lives here.
export interface AppWire extends AppRecord {
  state: AppState;
  // AUTOMATIC restarts since the app was last activated (systemd's NRestarts).
  // A number climbing on its own is the signal that an app is crash-looping
  // rather than serving. It resets when the app is stopped and started again,
  // which is the honest scope rather than a lifetime total: an explicit restart
  // is a new activation, and counting across one would report a fixed app as
  // still broken.
  restartCount: number;
  // Why the last install or start attempt failed, when one did. Absent means
  // no attempt has failed since isomux started.
  //
  // It exists because registering an app answers 201 even when the app does not
  // come up - the registration really did happen, and a 500 would invite a
  // retry that can only ever be told the name is taken. That leaves `state` as
  // the only signal, and `state` cannot say WHY. An agent has no access to the
  // server log, and a failure to install the unit at all happens before there
  // is anything in journald to read, so without this the reason is invisible
  // to the API's main consumer.
  //
  // In memory only, so it does not survive an isomux restart. That is the
  // honest scope: it describes an attempt this process made, and after a
  // restart `state` still tells the truth while the next attempt regenerates
  // the reason.
  startError?: string;
  // Where the app answers on the public internet, when the office has app
  // hostnames at all. Derived from the office's public origin and the app's
  // issued LABEL (never its name, which is reusable), and never stored -
  // present exactly when a URL exists, absent otherwise, the same rule the
  // app's own ISOMUX_APP_URL follows.
  url?: string;
}

// The launch-only projection returned to a room-derived viewer who may open
// an app but may not manage it. Process arguments and filesystem paths stay on
// AppWire, which is returned only to the app owner and office owners.
export interface AppViewerWire {
  name: string;
  port: number;
  description?: string;
  userId: string | null;
  username: string | null;
  createdByAgentId: string;
  state: AppState;
  restartCount: number;
  url?: string;
  canManage: false;
}

export type AppListWire = (AppWire & { canManage?: true }) | AppViewerWire;

// ---------------------------------------------------------------------------
// Cronjobs
// ---------------------------------------------------------------------------
// Cronjobs are scheduled SDK sessions. They are NOT agents - no desk, no room,
// no persistent identity. Each scheduled fire creates a fresh session whose
// transcript becomes a "run" row.

export type Schedule =
  | { type: "daily"; hour: number; minute: number }
  | {
      type: "weekly";
      weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
      hour: number;
      minute: number;
    }
  | { type: "interval"; minutes: number };

// Permission modes available for cronjobs. Subset of each backend's full set:
// modes that block on human approval would hang forever in an unattended run.
//   Claude: "bypassPermissions" (auto-allow all)
//   Codex:  "never" (no approval prompts; pairs with the sandbox setting)
// agentType selects which subset is legal at validation time.
//
// Note: Claude's "auto" mode IS NOT supported for cron. With the Backend
// abstraction in place, ClaudeSession always installs `canUseTool`, which
// routes approval decisions through the agent /resolve mechanism - cron
// has no resolver, so an "auto" classifier mismatch would hang the run
// until the 30-minute hard timeout. Legacy cronjobs persisted with
// `permissionMode: "auto"` get coerced to `bypassPermissions` on load.
export type CronjobPermissionMode = "bypassPermissions" | "never";

// modelFamily is typed as `string` to span both backends - Claude uses
// ModelFamily slugs ("opus" / "sonnet" / "haiku") while Codex uses the
// app-server-reported model ids ("gpt-5.5" etc, fetched via model/list).
// Validation happens server-side per agentType.
export type CronjobModel = string;

export interface Cronjob {
  id: string; // 8-char hex
  name: string; // free text, not unique
  schedule: Schedule;
  prompt: string; // first user message at each fire
  cwd: string;
  agentType: AgentBackendType; // immutable on edit, mirroring agents
  modelFamily: CronjobModel;
  effort: EffortLevel;
  permissionMode: CronjobPermissionMode;
  codexSandbox?: CodexSandboxMode; // Codex only; undefined → backend default
  enabled: boolean;
  createdBy: string; // Actor that created the record (agent name or user name)
  // Identity reference used for per-user env at fire time. `username` is a
  // display snapshot that can go stale across renames; `userId` is the
  // stable handle for env / ownership lookups. Both null for legacy
  // unowned cronjobs.
  userId: string | null;
  username: string | null; // Human boss this record is on behalf of
  createdAt: number;
  lastFireAt: number | null;
  nextFireAt: number;
}

export type CronjobRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "skipped";
export type CronjobRunTrigger = "scheduled" | "manual";

export interface CronjobRun {
  id: string; // 8-char hex
  cronjobId: string;
  cronjobName: string; // denormalized so deleted-cronjob runs still display
  trigger: CronjobRunTrigger;
  status: CronjobRunStatus;
  startedAt: number;
  endedAt: number | null;
  errorReason: string | null;
  promptSnapshot: string;
  agentTypeSnapshot: AgentBackendType;
  modelFamilySnapshot: CronjobModel;
  effortSnapshot: EffortLevel;
  cwdSnapshot: string;
  permissionModeSnapshot: CronjobPermissionMode;
  codexSandboxSnapshot?: CodexSandboxMode;
  rootSessionId: string; // first session id created at fire time
  // Leaf of the fork chain - equals rootSessionId for un-forked runs. Tracked
  // separately from rootSessionId so loadRunLogWithAncestors can walk back from
  // the leaf when the user has edited a message and forked. Optional for
  // backwards compatibility with runs persisted before resume support landed.
  currentSessionId?: string;
  previewText: string; // last assistant text block, truncated ~120 chars
  // Set on manual fires only (run_cronjob_now) - captures the user that
  // triggered the run so the UI can show "Manually triggered by Nil".
  // Scheduled fires leave this undefined.
  triggeredBy?: string;
}

// Cronjob runs piggy-back on the LogEntry.agentId routing by using a
// "cronrun-<runId>" prefix as a synthetic stream id. Entries written for a run
// carry this in `agentId` so the existing client-side Map<streamId, entries>
// routing works unchanged.
export function cronjobRunStreamId(runId: string): string {
  return `cronrun-${runId}`;
}

export function humanizeSchedule(s: Schedule): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (s.type === "daily") return `Daily at ${pad(s.hour)}:${pad(s.minute)}`;
  if (s.type === "weekly") {
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Weekly ${weekdays[s.weekday]} at ${pad(s.hour)}:${pad(s.minute)}`;
  }
  if (s.minutes < 60) return `Every ${s.minutes}m`;
  if (s.minutes % 60 === 0) return `Every ${s.minutes / 60}h`;
  return `Every ${Math.floor(s.minutes / 60)}h${s.minutes % 60}m`;
}

const VALID_STATUSES = new Set<TaskStatus>([
  "open",
  "in_progress",
  "done",
  "backlog",
]);
const VALID_PRIORITIES = new Set<TaskPriority>(["P0", "P1", "P2", "P3"]);

export function isValidStatus(s: unknown): s is TaskStatus {
  return typeof s === "string" && VALID_STATUSES.has(s as TaskStatus);
}

export function isValidPriority(p: unknown): p is TaskPriority {
  return typeof p === "string" && VALID_PRIORITIES.has(p as TaskPriority);
}

// Session info for resume feature
export interface SessionInfo {
  sessionId: string;
  lastModified: number;
  topic: string | null;
  // The cwd this session runs in. Source of truth is per-session metadata
  // (sessions.json); the agent's own cwd is just a denormalized mirror of the
  // active session's cwd. Optional/null for legacy sessions persisted before
  // per-session cwd existed - callers fall back to the agent cwd then.
  cwd?: string | null;
  // The engine + model this session runs under. Source of truth is per-session
  // metadata (sessions.json). null for legacy sessions persisted before
  // per-session engine existed - the resume picker omits the badge then.
  // Selecting a session whose engine differs from the agent's current one flips
  // the agent to that engine; agentType is thus a projection of the live session.
  agentType?: AgentBackendType | null;
  modelFamily?: string | null;
  branched?: boolean; // true if another session was forked from this one
  forked?: boolean; // true if this session is a fork (was created by editing a message)
}

// Skill metadata for autocomplete and /help
export type SkillOrigin = "user" | "project" | "plugin" | "isomux" | "claude";
export interface SkillInfo {
  name: string;
  origin: SkillOrigin;
  description?: string;
  /**
   * Marks this entry as an alias of another skill. The other skill is the
   * canonical name (typically the on-disk directory name); this one is a
   * friendlier alias declared via SKILL.md frontmatter. /help groups
   * canonicals + aliases so the user sees a single line per skill.
   */
  aliasFor?: string;
}

// Office-level settings (prompt + optional env file path + optional display name)
export interface OfficeSettings {
  prompt: string | null;
  envFile: string | null;
  name: string | null;
}

// Office settings as PROJECTED to the wire (full_state.office / the all-audience
// office_settings_updated): envFile is owner-only (Phase 3b slice 5 / Isomuxer3
// Q1b), so it is OMITTED for member recipients and never rides the all-audience
// office_settings_updated. Owner full_state carries it; members never see it.
export interface OfficeWire {
  prompt: string | null;
  name: string | null;
  envFile?: string | null;
}

// Maximum number of revive chips offered in the spawn menu. Applied
// server-side after ACL filtering and on the client when merging diff
// events into state - shared so the two never drift.
export const KILLED_AGENT_CHIP_CAP = 12;

// Summary of a killed agent shown as a "revive" chip in the spawn menu.
// Carries only what the chip needs to render + the id + lastRoomId for
// ACL filtering on the wire (cwd/customInstructions stay server-side and
// are loaded from agent-history at revive time). Sorted by killedAt desc
// in the UI; the server applies per-session ACL filtering before sending.
export interface KilledAgentSummary {
  id: string;
  name: string;
  agentType: AgentBackendType;
  lastRoomId: string;
  lastRoomName: string;
  topic: string | null;
  killedAt: number; // ms timestamp
}

// A room with stable ID, display name, and per-room config.
// Access control lives entirely in `UserRecord.allowedRooms` - the
// create-room handler adds the new roomId to the creator's list and
// to every current owner's list, regardless of the creator's role.
// There is no per-room "private" flag; "private to creator + owners"
// is an emergent behavior of who's been added to which user's
// allowedRooms at creation time. Members other than the creator are
// not auto-added; an owner has to grant them through the Allowed
// Rooms editor.
export interface RoomWire {
  id: string; // 8-char hex, stable
  name: string; // display name
  prompt: string | null;
  // Phase 3c slice 4: derived close-affordance capability. false ONLY for the
  // protected canonical first room (room-order index 0); true for every other
  // room. NOT an occupancy signal - the client ANDs it with its own reactive
  // emptiness check, and the server stays authoritative on close (closeRoom
  // rejects index 0 and non-empty rooms). Derived from canonical room order by
  // OfficeState whenever rooms are materialized; never persisted (re-derived on
  // load), so it cannot drift from the canonical order.
  canCloseWhenEmpty: boolean;
}

// Per-user record stored server-side in ~/.isomux/users.json. Keyed by
// `id` (stable hex) since the V2 identity-id migration; display name lives
// in the `name` field and can be renamed without breaking sessions/agents/
// cronjobs that reference the user via id.
//
// Both notifRooms and allowedRooms are strict string[] - no "all"
// sentinel. New users get an explicit snapshot of the rooms they're
// allowed to see at creation time; the create_room handler appends
// new room ids to the right users' lists as the office evolves.
export type NotifRoomsSetting = string[];

export type UserRole = "owner" | "member";

export interface UserRecord {
  id: string; // stable 8-char hex; the storage key in users.json
  name: string; // display case, e.g. "Nil"; case-insensitively unique
  notifRooms: NotifRoomsSetting;
  envFile: string | null; // absolute path to dotenv file
  createdAt: number;
  role: UserRole; // app-level role; owner can invite users, revoke sessions, and set per-user room access
  // Visual identity for the live-avatars feature. avatarColor is a hex
  // string ("#rrggbb"); avatarVariant picks one of the 8 ghost shapes in
  // shared/avatar.ts → GHOST_VARIANTS. Defaults are filled in at read
  // time in server/users.ts (hash-derived color, "classic" variant) so
  // legacy records without these fields render correctly. Editable
  // through update_user.
  avatarColor: string;
  avatarVariant: GhostVariant;
  // Member room-access GRANTS (Phase 3b) - strict string[] of roomIds a member
  // may access. ACCESS is rule-based: OWNERS reach every room by rule and IGNORE
  // this field (it is [] for an owner post-migration); members access exactly
  // the rooms granted here. No "all" sentinel. New members default to `[]` until
  // an owner grants access (users.setAccess, owner-only) or they create their
  // own room (the creator gets a grant). There is NO create_room owner fan-out.
  // WHICH accessible rooms a user shows, and in what order, is the separate view
  // preference (`hidden`/`order` below) - never this field.
  allowedRooms: string[];
  // View preference (per-user, non-security) - Phase 3b. These split the
  // VIEW (which accessible rooms a user shows, and in what order) out of
  // ACCESS (allowedRooms / owner rule). They never gate security; the
  // projection applies them ON TOP of the access set.
  //   - `hidden`: rooms the user has explicitly hidden from their own view.
  //     Effective shown = accessible \ hidden. An owner who hides a room
  //     still has ACCESS to it (a re-show consults only access, never this).
  //   - `order`: SPARSE explicit room order. Effective order = the rooms
  //     listed here (that are accessible+shown), in this order, then any
  //     remaining accessible+shown rooms in the office's room order. A
  //     brand-new or never-reordered user has `order: []` and falls back to
  //     the office order, so newly-created rooms append at the end for free.
  // Both default to `[]` (backfilled on load for legacy records).
  hidden: string[];
  order: string[];
  // Self-described member profile prompt. Auto-injected into the system
  // prompt of every agent owned by this user, so the agent has standing
  // context about who its owner is. Other agents can also look up this
  // field for any user via ~/.isomux/users.json when a different boss
  // messages them. Optional; null/empty means no profile prompt.
  // Named "member" rather than "owner" because the field exists on every
  // user record regardless of role (member is the superset; UserRole
  // "owner" is the admin-privilege flag).
  memberPrompt: string | null;
  // Personal preferences (task 49d4e2f6). SELF-only: written through
  // PUT /api/me/preferences, never through the selfOrOwner users.update
  // route, so an owner cannot set a member's personal settings. They ride
  // the same private channels as the rest of this record (self + admin),
  // never the public wire.
  //
  // `language`: one of shared/languages.ts SUPPORTED_LANGUAGES, or null when
  // the user has never picked one. Drives the reply-language clause in the
  // agent system prompt plus the voice input/output locale. null means "no
  // clause" - agents behave exactly as they did before the setting existed.
  language: SupportedLanguageCode | null;
  // `slideMode`: the global Slide Mode gate (experimental deck view). Was a
  // per-device localStorage flag until task 49d4e2f6 moved it here, so it
  // follows the user across devices; the per-agent deck-vs-chat toggle stays
  // per-device.
  slideMode: boolean;
}

// Office-wide user display metadata: the ONLY user shape allowed on an `all`
// event or the public roster. Excludes envFile, allowedRooms, memberPrompt, and
// view prefs by construction, so sensitive fields can never ride an `all`
// channel. Canonical home (next to UserRecord + the ServerMessage that
// references it); re-exported from contract-shapes.ts so the server
// route-table / event-registry import sites keep importing from one module.
export type UserPublicWire = Pick<
  UserRecord,
  "id" | "name" | "role" | "avatarColor" | "avatarVariant" | "createdAt"
>;

// Sent to the client over the WS at connect time so the UI knows whether to
// render owner-only surfaces (Access pane, "Sign out" reachability, etc.).
// Display name is derived from the user record at the moment of send, so a
// rename propagates to the wire on the next session_context emission.
export interface SessionContext {
  userId: string;
  username: string;
  role: UserRole;
  // 8-char display prefix of the current session. Lets the Access pane
  // identify "this is my row" without trusting the client to track it.
  // Used to hide the Revoke button on the user's own session row (the
  // server-side gate is the actual safety enforcement; this is UX only).
  currentSessionPrefix: string;
  // Per-WS-connection id (live-avatars feature). Multiple tabs of the
  // same user share `currentSessionPrefix` because the auth session is
  // cookie-scoped, but each tab gets its own connectionId so the per-
  // tab ghost identity stays distinct (per-session presence in the
  // design memo means per-tab, not per-cookie). Generated server-side
  // on WS open, sent down in session_context, and round-tripped in
  // every PresenceInfo so clients can filter their OWN connection's
  // ghost from the scene when in LogView.
  connectionId: string;
}

// Wire shape for an outstanding invite (owner UI). Raw token never crosses
// the wire - only the 8-char display prefix.
export interface InviteWire {
  tokenPrefix: string;
  username: string | null; // null for unconsumed bootstrap invites
  role: UserRole;
  createdBy: string | null; // null for bootstrap (no owner existed yet)
  createdAt: number;
  expiresAt: number;
  bootstrap?: true; // present on bootstrap invites so the UI can label them
  // Room grants attached at mint time (member invites for NEW users only).
  // On accept these seed the created record's allowedRooms so the invitee
  // lands in the intended rooms instead of an empty office. Present only
  // when non-empty.
  allowedRooms?: string[];
}

// Wire shape for a single live-presence entry (live-avatars feature).
// One PresenceInfo per active WS connection whose ghost is renderable;
// off-scene sessions (viewMode "away" with no currentRoomId) are omitted
// from the broadcast entirely. Display fields (username, avatarColor,
// avatarVariant) are baked into the wire so clients don't need to join
// against the users map at render time - avoids races where a fresh
// presence_list arrives before users_list catches up.
export interface PresenceInfo {
  // Per-connection id matching SessionContext.connectionId on the
  // owning client. Stable for the lifetime of the WS; replaced on
  // reconnect. The React key + sort key for ghosts; clients identify
  // their OWN ghost by comparing this against
  // state.sessionContext.connectionId.
  connectionId: string;
  // Stable user id. The click-to-open-user-settings shortcut on a ghost
  // resolves to this id so the modal preopens the right user even if
  // their display name has just changed.
  userId: string;
  username: string;
  // Per-device label set in DeviceSettings (e.g. "Phone", "Laptop").
  // Surfaced on the name-tag chip so other bosses can tell which of
  // a user's devices the ghost belongs to. null when the device hasn't
  // picked a label - the chip falls back to just the username.
  device: string | null;
  avatarColor: string;
  avatarVariant: GhostVariant;
  // Global stable room id (matches RoomWire.id) where this session's ghost
  // appears - the SOLE presence room reference, ALWAYS a global id. Recipients
  // render the ghost only when it matches their OWN selected room id. null when
  // the session has not yet sent its first presence_update or is off-scene.
  // Phase 3c slice 4 removed the dense per-recipient `currentRoom` index.
  currentRoomId: string | null;
  focusedAgentId: string | null;
  viewMode: "office" | "log" | "away";
}

// Wire shape for an active session (owner UI).
export interface SessionWire {
  sessionPrefix: string; // 8-char display prefix; not the full token
  // Stable owning-user id (authoritative on the stored session). The Users
  // page groups sessions per user by this, so a rename or casing change can
  // never split one user's sessions across roster rows.
  userId: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  userAgent: string | null;
  // Last-known device label for this session - the same client-supplied label
  // (DeviceSettings localStorage) that presence name-tags show, e.g. "Phone".
  // Stamped server-side from the session's own presence_update stream; null
  // until the device names itself. Read-only exposure (task 557dc8ce): there
  // is no API to set it directly.
  device: string | null;
}

// Backend-reported effort option for a model. `level` is the backend-specific
// effort enum value (Codex: ReasoningEffort string; Claude: EffortLevel string).
export interface BackendEffortOptionWire {
  level: string;
  description?: string;
}

// Backend-reported model entry. `id` is what gets sent back as `modelFamily`
// on spawn/edit. `supportedEfforts` re-renders the effort picker per model.
export interface BackendModelWire {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedEfforts: BackendEffortOptionWire[];
  defaultEffort?: string;
}

// Update-available status feeding the header banner (server/update-checker.ts).
// Mode is decided by the box shape: "commit" on source checkouts (what HEAD
// runs vs. the repo's latest release and the GitHub main tip - the notice
// gives full context across both dimensions so pulling is an informed choice),
// "release" on updater-managed boxes with an /etc/isomux/update.conf (running
// release vs. the repo's latest GitHub release - the banner means "a new
// release exists", applied via the owner-only update trigger). See
// internal-docs/release-design.md. Commit-mode copy is composed from this
// shape in shared/update-notice.ts.
export type UpdateStatusWire =
  | {
      mode: "commit";
      // False = quiet: fully current, ahead of main (local-only commits), or
      // diverged. Ahead-of-main quiet is absolute, even with a newer release
      // out.
      updateAvailable: boolean;
      // What this box runs: the exact CalVer tag when HEAD is at one, else
      // null with the full HEAD sha as the display identity.
      current: { release: string | null; sha: string };
      // The repo's latest GitHub release; null when none exist yet.
      latest: { tag: string; url: string | null } | null;
      // This box vs. `latest`: "current" (on it), "behind" (latest is newer),
      // "ahead" (past it), "unknown" (no CalVer release reachable from HEAD).
      // Meaningless while `latest` is null.
      releaseStanding: "current" | "behind" | "ahead" | "unknown";
      // Commits the GitHub main tip has beyond this box's reference point:
      // the newest of {HEAD's tag, latest release} when HEAD is tagged, else
      // HEAD itself. 0 while quiet.
      mainAhead: number;
    }
  | {
      mode: "release";
      updateAvailable: boolean;
      // What this box runs: the exact release tag when pinned to one, else
      // null with `version` (git describe) as the display fallback.
      current: { release: string | null; version: string | null };
      // The repo's latest release; null when none exist yet (pre-first-release
      // boxes stay quiet).
      latest: {
        tag: string;
        publishedAt: string | null;
        url: string | null;
      } | null;
      // Newest marked security release after the running tag. This remains set
      // when a later ordinary release is newest, because that release contains
      // the fix too. Null means the complete release scan found none.
      securityUpdate: {
        tag: string;
        publishedAt: string | null;
        url: string | null;
      } | null;
    };

// Server → Browser messages
export type ServerMessage =
  | {
      type: "full_state";
      agents: AgentInfo[];
      recentCwds: string[];
      office: OfficeWire;
      rooms: RoomWire[];
      // ACL-filtered list of currently-killed agents for the spawn menu's
      // revive chips. Sorted killedAt desc, capped server-side. Empty array
      // for sessions with no killed agents in visible rooms.
      killedAgents: KilledAgentSummary[];
    }
  | { type: "agent_added"; agent: AgentInfo }
  // Carries the agent's pre-removal roomId; delivery is scoped to sessions
  // that can see that room (same posture as the killed_agent_* pair below),
  // so a session outside the room never learns the id existed.
  | { type: "agent_removed"; agentId: string; roomId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  // Killed-agent chip lifecycle. ACL-filtered server-side: both variants
  // are delivered only to sessions whose visible rooms include the
  // agent's `lastRoomId` (the room it was killed in, captured in the
  // history snapshot). Carrying `lastRoomId` on the removed variant
  // closes a tiny information-leak: an unfiltered removed-event would
  // tell a session a hidden killed-agent id became alive again, even
  // though that session never saw the corresponding added event.
  | { type: "killed_agent_added"; agent: KilledAgentSummary }
  | { type: "killed_agent_removed"; agentId: string; lastRoomId: string }
  | { type: "log_entry"; entry: LogEntry }
  // End of the transcript replay that follows full_state on every (re)connect.
  // Without it the replay is an unterminated burst of log_entry frames, and a
  // client that wants to swap the whole transcript in at once has to guess when
  // the burst ended - a guess that shows either a blank conversation or a stale
  // one. Sent per socket, right after the last replayed frame, by both replay
  // sites (the WS open handler and the mid-session projected refresh). Carries
  // no payload: the frames themselves are the content, this is only the fence
  // at the end. A client that never receives it (old server, dropped frame)
  // must still converge on its own.
  | { type: "log_replay_complete" }
  // Slide Mode: a slide finished generating (or regenerating) for one turn.
  // Room-ACL scoped like log_entry - anyone who can see the chat gets it. The
  // client matches it into the open deck by agentId + entryId; sessionId is the
  // conversation the slide belongs to (informational for a future multi-
  // conversation browser).
  | {
      type: "slide_ready";
      agentId: string;
      sessionId: string;
      entryId: string;
      slide: SlideRecord;
    }
  // Slide Mode: a slide generation FAILED terminally for one turn. The client's
  // only authoritative "stop waiting" signal: without it a failure is
  // indistinguishable from a slow generation, and the deck can only guess with a
  // timeout. Same room-ACL scope and matching (agentId + entryId) as
  // slide_ready.
  | {
      type: "slide_failed";
      agentId: string;
      sessionId: string;
      entryId: string;
      reason: SlideFailureReason;
    }
  | {
      type: "slash_commands";
      agentId: string;
      commands: {
        name: string;
        description?: string;
        aliasFor?: string;
        // No-arg commands EXECUTE on click in the "Sk" popover instead of
        // copying `/name ` into the composer (see SkillsPopover).
        autoRun?: boolean;
      }[];
      skills: SkillInfo[];
    }
  // rollback: this clear restores a prior timeline (failed edit-fork rollback),
  // not a conversation boundary - clients keep the unread dot.
  | { type: "clear_logs"; agentId: string; rollback?: boolean }
  | { type: "terminal_output"; agentId: string; data: string }
  | { type: "terminal_exit"; agentId: string; exitCode: number }
  | {
      type: "editor_external_change";
      agentId: string;
      path: string;
      mtime: number;
      rev: number;
    }
  // The watched file was confirmed deleted on disk (distinct from a content
  // change: there is nothing to reload). Same recipient scoping as
  // editor_external_change.
  | { type: "editor_file_deleted"; agentId: string; path: string }
  | {
      type: "office_settings_updated";
      prompt: string | null;
      name: string | null;
    }
  // Whole-board hydration: sent on connect and when a recipient's room ACCESS
  // changes (both re-project from scratch). A single task mutation does NOT ride
  // this - it arrives as one of the two deltas below, which is ~1KB instead of
  // the whole board (task b13445e2).
  | { type: "tasks"; tasks: TaskItem[] }
  // One task was created or changed, and the recipient can see it. Upsert, not
  // separate created/updated: per recipient an update can be the FIRST time the
  // task is visible (they just gained access to its room), so the client
  // replaces-or-appends by id.
  | { type: "task_upserted"; task: TaskItem }
  // Drop this task from the board. Either it was deleted, or it was re-filed
  // into a room this recipient cannot access - from their seat both are "gone".
  | { type: "task_deleted"; taskId: string }
  // Apps, per-recipient projected for the same reason task deltas are: owners
  // receive management rows and creator-room viewers receive launch-only rows.
  // A dependency change can add or remove a row without changing the app. No
  // whole-list event to match `tasks` - the Apps tab fetches GET /api/apps when
  // it opens, because reading app state costs a systemd call and almost nobody
  // opens the tab.
  | { type: "app_upserted"; app: AppListWire }
  // The app is gone from this recipient's list. Only its name travels: an app
  // this recipient could not see never produced a frame in the first place.
  | { type: "app_deleted"; name: string }
  | { type: "room_created"; room: RoomWire }
  | { type: "room_closed"; roomId: string }
  | { type: "room_renamed"; roomId: string; name: string }
  | { type: "room_settings_updated"; roomId: string; prompt: string | null }
  | { type: "users_list"; users: UserPublicWire[] }
  | { type: "user_updated"; user: UserPublicWire; prevName?: string }
  // Owners-audience FULL records (UserAdminWire === UserRecord). SEPARATE event
  // ids so the all-audience users_list/user_updated above stay public-only - no
  // recipient-dependent payload behind one id (Phase 3b slice 5).
  | { type: "users_admin_list"; users: UserRecord[] }
  | { type: "user_admin_updated"; user: UserRecord; prevName?: string }
  // Recipient-scoped to the subject: their OWN full record (UserSelfWire ===
  // UserRecord), incl. at connect hydration since users_list is now public-only.
  | { type: "user_self_updated"; user: UserRecord; prevName?: string }
  | { type: "session_context"; context: SessionContext }
  // totalOnlineUsers counts distinct userIds across ALL live presence
  // entries (including off-scene viewMode="away" sessions whose
  // entries are otherwise filtered from `entries` for the in-scene
  // ghost wire). Same value for every recipient - it answers "who is
  // online anywhere in the office", not "who is in rooms I can see".
  // onlineUserIds is the id set behind that count (same all-audience
  // aggregate, same cadence); the Users page reads it for the per-user
  // online dot, which `entries` can't answer (room-filtered, off-scene
  // sessions omitted).
  | {
      type: "presence_list";
      entries: PresenceInfo[];
      totalOnlineUsers: number;
      onlineUserIds: string[];
    }
  // Owner-only: unfiltered global rooms list. Owners with an explicit
  // allowedRooms list still see only their subset in the main UI, but
  // need every room here to manage other users' room access. Members
  // never receive this message.
  | { type: "all_rooms_list"; rooms: RoomWire[] }
  | { type: "invites_list"; invites: InviteWire[] }
  | { type: "sessions_active_list"; sessions: SessionWire[] }
  | { type: "session_revoked"; sessionPrefix: string }
  | { type: "invite_revoked"; tokenPrefix: string }
  | { type: "session_expired" }
  | ({ type: "update_status" } & UpdateStatusWire)
  | {
      type: "cronjobs_state";
      cronjobs: Cronjob[];
      cronjobsPrompt: string | null;
    }
  | { type: "cronjob_added"; cronjob: Cronjob }
  | { type: "cronjob_updated"; cronjob: Cronjob }
  | { type: "cronjob_deleted"; id: string }
  | { type: "cronjobs_prompt_updated"; value: string | null }
  | { type: "cronjob_run_updated"; run: CronjobRun }
  | { type: "pong" };

// Browser → Server commands
export type ClientCommand =
  | { type: "terminal_open"; agentId: string }
  | { type: "terminal_input"; agentId: string; data: string }
  | { type: "terminal_resize"; agentId: string; cols: number; rows: number }
  | { type: "terminal_close"; agentId: string }
  | {
      // Live-avatars feature: client tells the server where its ghost
      // should appear. Sent on initial WS open (after session_context
      // arrives), on focus change, on room change, and on view-mode
      // transitions (TaskView/Cronjobs/Settings open or close).
      // The server sanitizes currentRoomId against the sender's room access -
      // a stale or inaccessible id (e.g. from a race with an access revoke) is
      // clamped to null rather than rejected.
      type: "presence_update";
      // Global stable room id where the sender's ghost should appear, or null
      // when off-scene. Phase 3c slice 4: this replaced the dense visible
      // `currentRoom` index and is now required on the wire; the server
      // validates it directly (live room + canAccess), failing closed to null.
      currentRoomId: string | null;
      focusedAgentId: string | null;
      viewMode: "office" | "log" | "away";
      // Client-supplied device label (from localStorage isomux-device).
      // Optional on the wire so a tab that hasn't named its device
      // sends an undefined / empty payload; server stores null.
      device?: string | null;
    }
  | { type: "ping" };

// Generate a stable 8-char hex room ID (used at room creation and during migration)
export function generateRoomId(existing?: string[]): string {
  return generateHexId(existing);
}
