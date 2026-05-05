import type { Attachment, AgentState, LogEntry, SkillInfo, SkillOrigin } from "../shared/types.ts";
import { MODEL_FAMILIES, FAMILY_TO_MODEL, EFFORT_LEVELS, familyDisplayLabel, effortDisplayLabel } from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";
import { listAgentSessions, type OfficeConfig } from "./persistence.ts";
import { commands, unsupportedMessage, type CommandConfig } from "./commands.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { listCronjobs, buildCronjobSystemPrompt } from "./cronjob-manager.ts";
import { resolveSkillPrompt } from "./skills.ts";
import { renderUsageReport, formatRelativeTime } from "./usage-report.ts";
import { computeIsomuxDiff, resolveDiffCwd } from "./isomux-diff.ts";
import { SessionSwappedError, type ManagedAgent, type InternalRoom, type AgentEvent } from "./internal-types.ts";

type HandlerFn = (agentId: string, managed: ManagedAgent, args: string[], rawText: string, username?: string, device?: string) => Promise<boolean>;

function buildMeta(username?: string, device?: string): Record<string, unknown> | undefined {
  if (!username && !device) return undefined;
  const meta: Record<string, unknown> = {};
  if (username) meta.username = username;
  if (device) meta.device = device;
  return meta;
}

interface HandlerDeps {
  // State accessors (live references — read at call time)
  agents: Map<string, ManagedAgent>;
  getRooms: () => InternalRoom[];
  getOfficeConfig: () => OfficeConfig;
  logCache: Map<string, LogEntry[]>;

  // Logging / events
  emit: (event: AgentEvent) => void;
  addLogEntry: (agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>, attachments?: Attachment[]) => void;
  emitEphemeralLog: (agentId: string, kind: LogEntry["kind"], content: string, metadata?: Record<string, unknown>, extra?: Partial<Pick<LogEntry, "diff">>) => void;
  updateState: (agentId: string, state: AgentState) => void;

  // Session ops
  createSession: (managed: ManagedAgent, resumeSessionId?: string) => NonNullable<ManagedAgent["session"]>;
  replaceSession: (agentId: string, managed: ManagedAgent, newSession: NonNullable<ManagedAgent["session"]>) => Promise<void>;
  persistAll: () => void;
  persistCurrentSessionTopic: (agentId: string, managed: ManagedAgent) => void;
  createTurnDeferred: (managed: ManagedAgent) => Promise<void>;
}

export function createCommandHandling(deps: HandlerDeps) {
  const commandHandlers: Record<string, HandlerFn> = {
    async clear(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      managed.pendingResume = false;
      managed.pendingResumeSessions = [];
      managed.pendingModelPick = false;
      managed.pendingEffortPick = false;
      deps.persistCurrentSessionTopic(agentId, managed);
      await deps.replaceSession(agentId, managed, deps.createSession(managed));
      managed.sessionId = null;
      managed.topicGenerating = false;
      managed.topicMessageCount = 0;
      managed.info.topic = null;
      managed.info.topicStale = false;
      deps.logCache.set(agentId, []);
      deps.emit({ type: "clear_logs", agentId });
      deps.emit({ type: "agent_updated", agentId, changes: { topic: null, topicStale: false } });
      deps.emitEphemeralLog(agentId, "system", "Conversation cleared.");
      deps.updateState(agentId, "idle");
      deps.persistAll();
      return true;
    },

    async context(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      if (!managed.session) {
        deps.emitEphemeralLog(agentId, "system", "No active session.");
        return true;
      }
      try {
        const query = (managed.session as any).query;
        if (!query?.getContextUsage) {
          deps.emitEphemeralLog(agentId, "system", "Context usage not available for this session.");
          return true;
        }
        const ctx = await query.getContextUsage();
        const lines: string[] = [];

        const pct = Math.round(ctx.percentage);
        const barLen = 30;
        const filled = Math.round(barLen * ctx.percentage / 100);
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        lines.push(`**${ctx.model}** — ${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens (${pct}%)`);
        lines.push(`\`${bar}\``);

        if (ctx.categories?.length > 0) {
          lines.push("");
          for (const cat of ctx.categories) {
            if (cat.tokens > 0) {
              const catPct = ((cat.tokens / ctx.maxTokens) * 100).toFixed(1);
              lines.push(`  ${cat.name}: ${cat.tokens.toLocaleString()} tokens (${catPct}%)`);
            }
          }
        }

        if (ctx.memoryFiles?.length > 0) {
          lines.push("\n**Memory files:**");
          for (const f of ctx.memoryFiles) {
            lines.push(`  ${f.path} (${f.tokens.toLocaleString()} tokens)`);
          }
        }

        if (ctx.systemPromptSections?.length > 0) {
          lines.push("\n**System prompt:**");
          for (const s of ctx.systemPromptSections) {
            lines.push(`  ${s.name}: ${s.tokens.toLocaleString()} tokens`);
          }
        }

        if (ctx.isAutoCompactEnabled && ctx.autoCompactThreshold) {
          const compactPct = Math.round((ctx.autoCompactThreshold / ctx.maxTokens) * 100);
          lines.push(`\nAuto-compact at ${compactPct}% (${ctx.autoCompactThreshold.toLocaleString()} tokens)`);
        }

        deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      } catch (err: any) {
        deps.emitEphemeralLog(agentId, "system", `Failed to get context usage: ${err.message}`);
      }
      return true;
    },

    async help(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const lines: string[] = [];

      // Agent metadata
      const topicLine = managed.info.topic ? `  Topic: ${managed.info.topic}` : "";
      lines.push(`**${managed.info.name}** — Room ${managed.info.room + 1}, Desk ${managed.info.desk + 1}`);
      lines.push(`  cwd: \`${managed.info.cwd}\``);
      if (topicLine) lines.push(topicLine);
      lines.push("");

      // Isomux description
      lines.push("Isomux is a multi-agent office manager for Claude Code. Learn more at https://isomux.com");
      lines.push("");

      // Commands
      const cmdList = managed.slashCommands.map((c) => c.description ? `  \`/${c.name}\`  — ${c.description}` : `  \`/${c.name}\``).join("\n");
      lines.push(`**Commands:**\n${cmdList}`);

      // Skills grouped by origin
      const originLabel: Record<SkillOrigin, string> = {
        user: "User skills",
        project: "Project skills",
        plugin: "Plugin skills",
        isomux: "Isomux skills",
        claude: "Claude skills",
      };
      const originOrder: SkillOrigin[] = ["isomux", "user", "project", "plugin", "claude"];
      const grouped = new Map<SkillOrigin, SkillInfo[]>();
      for (const s of managed.skills) {
        if (!grouped.has(s.origin)) grouped.set(s.origin, []);
        grouped.get(s.origin)!.push(s);
      }
      for (const origin of originOrder) {
        const skills = grouped.get(origin);
        if (!skills || skills.length === 0) continue;
        const skillLines = skills.map((s) => {
          const desc = s.description ? ` — ${s.description}` : "";
          return `  \`/${s.name}\`${desc}`;
        }).join("\n");
        lines.push(`\n**${originLabel[origin]}:**\n${skillLines}`);
      }

      // Tips
      lines.push("\n**Tips:**");
      lines.push("  • Isomux also works on your phone. The easiest way is to connect it to the same tailscale network as the machine running it (it's free).");
      lines.push("  • The built-in side-panel terminal is useful for one-off situations where you need to run something manually, like auth flows.");
      lines.push("  • Isomux comes with safety pre-tool-call hooks to prevent destructive commands, like `rm -rf /`.");
      lines.push("  • Isomux agents can check what other agents are up to in real time. Just ask naturally.");
      lines.push("  • Use voice-to-text for faster prompting. The shortcut is ctrl+space.");
      lines.push("  • Use `/isomux-all-hands` to check what every agent is up to.");
      lines.push("  • Use `/report-isomux-bug` if you find any issues.");
      lines.push("  • Use `/isomux-grill-me` to make your feature designs more robust.");

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
        const dateStr = date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const rawLabel = s.topic || s.sessionId.slice(0, 8) + "...";
        const label = s.forked ? `↳ ${rawLabel}` : rawLabel;
        const suffix = s.branched ? "  (branched)" : "";
        if (s.sessionId === managed.sessionId) {
          lines.push(`  ● ${label}  ${dateStr}  (current)`);
        } else {
          lines.push(`  ${num}. ${label}  ${dateStr}${suffix}`);
          pickable.push(s);
          num++;
        }
      }
      if (pickable.length === 0) {
        deps.emitEphemeralLog(agentId, "system", "No other sessions to resume.");
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      lines.push("\nReply with a number to resume, or anything else to cancel.");
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
      const lines: string[] = [`Switch model (current: **${currentLabel}**):\n`];
      for (let i = 0; i < MODEL_FAMILIES.length; i++) {
        const m = MODEL_FAMILIES[i];
        const marker = m.family === managed.info.modelFamily ? " (current)" : "";
        lines.push(`  ${i + 1}. ${familyDisplayLabel(m.family)}${marker}`);
      }
      lines.push("\nReply with a number to switch, or anything else to cancel.");
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingModelPick = true;
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async effort(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const currentLabel = effortDisplayLabel(managed.info.effort);
      const lines: string[] = [`Switch thinking effort (current: **${currentLabel}**):\n`];
      for (let i = 0; i < EFFORT_LEVELS.length; i++) {
        const e = EFFORT_LEVELS[i];
        const marker = e.level === managed.info.effort ? " (current)" : "";
        lines.push(`  ${i + 1}. ${effortDisplayLabel(e.level)}${marker}`);
      }
      lines.push("\nReply with a number to switch, or anything else to cancel.");
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
      managed.pendingEffortPick = true;
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxAllHands(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      // Gather all agents grouped by room
      const allAgents = [...deps.agents.values()];
      const roomMap = new Map<number, ManagedAgent[]>();
      for (const a of allAgents) {
        const room = a.info.room;
        if (!roomMap.has(room)) roomMap.set(room, []);
        roomMap.get(room)!.push(a);
      }

      const lines: string[] = [];
      const sortedRooms = [...roomMap.keys()].sort((a, b) => a - b);

      for (const room of sortedRooms) {
        const roomAgents = roomMap.get(room)!.sort((a, b) => a.info.desk - b.info.desk);
        lines.push(`**=== Room ${room + 1} ===**`);
        lines.push("");

        for (const a of roomAgents) {
          const selfTag = a.info.id === agentId ? "  **(me)**" : "";
          const modelLabel = familyDisplayLabel(a.info.modelFamily);
          lines.push(`**${a.info.name}** (desk ${a.info.desk + 1})${selfTag} — ${modelLabel} — \`${a.info.cwd}\``);

          const sessions = listAgentSessions(a.info.id);
          if (sessions.length === 0) {
            lines.push("  (no conversations)");
          } else {
            let num = 1;
            for (const s of sessions) {
              const label = s.topic || s.sessionId.slice(0, 8) + "...";
              const ago = formatRelativeTime(s.lastModified);
              lines.push(`  ${num}. ${label}  (${ago})`);
              num++;
            }
          }
          lines.push("");
        }
      }

      lines.push("Ask your agent if you'd like to know more about any agent or conversation.");

      deps.addLogEntry(agentId, "system", lines.join("\n"));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxSystemPrompt(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const room = deps.getRooms()[managed.info.room]!;
      const officeConfig = deps.getOfficeConfig();
      const prompt = buildSystemPrompt(
        managed.info.name,
        managed.info.id,
        room.name,
        officeConfig.prompt,
        room.prompt,
        managed.info.customInstructions,
      );
      // Pick a fence longer than any backtick run inside the prompt so the block
      // renders verbatim regardless of what office/room/agent prompts contain.
      const longestRun = (prompt.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header = "**Full system prompt** *(reflects current settings; takes effect on next conversation)*";
      deps.emitEphemeralLog(agentId, "system", `${header}\n\n${fence}plaintext\n${prompt}\n${fence}`);
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxCronjobSystemPrompt(agentId, _managed, args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);

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
        deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const byId = all.find((c) => c.id === query);
      const byNameMatches = byId ? [] : all.filter((c) => c.name === query);
      const target = byId ?? (byNameMatches.length === 1 ? byNameMatches[0] : null);

      if (!target) {
        if (byNameMatches.length > 1) {
          const lines = [`Multiple cron jobs are named "${query}". Re-run with the id:`];
          for (const c of byNameMatches) lines.push(`  \`${c.id}\``);
          deps.emitEphemeralLog(agentId, "system", lines.join("\n"));
        } else {
          deps.emitEphemeralLog(agentId, "system", `No cron job matches \`${query}\`. Try \`/isomux-cronjob-system-prompt\` with no argument to list cron jobs.`);
        }
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      // The cronjob receives the system prompt + the configured prompt as its
      // first user message, so display both — that's the full initial input.
      const systemPrompt = buildCronjobSystemPrompt(target);
      const combined = `${systemPrompt}\n\n----\nFirst user message:\n\n${target.prompt}`;
      const longestRun = (combined.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header = `**System prompt + first user message for cron job "${target.name}"** *(reflects current settings; takes effect on next run)*`;
      deps.emitEphemeralLog(agentId, "system", `${header}\n\n${fence}plaintext\n${combined}\n${fence}`);
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxDiff(agentId, managed, args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);

      const resolved = resolveDiffCwd(args[0], managed.info.cwd);
      if (resolved.kind === "bad_dir") {
        deps.emitEphemeralLog(agentId, "system", `\`${resolved.attempted}\` is not a directory.`);
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const result = computeIsomuxDiff(resolved.cwd);
      switch (result.kind) {
        case "not_repo":
          deps.emitEphemeralLog(agentId, "system", `\`${result.cwd}\` is not a git repository.`);
          break;
        case "git_error":
          deps.emitEphemeralLog(agentId, "system", `Failed to run git diff in \`${result.cwd}\`:\n\n\`\`\`\n${result.message}\n\`\`\``);
          break;
        case "clean":
          deps.emitEphemeralLog(agentId, "system", `Working tree clean in \`${result.cwd}\` — no uncommitted changes.`);
          break;
        case "ok":
          deps.emitEphemeralLog(agentId, "diff", result.summary, undefined, { diff: result.payload });
          break;
      }
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async usage(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", renderUsageReport(deps.agents, deps.getRooms()));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },
  };

  // Startup assertion: every supported command with a handler key must have a matching handler
  for (const [name, cfg] of Object.entries(commands)) {
    if (cfg.supported && cfg.handler && !commandHandlers[cfg.handler]) {
      throw new Error(`Command /${name} is marked supported with handler "${cfg.handler}" but no handler exists`);
    }
  }

  // Execute a resolved skill prompt by sending it to the agent
  async function executeSkill(agentId: string, managed: ManagedAgent, skillPrompt: string, args: string[], rawText: string, username?: string, device?: string): Promise<boolean> {
    const userArgs = args.join(" ");
    const fullPrompt = userArgs
      ? `${skillPrompt}\n\nUser context: ${userArgs}`
      : skillPrompt;
    // sdkText captures the expanded prompt the SDK actually receives so editMessage
    // can match this log entry against the SDK session (content alone is the slash
    // command and won't match).
    const userMeta: Record<string, unknown> = { sdkText: fullPrompt };
    if (username) userMeta.username = username;
    if (device) userMeta.device = device;
    deps.addLogEntry(agentId, "user_message", rawText, userMeta);
    deps.updateState(agentId, "thinking");
    const prefix = formatPrefix({ username, device });
    const prefixedSkillPrompt = prefix ? `${prefix}${fullPrompt}` : fullPrompt;
    try {
      const turn = deps.createTurnDeferred(managed);
      await managed.session!.send(prefixedSkillPrompt);
      await turn;
    } catch (err: any) {
      if (err instanceof SessionSwappedError) return true;
      deps.addLogEntry(agentId, "error", `Skill error: ${err.message}`);
      deps.updateState(agentId, "error");
    }
    return true;
  }

  // Slash command resolution — 5-step priority order (see docs/slash-command-design.md)
  async function handleSlashCommand(agentId: string, managed: ManagedAgent, cmd: string, args: string[], rawText: string, username?: string, device?: string): Promise<boolean> {
    const userMeta = buildMeta(username, device);
    const cfg: CommandConfig | undefined = commands[cmd];

    // Step 1: Config lookup (non-overridable)
    if (cfg && !cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        return commandHandlers[cfg.handler](agentId, managed, args, rawText, username, device);
      }
      // Unsupported non-overridable command — show message
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    // Step 2: Skill override check (for overridable config entries OR unknown commands)
    const skillPrompt = resolveSkillPrompt(cmd, managed.info.cwd);
    if (skillPrompt) {
      return executeSkill(agentId, managed, skillPrompt, args, rawText, username, device);
    }

    // Step 3: Config lookup (overridable, no skill found)
    if (cfg && cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        return commandHandlers[cfg.handler](agentId, managed, args, rawText, username, device);
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
    deps.emitEphemeralLog(agentId, "system", `Unknown command \`/${cmd}\`. Type \`/help\` to see available commands.`);
    return true;
  }

  return { commandHandlers, executeSkill, handleSlashCommand };
}
