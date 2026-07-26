import type {
  Attachment,
  AgentInfo,
  AgentState,
  LogEntry,
  OfficeSettings,
  QueuedMessage,
  RoomWire,
  SkillInfo,
  SkillOrigin,
} from "../shared/types.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import {
  MODEL_FAMILIES,
  effortLevelsFor,
  familyDisplayLabel,
  effortDisplayLabel,
} from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";
import { errMessage } from "../shared/errors.ts";
import { listAgentSessions } from "./persistence.ts";
import { tildifyCwd } from "./cwd-utils.ts";
import {
  commands,
  unsupportedMessage,
  type CommandConfig,
} from "./commands.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { memoryStore } from "./memory-store.ts";
import { getUserByName } from "./users.ts";
import { listCronjobs, buildCronjobSystemPrompt } from "./cronjob-manager.ts";
import { resolveSkillPrompt } from "./skills.ts";
import { recordSkillUse } from "./skill-usage.ts";
import {
  ensureCodexWrapperScript,
  codexWrapperCommandForShell,
} from "./backends/codex/native-bin.ts";
import { renderUsageReport, usageAudienceForUser } from "./usage-report.ts";
import { computeIsomuxDiff, resolveDiffCwd } from "./isomux-diff.ts";
import {
  resolveEditorPath,
  openFile as openEditorFile,
} from "./file-editor.ts";
import {
  SessionSwappedError,
  inMultiStepFlow,
  type ManagedAgent,
  type AgentEvent,
  type EnqueueResult,
} from "./internal-types.ts";
import { runAgentTurn } from "./plugin-hooks.ts";
import { buildPublicOrigin } from "./auth.ts";

type HandlerFn = (
  agentId: string,
  managed: ManagedAgent,
  args: string[],
  rawText: string,
  username?: string,
  device?: string,
) => Promise<boolean>;

function buildMeta(
  username?: string,
  device?: string,
): Record<string, unknown> | undefined {
  if (!username && !device) return undefined;
  const meta: Record<string, unknown> = {};
  if (username) meta.username = username;
  if (device) meta.device = device;
  return meta;
}

// Collapse alias entries into their canonical for display. Each output
// group carries the full name list (canonical + aliases) and a shared
// description. Used by /help to render e.g. `/diff (or /isomux-diff)`
// instead of two separate lines for the same handler.
type AliasItem = { name: string; description?: string; aliasFor?: string };
type AliasGroup = { names: string[]; description?: string };
function groupByAlias(items: AliasItem[]): AliasGroup[] {
  const canonicalIndex = new Map<string, AliasGroup>();
  // First pass: canonical entries (no aliasFor). Preserves source order.
  for (const it of items) {
    if (it.aliasFor) continue;
    canonicalIndex.set(it.name, {
      names: [it.name],
      description: it.description,
    });
  }
  // Second pass: alias entries attach to their canonical group. An alias
  // pointing at an unknown canonical falls back to standing alone (defensive
  // — better than dropping the entry silently).
  for (const it of items) {
    if (!it.aliasFor) continue;
    const target = canonicalIndex.get(it.aliasFor);
    if (target) {
      target.names.push(it.name);
    } else {
      canonicalIndex.set(it.name, {
        names: [it.name],
        description: it.description,
      });
    }
  }
  return Array.from(canonicalIndex.values());
}

// Render one alias group as a single bullet line. Shortest name leads
// (friendlier shorthand reads first); the rest go in parens.
function formatAliasGroup(names: string[], description?: string): string {
  const sorted = [...names].sort((a, b) => a.length - b.length);
  const primary = `\`/${sorted[0]}\``;
  const others = sorted.slice(1).map((n) => `\`/${n}\``);
  const head =
    others.length > 0 ? `${primary} (or ${others.join(", ")})` : primary;
  return description ? `  ${head} — ${description}` : `  ${head}`;
}

interface HandlerDeps {
  // State accessors (live references — read at call time)
  agents: Map<string, ManagedAgent>;
  getRooms: () => RoomWire[];
  // Phase 3c: roomId is the room authority; the global room index / room object
  // are derived from it via these helpers (AgentInfo no longer carries a dense
  // room index).
  globalRoomIndexOf: (roomId: string) => number;
  roomById: (roomId: string) => RoomWire | undefined;
  getOfficeConfig: () => OfficeSettings;
  logCache: Map<string, LogEntry[]>;

  // Logging / events
  emit: (event: AgentEvent) => void;
  addLogEntry: (
    agentId: string,
    kind: LogEntry["kind"],
    content: string,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
    extra?: Partial<Pick<LogEntry, "diff" | "file" | "terminal">>,
  ) => void;
  emitEphemeralLog: (
    agentId: string,
    kind: LogEntry["kind"],
    content: string,
    metadata?: Record<string, unknown>,
    extra?: Partial<Pick<LogEntry, "diff" | "file">>,
  ) => void;
  updateState: (agentId: string, state: AgentState) => void;
  updateAgent: (agentId: string, changes: Partial<AgentInfo>) => OfficeEvent[];
  beginTurn: (agentId: string, opts: { humanInput: boolean }) => void;

  // Login-instructions helper. Wraps agentLoginInstructions + per-backend
  // dispatch in agent-manager so the /login handler can render the same
  // explanatory text + [Copy to terminal] cards an auth-error path would.
  emitLoginInstructionsFor: (agentId: string, managed: ManagedAgent) => void;

  // Session ops
  createSession: (
    managed: ManagedAgent,
    resumeSessionId?: string,
  ) => NonNullable<ManagedAgent["session"]>;
  replaceSession: (
    agentId: string,
    managed: ManagedAgent,
    newSession: NonNullable<ManagedAgent["session"]>,
  ) => Promise<void>;
  persistAll: () => void;
  persistCurrentSessionTopic: (agentId: string, managed: ManagedAgent) => void;
  // Wake a DORMANT agent so a skill's turn has a live session to send on (lazy
  // restore). Returns true if a session is ready; false if starting one failed
  // (an error was already logged and the agent moved to "error"), in which case
  // the caller must stop. Caller must gate on `managed.info.dormant` — a
  // genuinely-broken (non-dormant) session is left to surface its own error.
  wakeDormantSession: (
    agentId: string,
    managed: ManagedAgent,
    rawText: string,
    username?: string,
    device?: string,
  ) => boolean;
  createTurnDeferred: (managed: ManagedAgent) => Promise<void>;
  // Context-fullness reset (see resetContextUsage in agent-manager): the typed
  // /clear (also /reset, /new) is a semantic conversation boundary, so it must
  // clear the fullness snapshot + fired context-notice thresholds and
  // broadcast the explicit-null pill clear, like every other boundary
  // (newConversation, resume-to-different-session, edit-fork).
  resetContextUsage: (managed: ManagedAgent) => void;
  // Defer-to-queue path for slash commands that arrive while the agent is busy.
  enqueueMessage: (
    agentId: string,
    msg: {
      sender: QueuedMessage["sender"];
      text: string;
      sdkText?: string;
      attachments?: Attachment[];
      clientMessageId?: string;
    },
  ) => EnqueueResult;
}

export function createCommandHandling(deps: HandlerDeps) {
  const commandHandlers: Record<string, HandlerFn> = {
    async clear(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      // Build the new session BEFORE destroying pending control state and
      // the message queue. If createSession throws (bad cwd, broken env,
      // etc.) the user sees a visible error and the prior pending/queue
      // state stays intact — they can retry or pick another recovery path.
      // Once createSession returns, the swap commits: pending/queue clear,
      // topic persists, replaceSession installs. Queue must clear BEFORE
      // replaceSession or the post-swap idle trigger flushes prior-context
      // messages into the fresh session.
      try {
        const newSession = deps.createSession(managed);
        managed.pendingResume = false;
        managed.pendingResumeSessions = [];
        managed.pendingModelPick = false;
        managed.pendingEffortPick = false;
        if (managed.messageQueue.length > 0) {
          managed.messageQueue.length = 0;
          deps.emit({ type: "agent_updated", agentId, changes: { queue: [] } });
        }
        deps.persistCurrentSessionTopic(agentId, managed);
        await deps.replaceSession(agentId, managed, newSession);
      } catch (err) {
        deps.emitEphemeralLog(
          agentId,
          "error",
          `Failed to clear conversation: ${errMessage(err)}`,
        );
        deps.updateState(agentId, "error");
        return true;
      }
      managed.sessionId = null;
      // Conversation boundary: reset context-fullness state and broadcast the
      // pill clear. Runs AFTER the swap resolves (unlike newConversation's
      // pre-await reset) — safe here because replaceSession already installed
      // the new session, so every old-session in-flight sample is orphaned by
      // the session-identity check regardless of gen. Missing this reset left
      // the pill showing the PREVIOUS conversation's reading after a typed
      // /clear, and carried its fired thresholds into the fresh conversation
      // (fixed 2026-07-18; the API /clear path resets via newConversation).
      deps.resetContextUsage(managed);
      managed.topicGenerating = false;
      managed.topicMessageCount = 0;
      managed.topicGenToken++;
      deps.logCache.set(agentId, []);
      deps.emit({ type: "clear_logs", agentId });
      for (const event of deps.updateAgent(agentId, {
        topic: null,
        topicStale: false,
      }))
        deps.emit(event);
      deps.emitEphemeralLog(agentId, "system", "Conversation cleared.");
      deps.updateState(agentId, "idle");
      deps.persistAll();
      return true;
    },

    async context(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      // Shared header for both the live reading and the snapshot fallback.
      const headerLines = (u: {
        model: string;
        totalTokens: number;
        maxTokens: number;
        percentage: number;
      }): string[] => {
        const pct = Math.round(u.percentage);
        const barLen = 30;
        // Clamped into [0, barLen]: a reading outside 0-100% (a backend
        // reporting a stale window, task c6085ddf) otherwise hands
        // String.repeat a negative count and throws, taking /context down
        // entirely. The percentage itself stays unclamped -- it sits next to
        // the raw token counts, so capping it at 100% would contradict them.
        const filled = Math.max(
          0,
          Math.min(barLen, Math.round((barLen * u.percentage) / 100)),
        );
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        return [
          `**${u.model}** — ${u.totalTokens.toLocaleString()} / ${u.maxTokens.toLocaleString()} tokens (${pct}%)`,
          `\`${bar}\``,
        ];
      };
      // No live session (released while idle, or never started), or the live
      // read fails: fall back to the last committed snapshot — the same
      // reading the battery pill shows (task 714d80da). Reading the snapshot
      // does NOT wake a dormant session.
      const snapshotFallback = (note?: (age: string) => string): boolean => {
        const snap = managed.contextUsage;
        if (!snap) return false;
        const lines = [...headerLines(snap)];
        if (note) {
          const ageMs = Date.now() - snap.sampledAtMs;
          const ageMin = Math.round(ageMs / 60_000);
          const age =
            ageMin < 1
              ? "less than a minute ago"
              : ageMin < 60
                ? `${ageMin}m ago`
                : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
          lines.push("", note(age));
        }
        deps.addLogEntry(agentId, "system", lines.join("\n"));
        return true;
      };
      if (!managed.session) {
        // Released-while-idle renders IDENTICALLY to the live case (no
        // lifecycle note — remaining context doesn't change when the session
        // process is released; Nil's call, task 714d80da).
        if (snapshotFallback()) return true;
        deps.addLogEntry(agentId, "system", "No active session.");
        return true;
      }
      try {
        const ctx = await managed.session.getContextUsage();
        if (!ctx) {
          if (
            snapshotFallback(
              (age) =>
                `Live measurement unavailable. Showing the last committed reading, sampled ${age}.`,
            )
          )
            return true;
          deps.addLogEntry(
            agentId,
            "system",
            "Context usage not available for this session.",
          );
          return true;
        }
        const lines: string[] = [...headerLines(ctx)];

        if ((ctx.categories?.length ?? 0) > 0 && ctx.categories) {
          lines.push("");
          for (const cat of ctx.categories) {
            if (cat.tokens > 0) {
              const catPct = ((cat.tokens / ctx.maxTokens) * 100).toFixed(1);
              lines.push(
                `  ${cat.name}: ${cat.tokens.toLocaleString()} tokens (${catPct}%)`,
              );
            }
          }
        }

        if ((ctx.memoryFiles?.length ?? 0) > 0 && ctx.memoryFiles) {
          lines.push("\n**Memory files:**");
          for (const f of ctx.memoryFiles) {
            lines.push(`  ${f.path} (${f.tokens.toLocaleString()} tokens)`);
          }
        }

        if (
          (ctx.systemPromptSections?.length ?? 0) > 0 &&
          ctx.systemPromptSections
        ) {
          lines.push("\n**System prompt:**");
          for (const s of ctx.systemPromptSections) {
            lines.push(`  ${s.name}: ${s.tokens.toLocaleString()} tokens`);
          }
        }

        if (ctx.isAutoCompactEnabled && ctx.autoCompactThreshold) {
          const compactPct = Math.round(
            (ctx.autoCompactThreshold / ctx.maxTokens) * 100,
          );
          lines.push(
            `\nAuto-compact at ${compactPct}% (${ctx.autoCompactThreshold.toLocaleString()} tokens)`,
          );
        }

        deps.addLogEntry(agentId, "system", lines.join("\n"));
      } catch (err) {
        if (
          snapshotFallback(
            (age) =>
              `Live measurement failed. Showing the last committed reading, sampled ${age}.`,
          )
        )
          return true;
        deps.addLogEntry(
          agentId,
          "system",
          `Failed to get context usage: ${errMessage(err)}`,
        );
      }
      return true;
    },

    async help(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const lines: string[] = [];

      lines.push("**Docs:** https://isomux.com/docs");

      // Tips — surfaced first so a new user reading top-down hits the
      // actionable stuff before the command/skill inventory.
      lines.push("\n**Tips:**");
      lines.push(
        "  • Agents can check on each other and message each other. Just ask naturally or use skills like `/second-opinion`, `/pair-programming`, etc.",
      );
      lines.push(
        '  • Type ahead while an agent is busy: messages queue and flush when it\'s idle. Hit "Send now" or send with Ctrl/Cmd+Enter to interrupt and flush immediately.',
      );
      lines.push(
        "  • Use voice-to-text for faster prompting. The shortcut is ctrl+space.",
      );
      // Reachability tips depend on whether this boot has a real public
      // origin (env/config, non-loopback bind). Without one, the office is
      // VPN/tunnel territory; with one, the phone tip is just the URL and
      // the Funnel preamble to the invite tip is moot.
      const publicOrigin = buildPublicOrigin();
      if (publicOrigin.source === "localhost") {
        lines.push(
          "  • Isomux works on your phone. The easiest way is to connect it to the same VPN (e.g., Tailscale - free) as the machine running it.",
        );
        lines.push(
          "  • Once the office is reachable from outside your VPN (e.g. via Tailscale Funnel — see https://isomux.com/docs/access-and-invites), the owner can open User Settings → Access and mint one-time invite URLs. Recipients click and are signed in — no accounts, no passwords.",
        );
      } else {
        lines.push(
          `  • Isomux works on your phone: open ${publicOrigin.origin}.`,
        );
        lines.push(
          "  • The owner can open User Settings → Access and mint one-time invite URLs. Recipients click and are signed in — no accounts, no passwords.",
        );
      }
      lines.push(
        "  • The built-in side-panel terminal is useful for one-off situations where you need to run something manually, like auth flows.",
      );
      lines.push(
        "  • Isomux ships safety pre-tool-call hooks for Claude agents to prevent destructive commands. Codex agents don't have equivalent hooks.",
      );

      // Commands — collapse aliased entries (e.g. `/diff` aliasFor
      // `/isomux-diff`) into a single line so the user doesn't see two
      // lines for the same handler. Display order: shortest name first,
      // others in parens (per boss preference — friendlier-looking
      // shorthand reads first).
      const cmdGroups = groupByAlias(
        managed.slashCommands.map((c) => ({
          name: c.name,
          description: c.description,
          aliasFor: c.aliasFor,
        })),
      );
      const cmdList = cmdGroups
        .map((g) => formatAliasGroup(g.names, g.description))
        .join("\n");
      lines.push(`\n**Commands:**\n${cmdList}`);

      // Skills grouped by origin
      const originLabel: Record<SkillOrigin, string> = {
        user: "User skills",
        project: "Project skills",
        plugin: "Plugin skills",
        isomux: "Isomux skills",
        claude: "Claude skills",
      };
      const originOrder: SkillOrigin[] = [
        "isomux",
        "user",
        "project",
        "plugin",
        "claude",
      ];
      const groupedByOrigin = new Map<SkillOrigin, SkillInfo[]>();
      for (const s of managed.skills) {
        if (!groupedByOrigin.has(s.origin)) groupedByOrigin.set(s.origin, []);
        groupedByOrigin.get(s.origin)!.push(s);
      }
      for (const origin of originOrder) {
        const skills = groupedByOrigin.get(origin);
        if (!skills || skills.length === 0) continue;
        const skillGroups = groupByAlias(
          skills.map((s) => ({
            name: s.name,
            description: s.description,
            aliasFor: s.aliasFor,
          })),
        );
        const skillLines = skillGroups
          .map((g) => formatAliasGroup(g.names, g.description))
          .join("\n");
        lines.push(`\n**${originLabel[origin]}:**\n${skillLines}`);
      }

      deps.addLogEntry(agentId, "system", lines.join("\n"));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async resume(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const sessions = listAgentSessions(agentId);
      if (sessions.length === 0) {
        deps.emitEphemeralLog(agentId, "system", "No previous sessions found.");
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const lines: string[] = ["Resume a past conversation:\n"];
      let num = 1;
      const pickable: typeof sessions = [];
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.lastModified);
        const dateStr = date.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const rawLabel = s.topic || s.sessionId.slice(0, 8) + "...";
        const label = s.forked ? `↳ ${rawLabel}` : rawLabel;
        const suffix = s.branched ? "  (branched)" : "";
        // cwd is a property of the session — surface it so the user sees which
        // directory each session will resume into (it can differ per session).
        // Abbreviate the home prefix to `~` to save horizontal space.
        const cwdStr = s.cwd ? `  ${tildifyCwd(s.cwd)}` : "";
        // Engine each session ran under — the list mixes Claude and Codex, and
        // picking one resumes into that engine.
        const engineStr = s.agentType
          ? `  · ${s.agentType === "codex" ? "Codex" : "Claude"}`
          : "";
        if (s.sessionId === managed.sessionId) {
          lines.push(
            `  ● ${label}  ${dateStr}${cwdStr}${engineStr}  (current)`,
          );
        } else {
          lines.push(
            `  ${num}. ${label}  ${dateStr}${cwdStr}${engineStr}${suffix}`,
          );
          pickable.push(s);
          num++;
        }
      }
      if (pickable.length === 0) {
        deps.emitEphemeralLog(
          agentId,
          "system",
          "No other sessions to resume.",
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      lines.push(
        "\nReply with a number to resume, or anything else to cancel.",
      );
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingResume = true;
      managed.pendingResumeSessions = pickable;
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async model(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const currentLabel = familyDisplayLabel(managed.info.modelFamily);
      const lines: string[] = [
        `Switch model (current: **${currentLabel}**):\n`,
      ];
      for (let i = 0; i < MODEL_FAMILIES.length; i++) {
        const m = MODEL_FAMILIES[i];
        const marker =
          m.family === managed.info.modelFamily ? " (current)" : "";
        lines.push(`  ${i + 1}. ${familyDisplayLabel(m.family)}${marker}`);
      }
      lines.push(
        "\nReply with a number to switch, or anything else to cancel.",
      );
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingModelPick = true;
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async effort(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const currentLabel = effortDisplayLabel(managed.info.effort);
      const lines: string[] = [
        `Switch thinking effort (current: **${currentLabel}**):\n`,
      ];
      // Backend/model-filtered list. Must stay in lockstep with the numeric
      // pick handler in agent-manager.ts (pendingEffortPick), which indexes
      // into the same effortLevelsFor() result.
      const levels = effortLevelsFor(
        managed.info.agentType,
        managed.info.modelFamily,
      );
      for (let i = 0; i < levels.length; i++) {
        const e = levels[i];
        const marker = e.level === managed.info.effort ? " (current)" : "";
        lines.push(`  ${i + 1}. ${effortDisplayLabel(e.level)}${marker}`);
      }
      lines.push(
        "\nReply with a number to switch, or anything else to cancel.",
      );
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingEffortPick = true;
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxAllHands(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      // Gather all agents grouped by room. Phase 3c: group/sort/label by the
      // roomId-derived global room index (AgentInfo no longer carries a dense
      // room field).
      const allAgents = [...deps.agents.values()];
      const roomMap = new Map<number, ManagedAgent[]>();
      for (const a of allAgents) {
        const roomIdx = deps.globalRoomIndexOf(a.info.roomId);
        if (!roomMap.has(roomIdx)) roomMap.set(roomIdx, []);
        roomMap.get(roomIdx)!.push(a);
      }

      const lines: string[] = [];
      const sortedRooms = [...roomMap.keys()].sort((a, b) => a - b);

      for (const room of sortedRooms) {
        const roomAgents = roomMap
          .get(room)!
          .sort((a, b) => a.info.desk - b.info.desk);
        lines.push(`**=== Room ${room + 1} ===**`);
        lines.push("");

        for (const a of roomAgents) {
          const selfTag = a.info.id === agentId ? "  **(me)**" : "";
          const modelLabel = familyDisplayLabel(a.info.modelFamily);
          const topic = a.info.topic;
          const hasTopic = topic && topic !== "...";
          const header = `**${a.info.name}** (desk ${a.info.desk + 1})${selfTag} — ${modelLabel} — \`${a.info.cwd}\``;
          if (hasTopic) {
            lines.push(header);
            lines.push(`  Topic: ${topic}`);
          } else {
            lines.push(`<span style="color: var(--text-dim)">${header}</span>`);
          }
          lines.push("");
        }
      }

      lines.push(
        "Ask your agent if you'd like to know more about any agent or conversation.",
      );

      deps.addLogEntry(agentId, "system", lines.join("\n"));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxSystemPrompt(
      agentId,
      managed,
      _args,
      rawText,
      username,
      device,
    ) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      // Phase 3c: a live agent's roomId always resolves; roomById logs loud on a
      // miss and we fail fast rather than build a prompt against room 0.
      const room = deps.roomById(managed.info.roomId)!;
      const officeConfig = deps.getOfficeConfig();
      const ownerRecord = managed.info.username
        ? getUserByName(managed.info.username)
        : undefined;
      const prompt = buildSystemPrompt(
        managed.info.name,
        managed.info.id,
        room.name,
        officeConfig.prompt,
        room.prompt,
        managed.info.customInstructions,
        managed.info.username,
        ownerRecord?.memberPrompt ?? null,
        managed.info.privileged ?? false,
        memoryStore.renderForPromptMulti([
          { scope: "office", scopeId: null, label: "Office-wide" },
          {
            scope: "room",
            scopeId: managed.info.roomId,
            label: `Room "${room.name}"`,
          },
          // Boss notes auto-load ONLY for this agent's manager boss (stable
          // userId), so one boss's notes never bleed into another's context.
          ...(managed.info.userId
            ? [
                {
                  scope: "boss" as const,
                  scopeId: managed.info.userId,
                  label: `Boss "${managed.info.username ?? "boss"}"`,
                },
              ]
            : []),
          { scope: "agent", scopeId: managed.info.id, label: "Your agent" },
        ]),
        managed.info.agentType,
      );
      // Pick a fence longer than any backtick run inside the prompt so the block
      // renders verbatim regardless of what office/room/agent prompts contain.
      const longestRun = (prompt.match(/`+/g) ?? []).reduce(
        (m, s) => Math.max(m, s.length),
        0,
      );
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header =
        "**Full system prompt** *(reflects current settings; takes effect on next conversation)*";
      deps.addLogEntry(
        agentId,
        "system",
        `${header}\n\n${fence}plaintext\n${prompt}\n${fence}`,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxCronjobSystemPrompt(
      agentId,
      _managed,
      args,
      rawText,
      username,
      device,
    ) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const query = args.join(" ").trim();
      const all = listCronjobs();

      if (!query) {
        const lines = ["Usage: `/isomux-cronjob-system-prompt <name-or-id>`"];
        if (all.length === 0) {
          lines.push("\nNo cron jobs are configured.");
        } else {
          lines.push("\nKnown cron jobs:");
          for (const c of all) lines.push(`  \`${c.id}\`  ${c.name}`);
        }
        deps.addLogEntry(agentId, "system", lines.join("\n"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const byId = all.find((c) => c.id === query);
      const byNameMatches = byId ? [] : all.filter((c) => c.name === query);
      const target =
        byId ?? (byNameMatches.length === 1 ? byNameMatches[0] : null);

      if (!target) {
        if (byNameMatches.length > 1) {
          const lines = [
            `Multiple cron jobs are named "${query}". Re-run with the id:`,
          ];
          for (const c of byNameMatches) lines.push(`  \`${c.id}\``);
          deps.addLogEntry(agentId, "system", lines.join("\n"));
        } else {
          deps.addLogEntry(
            agentId,
            "system",
            `No cron job matches \`${query}\`. Try \`/isomux-cronjob-system-prompt\` with no argument to list cron jobs.`,
          );
        }
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      // The cronjob receives the system prompt + the configured prompt as its
      // first user message, so display both — that's the full initial input.
      const systemPrompt = buildCronjobSystemPrompt(target);
      const combined = `${systemPrompt}\n\n----\nFirst user message:\n\n${target.prompt}`;
      const longestRun = (combined.match(/`+/g) ?? []).reduce(
        (m, s) => Math.max(m, s.length),
        0,
      );
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header = `**System prompt + first user message for cron job "${target.name}"** *(reflects current settings; takes effect on next run)*`;
      deps.addLogEntry(
        agentId,
        "system",
        `${header}\n\n${fence}plaintext\n${combined}\n${fence}`,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxEdit(agentId, managed, args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const rawPath = args[0];
      if (!rawPath) {
        deps.addLogEntry(
          agentId,
          "system",
          `Usage: \`/isomux-edit <path>\`. Path can be relative (resolves against ${managed.info.cwd}), absolute, or \`~/...\`.`,
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const resolved = resolveEditorPath(rawPath, managed.info.cwd);
      if (resolved.kind === "bad_path") {
        deps.addLogEntry(agentId, "system", `Empty path.`);
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const probe = openEditorFile(resolved.path);
      if (probe.kind === "not_found") {
        deps.addLogEntry(
          agentId,
          "system",
          `\`${resolved.path}\` does not exist.`,
        );
      } else if (probe.kind === "not_file") {
        deps.addLogEntry(
          agentId,
          "system",
          `\`${resolved.path}\` is not a file.`,
        );
      } else if (probe.kind === "binary") {
        deps.addLogEntry(
          agentId,
          "system",
          `\`${resolved.path}\` is a binary file — the editor panel only supports text.`,
        );
      } else if (probe.kind === "too_large") {
        deps.addLogEntry(
          agentId,
          "system",
          `\`${resolved.path}\` is ${(probe.size / 1024).toFixed(1)} KB — too large for the editor panel (1 MB limit).`,
        );
      } else if (probe.kind === "io_error") {
        deps.addLogEntry(
          agentId,
          "system",
          `Failed to open \`${resolved.path}\`: ${probe.message}`,
        );
      } else {
        deps.addLogEntry(
          agentId,
          "edit-request",
          resolved.path,
          undefined,
          undefined,
          {
            file: { cwd: managed.info.cwd, path: resolved.path },
          },
        );
      }
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxDiff(agentId, managed, args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const resolved = resolveDiffCwd(args[0], managed.info.cwd);
      if (resolved.kind === "bad_dir") {
        deps.addLogEntry(
          agentId,
          "system",
          `\`${resolved.attempted}\` is not a directory.`,
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const result = computeIsomuxDiff(resolved.cwd);
      switch (result.kind) {
        case "not_repo":
          deps.addLogEntry(
            agentId,
            "system",
            `\`${result.cwd}\` is not a git repository.`,
          );
          break;
        case "git_error":
          deps.addLogEntry(
            agentId,
            "system",
            `Failed to run git diff in \`${result.cwd}\`:\n\n\`\`\`\n${result.message}\n\`\`\``,
          );
          break;
        case "clean":
          deps.addLogEntry(
            agentId,
            "system",
            `Working tree clean in \`${result.cwd}\` — no uncommitted changes.`,
          );
          break;
        case "ok":
          deps.addLogEntry(
            agentId,
            "diff",
            result.summary,
            undefined,
            undefined,
            { diff: result.payload },
          );
          break;
      }
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async login(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      // Reuses the same backend-dispatched text + cards an auth-error
      // would surface — single source of truth for "how does this agent
      // authenticate." Codex emits the two-card pick (browser + device-auth)
      // and the auto-clear short text when already authed; Claude emits its
      // /login walkthrough with a `claude` terminal card.
      deps.emitLoginInstructionsFor(agentId, managed);
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async usage(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      const usageLines = [
        "**Subscription plan limits aren't shown here.**",
        "",
        "To check your Claude or ChatGPT subscription quota, open the embedded terminal and:",
        "",
        "- launch `claude`, then type `/usage`",
        "- launch `~/.isomux/bin/codex`, then type `/status`",
        "",
        "For office-level token spend (per-agent / per-room / per-cron-job), see `/isomux-usage`.",
      ];
      deps.addLogEntry(agentId, "system", usageLines.join("\n"));
      deps.addLogEntry(
        agentId,
        "terminal-command",
        "claude",
        undefined,
        undefined,
        { terminal: { command: "claude" } },
      );
      // Materialize the codex wrapper before emitting the card; otherwise a
      // user who hits /usage before any Codex auth-error path won't have
      // `~/.isomux/bin/codex` on disk and the card will fail with "command
      // not found". If materialization throws (e.g. @openai/codex missing),
      // skip the card entirely and surface a one-line system note — a dead
      // card is worse than no card.
      let codexWrapperReady = false;
      try {
        ensureCodexWrapperScript();
        codexWrapperReady = true;
      } catch (err) {
        deps.addLogEntry(
          agentId,
          "system",
          "Codex `/status` card omitted: " + errMessage(err),
        );
      }
      if (codexWrapperReady) {
        const codexCmd = codexWrapperCommandForShell();
        deps.addLogEntry(
          agentId,
          "terminal-command",
          codexCmd,
          undefined,
          undefined,
          { terminal: { command: codexCmd } },
        );
      }
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxUsage(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      deps.addLogEntry(
        agentId,
        "system",
        renderUsageReport(
          deps.agents,
          deps.getRooms(),
          // Spend is room-scoped: the report shows the caller only what their
          // room access already lets them see (owners: the whole office).
          usageAudienceForUser(getUserByName(username)),
        ),
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },
  };

  // Startup assertion: every supported command with a handler key must have a matching handler
  for (const [name, cfg] of Object.entries(commands)) {
    if (cfg.supported && cfg.handler && !commandHandlers[cfg.handler]) {
      throw new Error(
        `Command /${name} is marked supported with handler "${cfg.handler}" but no handler exists`,
      );
    }
  }

  // Execute a resolved skill prompt by sending it to the agent
  async function executeSkill(
    agentId: string,
    managed: ManagedAgent,
    skillPrompt: string,
    args: string[],
    rawText: string,
    username?: string,
    device?: string,
  ): Promise<boolean> {
    const userArgs = args.join(" ");
    const fullPrompt = userArgs
      ? `${skillPrompt}\n\nUser context: ${userArgs}`
      : skillPrompt;

    // If the agent is mid-turn, defer the skill via the queue instead of
    // calling session.send now. Otherwise createTurnDeferred below would
    // supersede the in-flight turn and reject it with "Superseded by a new
    // turn". sendMessage's own queueing gate (`!isSlash`) lets all slash
    // commands skip the queue — which is right for immediate handlers like
    // /clear or /isomux-diff, but wrong for skills that actually run the
    // model. Multi-step pending flows still take the immediate path: the
    // user's reply during /resume etc. is a pick, not a skill.
    const state = managed.info.state;
    const busy = state === "thinking" || state === "tool_executing";
    if (busy && !inMultiStepFlow(managed)) {
      const result = deps.enqueueMessage(agentId, {
        sender: { kind: "user", username, device },
        text: rawText,
        sdkText: fullPrompt,
      });
      if (!result.ok) {
        deps.addLogEntry(
          agentId,
          "system",
          `Could not queue ${rawText}: ${result.error}`,
        );
      }
      return true;
    }

    // A dormant agent (lazy-spawned, idle-evicted, or released by /clear) holds
    // no live session, so the runAgentTurn below would throw "agent has no
    // session". Wake it first — this is the skill-dispatch site, reached only
    // for an actual skill (control commands like /clear never get here), so the
    // no-auto-wake escape hatch on broken sessions stays intact. A genuinely-
    // broken (non-dormant) session is left to surface its own error.
    if (!managed.session && managed.info.dormant) {
      if (
        !deps.wakeDormantSession(agentId, managed, rawText, username, device)
      ) {
        return true; // wake failed; error already logged + state set to "error"
      }
    }

    // sdkText captures the expanded prompt the SDK actually receives so editMessage
    // can match this log entry against the SDK session (content alone is the slash
    // command and won't match).
    const userMeta: Record<string, unknown> = { sdkText: fullPrompt };
    if (username) userMeta.username = username;
    if (device) userMeta.device = device;
    deps.addLogEntry(agentId, "user_message", rawText, userMeta);
    const prefix = formatPrefix({ username, device });
    const prefixedSkillPrompt = prefix ? `${prefix}${fullPrompt}` : fullPrompt;
    try {
      await runAgentTurn({
        managed,
        visibleText: rawText,
        // For skills, the expanded skill prompt (with user args spliced in)
        // is the semantic user request — what the user effectively asked
        // the model to do. The raw `/grill` invocation is captured in
        // visibleText for display. Sender prefix is applied as sdkText.
        originalText: fullPrompt,
        sdkText: prefixedSkillPrompt,
        origin: "skill",
        humanInput: true,
      });
    } catch (err) {
      // runAgentTurn re-throws whatever the underlying turn threw and has
      // already cleaned up the pendingTurn deferred if session.send fell
      // before await turn. Per-site error semantics remain here.
      if (err instanceof SessionSwappedError) return true;
      deps.addLogEntry(agentId, "error", `Skill error: ${errMessage(err)}`);
      deps.updateState(agentId, "error");
    }
    return true;
  }

  // Slash command resolution — 5-step priority order (each step commented below;
  // the command/skill registry itself is server/commands.ts)
  async function handleSlashCommand(
    agentId: string,
    managed: ManagedAgent,
    cmd: string,
    args: string[],
    rawText: string,
    username?: string,
    device?: string,
  ): Promise<boolean> {
    const userMeta = buildMeta(username, device);
    const cfg: CommandConfig | undefined = commands[cmd];

    // Count the dispatched use under the invoking user — Sk-menu ranking
    // rides these counts (task f1769b1a). COMMANDS and skills both count (the
    // menu ranks across both), under the name as typed/picked; only actual
    // dispatches count (unknown/unsupported echoes don't), and senders with
    // no user record (agents/system) are skipped. Hidden command spellings
    // (autocomplete:false — /new, /reset) are skipped too: they can never
    // surface in the menu, so their counts would be dead data.
    const countUse = () => {
      if (!username) return;
      const user = getUserByName(username);
      if (user) recordSkillUse(user.id, cmd);
    };

    // Step 1: Config lookup (non-overridable)
    if (cfg && !cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        if (cfg.autocomplete) countUse();
        return commandHandlers[cfg.handler](
          agentId,
          managed,
          args,
          rawText,
          username,
          device,
        );
      }
      // Unsupported non-overridable command — show message
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    // Step 2: Skill override check (for overridable config entries OR unknown commands)
    const skillPrompt = resolveSkillPrompt(cmd, managed.info.cwd);
    if (skillPrompt) {
      countUse();
      return executeSkill(
        agentId,
        managed,
        skillPrompt,
        args,
        rawText,
        username,
        device,
      );
    }

    // Step 3: Config lookup (overridable, no skill found)
    if (cfg && cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        if (cfg.autocomplete) countUse();
        return commandHandlers[cfg.handler](
          agentId,
          managed,
          args,
          rawText,
          username,
          device,
        );
      }
      // Unsupported overridable command with no skill override
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    // Step 4: SDK-reported commands — pass through to the agent via session.send()
    if (managed.sdkReportedCommands.includes(cmd)) {
      return false; // let sendMessage() pass it through
    }

    // Step 5: Unknown command
    deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    deps.emitEphemeralLog(
      agentId,
      "system",
      `Unknown command \`/${cmd}\`. Type \`/help\` to see available commands.`,
    );
    return true;
  }

  return { commandHandlers, executeSkill, handleSlashCommand };
}
