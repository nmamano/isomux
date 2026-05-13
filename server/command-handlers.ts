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
  EFFORT_LEVELS,
  familyDisplayLabel,
  effortDisplayLabel,
} from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";
import { errMessage } from "../shared/errors.ts";
import { listAgentSessions } from "./persistence.ts";
import {
  commands,
  unsupportedMessage,
  type CommandConfig,
} from "./commands.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { listCronjobs, buildCronjobSystemPrompt } from "./cronjob-manager.ts";
import { resolveSkillPrompt } from "./skills.ts";
import { renderUsageReport, formatRelativeTime } from "./usage-report.ts";
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

interface HandlerDeps {
  // State accessors (live references — read at call time)
  agents: Map<string, ManagedAgent>;
  getRooms: () => RoomWire[];
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
    extra?: Partial<Pick<LogEntry, "diff" | "file">>,
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
  createTurnDeferred: (managed: ManagedAgent) => Promise<void>;
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
      managed.pendingResume = false;
      managed.pendingResumeSessions = [];
      managed.pendingModelPick = false;
      managed.pendingEffortPick = false;
      // /clear is a fresh start; queued messages were addressed to the prior
      // context and shouldn't bleed into the new conversation. Must run BEFORE
      // replaceSession — otherwise the post-swap idle trigger flushes them.
      if (managed.messageQueue.length > 0) {
        managed.messageQueue.length = 0;
        deps.emit({ type: "agent_updated", agentId, changes: { queue: [] } });
      }
      deps.persistCurrentSessionTopic(agentId, managed);
      await deps.replaceSession(agentId, managed, deps.createSession(managed));
      managed.sessionId = null;
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
      if (!managed.session) {
        deps.addLogEntry(agentId, "system", "No active session.");
        return true;
      }
      try {
        const ctx = await managed.session.getContextUsage();
        if (!ctx) {
          deps.addLogEntry(
            agentId,
            "system",
            "Context usage not available for this session.",
          );
          return true;
        }
        const lines: string[] = [];

        const pct = Math.round(ctx.percentage);
        const barLen = 30;
        const filled = Math.round((barLen * ctx.percentage) / 100);
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        lines.push(
          `**${ctx.model}** — ${ctx.totalTokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens (${pct}%)`,
        );
        lines.push(`\`${bar}\``);

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

      // Agent metadata
      const topicLine = managed.info.topic
        ? `  Topic: ${managed.info.topic}`
        : "";
      lines.push(
        `**${managed.info.name}** — Room ${managed.info.room + 1}, Desk ${managed.info.desk + 1}`,
      );
      lines.push(`  cwd: \`${managed.info.cwd}\``);
      if (topicLine) lines.push(topicLine);
      lines.push("");

      // Isomux description
      lines.push(
        "Isomux gives your agents a cute office. Multi-device, multi-user, multi-agent collaboration. Learn more at https://isomux.com",
      );
      lines.push("");

      // Commands
      const cmdList = managed.slashCommands
        .map((c) =>
          c.description
            ? `  \`/${c.name}\`  — ${c.description}`
            : `  \`/${c.name}\``,
        )
        .join("\n");
      lines.push(`**Commands:**\n${cmdList}`);

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
      const grouped = new Map<SkillOrigin, SkillInfo[]>();
      for (const s of managed.skills) {
        if (!grouped.has(s.origin)) grouped.set(s.origin, []);
        grouped.get(s.origin)!.push(s);
      }
      for (const origin of originOrder) {
        const skills = grouped.get(origin);
        if (!skills || skills.length === 0) continue;
        const skillLines = skills
          .map((s) => {
            const desc = s.description ? ` — ${s.description}` : "";
            return `  \`/${s.name}\`${desc}`;
          })
          .join("\n");
        lines.push(`\n**${originLabel[origin]}:**\n${skillLines}`);
      }

      // Tips
      lines.push("\n**Tips:**");
      lines.push(
        "  • Isomux also works on your phone. The easiest way is to connect it to the same tailscale network as the machine running it (it's free).",
      );
      lines.push(
        "  • The built-in side-panel terminal is useful for one-off situations where you need to run something manually, like auth flows.",
      );
      lines.push(
        "  • Isomux comes with safety pre-tool-call hooks to prevent destructive commands, like `rm -rf /`.",
      );
      lines.push(
        "  • Isomux agents can check what other agents are up to in real time. Just ask naturally.",
      );
      lines.push(
        "  • Agents can also message each other directly — ask one agent to ask another, or to relay a message.",
      );
      lines.push(
        '  • Type ahead while an agent is busy: messages queue and flush when it\'s idle. Hit "Send now" to interrupt and flush immediately.',
      );
      lines.push(
        "  • Use `/isomux-edit <path>` to open a file in the side-panel editor; agents can offer the same affordance from chat.",
      );
      lines.push(
        "  • Use voice-to-text for faster prompting. The shortcut is ctrl+space.",
      );
      lines.push(
        "  • Use `/isomux-all-hands` to check what every agent is up to.",
      );
      lines.push("  • Use `/isomux-report-bug` if you find any issues.");
      lines.push(
        "  • Use `/isomux-grill-me` to make your feature designs more robust.",
      );
      lines.push(
        "  • Use `/isomux-pair-programming <agent> <feature>` to drive a feature end-to-end with another agent reviewing your design and code.",
      );

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
        if (s.sessionId === managed.sessionId) {
          lines.push(`  ● ${label}  ${dateStr}  (current)`);
        } else {
          lines.push(`  ${num}. ${label}  ${dateStr}${suffix}`);
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
      for (let i = 0; i < EFFORT_LEVELS.length; i++) {
        const e = EFFORT_LEVELS[i];
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
        const roomAgents = roomMap
          .get(room)!
          .sort((a, b) => a.info.desk - b.info.desk);
        lines.push(`**=== Room ${room + 1} ===**`);
        lines.push("");

        for (const a of roomAgents) {
          const selfTag = a.info.id === agentId ? "  **(me)**" : "";
          const modelLabel = familyDisplayLabel(a.info.modelFamily);
          lines.push(
            `**${a.info.name}** (desk ${a.info.desk + 1})${selfTag} — ${modelLabel} — \`${a.info.cwd}\``,
          );

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
      const room = deps.getRooms()[managed.info.room];
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

    async usage(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      deps.addLogEntry(
        agentId,
        "system",
        renderUsageReport(deps.agents, deps.getRooms()),
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

    // sdkText captures the expanded prompt the SDK actually receives so editMessage
    // can match this log entry against the SDK session (content alone is the slash
    // command and won't match).
    const userMeta: Record<string, unknown> = { sdkText: fullPrompt };
    if (username) userMeta.username = username;
    if (device) userMeta.device = device;
    deps.addLogEntry(agentId, "user_message", rawText, userMeta);
    deps.beginTurn(agentId, { humanInput: true });
    const prefix = formatPrefix({ username, device });
    const prefixedSkillPrompt = prefix ? `${prefix}${fullPrompt}` : fullPrompt;
    try {
      const turn = deps.createTurnDeferred(managed);
      await managed.session!.send(prefixedSkillPrompt);
      await turn;
    } catch (err) {
      if (err instanceof SessionSwappedError) return true;
      deps.addLogEntry(agentId, "error", `Skill error: ${errMessage(err)}`);
      deps.updateState(agentId, "error");
    }
    return true;
  }

  // Slash command resolution — 5-step priority order (see internal-docs/slash-command-design.md)
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

    // Step 1: Config lookup (non-overridable)
    if (cfg && !cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
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
