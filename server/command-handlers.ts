import type { Attachment, AgentState, DiffFileSummary, DiffPayload, LogEntry, SkillInfo, SkillOrigin } from "../shared/types.ts";
import { MODEL_FAMILIES, FAMILY_TO_MODEL, EFFORT_LEVELS, familyDisplayLabel, effortDisplayLabel } from "../shared/types.ts";
import { listAgentSessions, type OfficeConfig } from "./persistence.ts";
import { commands, unsupportedMessage, type CommandConfig } from "./commands.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { resolveSkillPrompt } from "./skills.ts";
import { renderUsageReport, formatRelativeTime } from "./usage-report.ts";
import { SessionSwappedError, type ManagedAgent, type InternalRoom, type AgentEvent } from "./internal-types.ts";
import { execSync } from "child_process";
import { closeSync, openSync, readSync, statSync } from "fs";
import { join } from "path";

type HandlerFn = (agentId: string, managed: ManagedAgent, args: string[], rawText: string, username?: string) => Promise<boolean>;

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
    async clear(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async context(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async help(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async resume(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async model(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async effort(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async isomuxAllHands(agentId, _managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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

    async isomuxSystemPrompt(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const room = deps.getRooms()[managed.info.room]!;
      const officeConfig = deps.getOfficeConfig();
      const prompt = buildSystemPrompt(
        managed.info.name,
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

    async isomuxDiff(agentId, managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const cwd = managed.info.cwd;

      // -c core.quotePath=false keeps non-ASCII / spaced paths in raw UTF-8 form
      // so the client splitter can match them by-path against name-status output.
      const runGit = (args: string, maxBuffer = 10 * 1024 * 1024) =>
        execSync(`git -c core.quotePath=false ${args}`, { cwd, timeout: 10000, maxBuffer, stdio: ["ignore", "pipe", "pipe"] }).toString();
      const runGitOrNull = (args: string, maxBuffer?: number): string | null => {
        try { return runGit(args, maxBuffer); } catch { return null; }
      };

      try {
        runGit("rev-parse --is-inside-work-tree", 1024);
      } catch {
        deps.emitEphemeralLog(agentId, "system", `\`${cwd}\` is not a git repository.`);
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      // Branch + HEAD short SHA. Both are null on a fresh repo with no commits.
      const branchRaw = runGitOrNull("rev-parse --abbrev-ref HEAD", 1024)?.trim() ?? null;
      const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
      const head = runGitOrNull("rev-parse --short HEAD", 1024)?.trim() || null;

      // Pull patch + structured per-file metadata. With HEAD: `diff HEAD` covers
      // staged+unstaged. Without HEAD (fresh repo): `diff --cached` for the
      // staged-vs-empty side, plus `diff` for any workdir-vs-index modifications.
      const gather = (refArgs: string) => ({
        diff: runGit(`diff ${refArgs}`.trim(), 50 * 1024 * 1024),
        numstat: runGit(`diff ${refArgs} --numstat`.trim()).trim(),
        nameStatus: runGit(`diff ${refArgs} --name-status`.trim()).trim(),
      });
      let diff = "";
      let numstat = "";
      let nameStatus = "";
      let untracked: string[] = [];
      try {
        if (head !== null) {
          ({ diff, numstat, nameStatus } = gather("HEAD"));
        } else {
          const cached = gather("--cached");
          const wd = gather("");
          diff = [cached.diff, wd.diff].filter((s) => s.trim()).join("\n");
          numstat = [cached.numstat, wd.numstat].filter(Boolean).join("\n");
          nameStatus = [cached.nameStatus, wd.nameStatus].filter(Boolean).join("\n");
        }
        const untrackedOut = runGit("ls-files --others --exclude-standard").trim();
        if (untrackedOut) untracked = untrackedOut.split("\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.emitEphemeralLog(agentId, "system", `Failed to run git diff in \`${cwd}\`:\n\n\`\`\`\n${msg}\n\`\`\``);
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const fileMap = new Map<string, DiffFileSummary>();

      // Pass 1: --name-status feeds status + rename/copy info.
      if (nameStatus) {
        for (const line of nameStatus.split("\n")) {
          const cols = line.split("\t");
          const code = cols[0] ?? "";
          let status: DiffFileSummary["status"];
          let oldPath: string | undefined;
          let newPath: string;
          if (code.startsWith("R")) {
            status = "renamed";
            oldPath = cols[1] ?? "";
            newPath = cols[2] ?? "";
          } else if (code.startsWith("C")) {
            status = "copied";
            oldPath = cols[1] ?? "";
            newPath = cols[2] ?? "";
          } else if (code === "A") {
            status = "added";
            newPath = cols[1] ?? "";
          } else if (code === "D") {
            status = "deleted";
            newPath = cols[1] ?? "";
          } else {
            status = "modified";
            newPath = cols[1] ?? "";
          }
          if (!newPath) continue;
          fileMap.set(newPath, {
            path: newPath,
            oldPath,
            status,
            additions: 0,
            deletions: 0,
            lineCount: 0,
            inlineEligible: false,
          });
        }
      }

      // Pass 2: --numstat feeds line counts and binary detection. With renames
      // detected, numstat formats the path as either `old => new` or
      // `prefix{old => new}suffix`; we extract the post-image path and merge
      // counts into the entry name-status already created.
      const extractPostImagePath = (raw: string): string => {
        const brace = raw.match(/^(.*)\{([^{}]*?) => ([^{}]*?)\}(.*)$/);
        if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, "/");
        const arrow = raw.indexOf(" => ");
        if (arrow !== -1) return raw.slice(arrow + 4);
        return raw;
      };
      if (numstat) {
        for (const line of numstat.split("\n")) {
          const parts = line.split("\t");
          if (parts.length < 3) continue;
          const addRaw = parts[0]!;
          const delRaw = parts[1]!;
          const path = extractPostImagePath(parts.slice(2).join("\t"));
          const isBinary = addRaw === "-" && delRaw === "-";
          const additions = isBinary ? 0 : parseInt(addRaw, 10) || 0;
          const deletions = isBinary ? 0 : parseInt(delRaw, 10) || 0;
          const existing = fileMap.get(path);
          if (existing) {
            existing.additions = additions;
            existing.deletions = deletions;
            existing.lineCount = additions + deletions;
            if (isBinary) existing.status = "binary";
          } else {
            fileMap.set(path, {
              path,
              status: isBinary ? "binary" : "modified",
              additions,
              deletions,
              lineCount: additions + deletions,
              inlineEligible: false,
            });
          }
        }
      }

      // Probe an untracked file: read the first 8 KB to check for null bytes,
      // stat for size, then read the rest only if the file is small enough to
      // fit comfortably in a synthesized patch. Avoids OOM on large logs/dumps.
      const UNTRACKED_MAX_BYTES = 1_000_000;
      const probeUntracked = (abs: string): { kind: "binary" | "tooLarge" | "ok" | "error"; content?: string } => {
        let fd: number | null = null;
        try {
          fd = openSync(abs, "r");
          const probe = Buffer.alloc(8192);
          const read = readSync(fd, probe, 0, 8192, 0);
          for (let i = 0; i < read; i++) if (probe[i] === 0) return { kind: "binary" };
          const st = statSync(abs);
          if (st.size > UNTRACKED_MAX_BYTES) return { kind: "tooLarge" };
          if (st.size <= read) return { kind: "ok", content: probe.subarray(0, st.size).toString("utf8") };
          const buf = Buffer.alloc(st.size);
          probe.copy(buf, 0, 0, read);
          let off = read;
          while (off < st.size) {
            const r = readSync(fd, buf, off, st.size - off, off);
            if (r === 0) break;
            off += r;
          }
          return { kind: "ok", content: buf.subarray(0, off).toString("utf8") };
        } catch {
          return { kind: "error" };
        } finally {
          if (fd !== null) try { closeSync(fd); } catch {}
        }
      };

      // Synthesize patches for untracked text files; surface binaries / oversized
      // files as rows without inline patch content.
      const untrackedPatches: string[] = [];
      for (const path of untracked) {
        const probe = probeUntracked(join(cwd, path));
        if (probe.kind === "error") continue;
        if (probe.kind === "binary") {
          fileMap.set(path, { path, status: "binary", additions: 0, deletions: 0, lineCount: 0, inlineEligible: false });
          continue;
        }
        if (probe.kind === "tooLarge") {
          // Re-use the otherwise-unused "untracked" status to flag "we saw it but
          // didn't synthesize"; the overlay surfaces a friendly explanation.
          fileMap.set(path, { path, status: "untracked", additions: 0, deletions: 0, lineCount: 0, inlineEligible: false });
          continue;
        }
        const content = probe.content!;
        const lines = content === "" ? [] : content.split("\n");
        const trailingNewline = content.endsWith("\n");
        const realLines = trailingNewline ? lines.slice(0, -1) : lines;
        const additions = realLines.length;
        const header = [
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${additions} @@`,
        ];
        const body = realLines.map((l) => `+${l}`);
        if (!trailingNewline && realLines.length > 0) body.push("\\ No newline at end of file");
        untrackedPatches.push([...header, ...body].join("\n"));
        fileMap.set(path, { path, status: "added", additions, deletions: 0, lineCount: additions, inlineEligible: false });
      }

      // Combine tracked patch + untracked synthesized patches into one unified blob.
      let patchText: string | null = diff;
      if (untrackedPatches.length > 0) {
        const trail = patchText && !patchText.endsWith("\n") ? "\n" : "";
        patchText = (patchText ?? "") + trail + untrackedPatches.join("\n") + "\n";
      }
      if (patchText !== null && patchText.trim() === "") patchText = null;

      // Stamp inlineEligible per file. Statuses without textual content
      // ("binary", "untracked"-as-too-large) never render inline.
      for (const summary of fileMap.values()) {
        const hasTextualPatch = patchText !== null && summary.status !== "binary" && summary.status !== "untracked";
        summary.inlineEligible = hasTextualPatch && summary.lineCount <= 500;
      }

      // 2MB safety rail: drop patchText, keep summaries.
      const MAX_PATCH_BYTES = 2 * 1024 * 1024;
      let truncated = false;
      if (patchText !== null && Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES) {
        patchText = null;
        truncated = true;
        for (const summary of fileMap.values()) summary.inlineEligible = false;
      }

      const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
      const stats = files.reduce(
        (acc, f) => ({
          additions: acc.additions + f.additions,
          deletions: acc.deletions + f.deletions,
          filesChanged: acc.filesChanged + 1,
        }),
        { additions: 0, deletions: 0, filesChanged: 0 },
      );

      if (files.length === 0) {
        deps.emitEphemeralLog(agentId, "system", `Working tree clean in \`${cwd}\` — no uncommitted changes.`);
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const summaryLine = `+${stats.additions} -${stats.deletions} across ${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"}`;
      const payload: DiffPayload = { cwd, branch, head, stats, files, patchText, truncated };
      deps.emitEphemeralLog(agentId, "diff", summaryLine, undefined, { diff: payload });
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async usage(agentId, _managed, _args, rawText, username) {
      const userMeta = username ? { username } : undefined;
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
  async function executeSkill(agentId: string, managed: ManagedAgent, skillPrompt: string, args: string[], rawText: string, username?: string): Promise<boolean> {
    const userArgs = args.join(" ");
    const fullPrompt = userArgs
      ? `${skillPrompt}\n\nUser context: ${userArgs}`
      : skillPrompt;
    // sdkText captures the expanded prompt the SDK actually receives so editMessage
    // can match this log entry against the SDK session (content alone is the slash
    // command and won't match).
    const userMeta: Record<string, unknown> = { sdkText: fullPrompt };
    if (username) userMeta.username = username;
    deps.addLogEntry(agentId, "user_message", rawText, userMeta);
    deps.updateState(agentId, "thinking");
    const prefixedSkillPrompt = username ? `[${username}] ${fullPrompt}` : fullPrompt;
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
  async function handleSlashCommand(agentId: string, managed: ManagedAgent, cmd: string, args: string[], rawText: string, username?: string): Promise<boolean> {
    const userMeta = username ? { username } : undefined;
    const cfg: CommandConfig | undefined = commands[cmd];

    // Step 1: Config lookup (non-overridable)
    if (cfg && !cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        return commandHandlers[cfg.handler](agentId, managed, args, rawText, username);
      }
      // Unsupported non-overridable command — show message
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    // Step 2: Skill override check (for overridable config entries OR unknown commands)
    const skillPrompt = resolveSkillPrompt(cmd, managed.info.cwd);
    if (skillPrompt) {
      return executeSkill(agentId, managed, skillPrompt, args, rawText, username);
    }

    // Step 3: Config lookup (overridable, no skill found)
    if (cfg && cfg.overridable) {
      if (cfg.supported && cfg.handler && commandHandlers[cfg.handler]) {
        return commandHandlers[cfg.handler](agentId, managed, args, rawText, username);
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
