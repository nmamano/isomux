import type {
  Attachment,
  AgentInfo,
  AgentChoiceInteractionKind,
  AgentState,
  LogEntry,
  OfficeSettings,
  QueuedMessage,
  RoomWire,
  SkillInfo,
  SkillOrigin,
} from "../shared/types.ts";
import { sessionResumeLabel } from "../shared/session-label.ts";
import { translatorForUsername } from "./i18n.ts";
import type { Translator } from "../shared/i18n/translate.ts";
import { COMMAND_DESCRIPTION_KEYS } from "../shared/i18n/command-keys.ts";
import { keyFrom } from "../shared/i18n/translate.ts";
import { formatDecimal, formatNumber } from "../shared/i18n/number.ts";
import { formatDateTime } from "../shared/i18n/time.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import {
  MODEL_FAMILIES,
  effortLevelsFor,
  familyDisplayLabel,
  effortDisplayLabel,
} from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";
import { errMessage } from "../shared/errors.ts";
import { listAgentSessions, loadAgentHistory } from "./persistence.ts";
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
import { aggregateOnly, type StorageUsage } from "./storage-usage.ts";
import { renderStorageReport, type AgentLabel } from "./storage-report.ts";
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
import type { BackendSession } from "./backends/types.ts";
import { runAgentTurn } from "./agent-turn.ts";
import { buildPublicOrigin } from "./auth.ts";
import { modelListingLabel } from "./model-listing-label.ts";

const DOCS_URL = "https://isomux.com/docs";
const CRONJOB_PROMPT_USAGE = "`/isomux-cronjob-system-prompt <name-or-id>`";
const EDIT_USAGE = "`/isomux-edit <path>`";
const ACCESS_DOCS_URL = "https://isomux.com/docs/access-and-invites";

type HandlerFn = (
  agentId: string,
  managed: ManagedAgent,
  args: string[],
  rawText: string,
  username?: string,
  device?: string,
) => Promise<boolean>;

// The leading newline is layout, so it stays in code; only the sentence is
// translated (internal-docs/i18n-loop.md, S7).
function choiceInstruction(
  t: Translator["t"],
  kind: AgentChoiceInteractionKind,
): string {
  return kind === "resume"
    ? `\n${t("choices.resume.instruction")}`
    : `\n${t("choices.model.instruction")}`;
}

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
  for (const it of items) {
    if (it.aliasFor) continue;
    canonicalIndex.set(it.name, {
      names: [it.name],
      description: it.description,
    });
  }
  // An alias pointing at an unknown canonical falls back to standing alone
  // rather than disappearing silently.
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
function formatAliasGroup(
  t: Translator["t"],
  names: string[],
  description?: string,
): string {
  const sorted = [...names].sort((a, b) => a.length - b.length);
  const primary = `\`/${sorted[0]}\``;
  const others = sorted.slice(1).map((n) => `\`/${n}\``);
  const head =
    others.length > 0
      ? t("commands.help.aliasGroup", { primary, others: others.join(", ") })
      : primary;
  return description ? `  ${head} - ${description}` : `  ${head}`;
}

interface HandlerDeps {
  // State accessors are live references, read at call time.
  agents: Map<string, ManagedAgent>;
  getRooms: () => RoomWire[];
  // roomId is the room authority; the global room index / room object
  // are derived from it via these helpers (AgentInfo no longer carries a dense
  // room index).
  globalRoomIndexOf: (roomId: string) => number;
  roomById: (roomId: string) => RoomWire | undefined;
  getOfficeConfig: () => OfficeSettings;
  logCache: Map<string, LogEntry[]>;

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
  openChoiceInteraction: (
    agentId: string,
    kind: AgentChoiceInteractionKind,
    title: string,
    instruction: string,
    choices: {
      value: string;
      label: string;
      description?: string;
      current?: boolean;
    }[],
  ) => void;
  cancelChoiceInteraction: (agentId: string) => void;

  // Login-instructions helper. Wraps agentLoginInstructions + per-backend
  // dispatch in agent-manager so the /login handler can render the same
  // explanatory text + [Copy to terminal] cards an auth-error path would.
  emitLoginInstructionsFor: (
    agentId: string,
    managed: ManagedAgent,
    // The person who typed /login, so the explanatory text reads in their
    // language rather than the agent owner's.
    username?: string,
  ) => void;
  emitLogoutAffordanceFor: (
    agentId: string,
    managed: ManagedAgent,
    username?: string,
  ) => Promise<void>;

  // The typed /clear builds its session first and runs its own pending-control
  // and queue bookkeeping before the swap, so it takes the create and the swap
  // as two steps; it is the only caller that hands SessionManager a session it
  // built. Every other swap goes through sessionManager.replaceWith.
  createSession: (
    managed: ManagedAgent,
    resumeSessionId?: string,
  ) => BackendSession;
  replaceSession: (
    agentId: string,
    managed: ManagedAgent,
    newSession: BackendSession,
  ) => Promise<void>;
  persistAll: () => void;
  persistCurrentSessionTopic: (agentId: string, managed: ManagedAgent) => void;
  // Wake a DORMANT agent so a skill's turn has a live session to send on (lazy
  // restore). Returns true if a session is ready; false if starting one failed
  // (an error was already logged and the agent moved to "error"), in which case
  // the caller must stop. Caller must gate on `managed.info.dormant` - a
  // genuinely-broken (non-dormant) session is left to surface its own error.
  wakeDormantSession: (
    agentId: string,
    managed: ManagedAgent,
    rawText: string,
    username?: string,
    device?: string,
  ) => boolean;
  // Context-fullness reset (see resetContextUsage in agent-manager): the typed
  // /clear (also /reset, /new) is a semantic conversation boundary, so it must
  // clear the fullness snapshot + fired context-notice thresholds and
  // broadcast the explicit-null pill clear, like every other boundary
  // (newConversation, resume-to-different-session, edit-fork).
  resetContextUsage: (managed: ManagedAgent) => void;
  // The office's disk-usage measurement, FULL (per-agent detail included) -
  // the same call GET /api/storage/usage makes, memoized for 30s. Injected
  // rather than imported so the /isomux-storage access-control branches can be
  // pinned without walking a real state root, and so the refusal path can be
  // proven not to measure at all.
  getStorageUsage: () => StorageUsage;
  claudeConfigDirFor: (managed: ManagedAgent) => string;
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
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      // Build the new session BEFORE destroying pending control state and
      // the message queue. If createSession throws (bad cwd, broken env,
      // etc.) the user sees a visible error and the prior pending/queue
      // state stays intact - they can retry or pick another recovery path.
      // Once createSession returns, the swap commits: pending/queue clear,
      // topic persists, replaceSession installs. Queue must clear BEFORE
      // replaceSession or the post-swap idle trigger flushes prior-context
      // messages into the fresh session.
      try {
        const newSession = deps.createSession(managed);
        managed.pendingResumeSessions = [];
        deps.cancelChoiceInteraction(agentId);
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
          t("commands.clear.failed", { error: errMessage(err) }),
        );
        deps.updateState(agentId, "error");
        return true;
      }
      managed.sessionManager.sessionId = null;
      // Conversation boundary: reset context-fullness state and broadcast the
      // pill clear. Runs AFTER the swap resolves (unlike newConversation's
      // pre-await reset) - safe here because replaceSession already installed
      // the new session, so every old-session in-flight sample is orphaned by
      // the session-identity check regardless of gen. Missing this reset left
      // the pill showing the PREVIOUS conversation's reading after a typed
      // /clear, and carried its fired thresholds into the fresh conversation
      // (the API /clear path resets via newConversation).
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
      deps.emitEphemeralLog(agentId, "system", t("commands.clear.done"));
      deps.updateState(agentId, "idle");
      deps.persistAll();
      return true;
    },

    async context(agentId, managed, _args, rawText, username, device) {
      const { t, language } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      const headerLines = (u: {
        model: string;
        totalTokens: number;
        maxTokens: number;
        percentage: number;
      }): string[] => {
        const pct = Math.round(u.percentage);
        const barLen = 30;
        // Clamped into [0, barLen]: a reading outside 0-100% (a backend
        // reporting a stale window) otherwise hands String.repeat a negative
        // count and throws, taking /context down
        // entirely. The percentage itself stays unclamped -- it sits next to
        // the raw token counts, so capping it at 100% would contradict them.
        const filled = Math.max(
          0,
          Math.min(barLen, Math.round((barLen * u.percentage) / 100)),
        );
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        return [
          t("commands.context.header", {
            model: u.model,
            used: formatNumber(language, u.totalTokens),
            max: formatNumber(language, u.maxTokens),
            percent: pct,
          }),
          `\`${bar}\``,
        ];
      };
      // No live session (released while idle, or never started), or the live
      // read fails: fall back to the last committed snapshot - the same
      // reading the battery pill shows. Reading the snapshot
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
              ? t("commands.context.ageUnderMinute")
              : ageMin < 60
                ? t("commands.context.ageMinutes", { minutes: ageMin })
                : t("commands.context.ageHoursMinutes", {
                    hours: Math.floor(ageMin / 60),
                    minutes: ageMin % 60,
                  });
          lines.push("", note(age));
        }
        deps.addLogEntry(agentId, "system", lines.join("\n"));
        return true;
      };
      if (!managed.sessionManager.session) {
        // Released-while-idle renders IDENTICALLY to the live case (no
        // lifecycle note - remaining context doesn't change when the session
        // process is released).
        if (snapshotFallback()) return true;
        deps.addLogEntry(agentId, "system", t("commands.context.noSession"));
        return true;
      }
      try {
        const ctx = await managed.sessionManager.session.getContextUsage();
        if (!ctx) {
          if (
            snapshotFallback((age) =>
              t("commands.context.staleUnavailable", { age }),
            )
          )
            return true;
          deps.addLogEntry(
            agentId,
            "system",
            t("commands.context.unavailable"),
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
                `  ${t("commands.context.category", {
                  name: cat.name,
                  tokens: formatNumber(language, cat.tokens),
                  percent: catPct,
                })}`,
              );
            }
          }
        }

        if ((ctx.memoryFiles?.length ?? 0) > 0 && ctx.memoryFiles) {
          lines.push(`\n${t("commands.context.memoryFiles")}`);
          for (const f of ctx.memoryFiles) {
            lines.push(
              `  ${t("commands.context.memoryFile", {
                path: f.path,
                tokens: formatNumber(language, f.tokens),
              })}`,
            );
          }
        }

        if (
          (ctx.systemPromptSections?.length ?? 0) > 0 &&
          ctx.systemPromptSections
        ) {
          lines.push(`\n${t("commands.context.systemPrompt")}`);
          for (const s of ctx.systemPromptSections) {
            lines.push(
              `  ${t("commands.context.systemPromptSection", {
                name: s.name,
                tokens: formatNumber(language, s.tokens),
              })}`,
            );
          }
        }

        if (ctx.isAutoCompactEnabled && ctx.autoCompactThreshold) {
          const compactPct = Math.round(
            (ctx.autoCompactThreshold / ctx.maxTokens) * 100,
          );
          lines.push(
            `\n${t("commands.context.autoCompact", {
              percent: compactPct,
              tokens: formatNumber(language, ctx.autoCompactThreshold),
            })}`,
          );
        }

        deps.addLogEntry(agentId, "system", lines.join("\n"));
      } catch (err) {
        if (
          snapshotFallback((age) => t("commands.context.staleFailed", { age }))
        )
          return true;
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.context.failed", { error: errMessage(err) }),
        );
      }
      return true;
    },

    async help(agentId, managed, _args, rawText, username, device) {
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const lines: string[] = [];

      lines.push(t("commands.help.docs", { url: DOCS_URL }));

      lines.push(`\n${t("commands.help.tips")}`);
      lines.push(`  • ${t("commands.help.tipAgents")}`);
      lines.push(`  • ${t("commands.help.tipQueue")}`);
      lines.push(`  • ${t("commands.help.tipVoice")}`);
      // Reachability tips depend on whether this boot has a real public
      // origin (env/config, non-loopback bind). Without one, the office is
      // VPN/tunnel territory; with one, the phone tip is just the URL and
      // the Funnel preamble to the invite tip is moot.
      const publicOrigin = buildPublicOrigin();
      if (publicOrigin.source === "localhost") {
        lines.push(`  • ${t("commands.help.tipPhoneVpn")}`);
        lines.push(
          `  • ${t("commands.help.tipInviteFunnel", { url: ACCESS_DOCS_URL })}`,
        );
      } else {
        lines.push(
          `  • ${t("commands.help.tipPhoneOrigin", { origin: publicOrigin.origin })}`,
        );
        lines.push(`  • ${t("commands.help.tipInvite")}`);
      }
      lines.push(`  • ${t("commands.help.tipTerminal")}`);
      lines.push(`  • ${t("commands.help.tipHooks")}`);

      // Collapse aliased entries (e.g. `/diff` aliasFor `/isomux-diff`) into a
      // single line. The friendlier shorthand leads.
      // A config command's words come from the catalog, keyed by its name; the
      // wire carries no description for one (server/commands.ts). A name the
      // catalog does not know is a backend-reported command, which keeps
      // whatever description it arrived with.
      const cmdGroups = groupByAlias(
        managed.slashCommands.map((c) => {
          const key = keyFrom(COMMAND_DESCRIPTION_KEYS, c.name);
          return {
            name: c.name,
            description: key ? t(key) : c.description,
            aliasFor: c.aliasFor,
          };
        }),
      );
      const cmdList = cmdGroups
        .map((g) => formatAliasGroup(t, g.names, g.description))
        .join("\n");
      lines.push(`\n${t("commands.help.commands")}\n${cmdList}`);

      const originLabel: Record<SkillOrigin, string> = {
        user: t("commands.help.skillsUser"),
        project: t("commands.help.skillsProject"),
        plugin: t("commands.help.skillsPlugin"),
        isomux: t("commands.help.skillsIsomux"),
        claude: t("commands.help.skillsClaude"),
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
          .map((g) => formatAliasGroup(t, g.names, g.description))
          .join("\n");
        lines.push(`\n**${originLabel[origin]}:**\n${skillLines}`);
      }

      deps.addLogEntry(agentId, "system", lines.join("\n"));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async resume(agentId, managed, _args, rawText, username, device) {
      const { t, language } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const sessions = listAgentSessions(agentId);
      if (sessions.length === 0) {
        deps.emitEphemeralLog(agentId, "system", t("commands.resume.none"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const lines: string[] = [`${t("commands.resume.header")}\n`];
      const pickable: typeof sessions = [];
      for (const s of sessions.slice(0, 20)) {
        const dateStr = formatDateTime(
          language,
          s.lastModified,
          "monthDayTime",
        );
        const rawLabel = sessionResumeLabel(
          s,
          t("common.untitledConversation"),
        );
        const label = s.forked ? `↳ ${rawLabel}` : rawLabel;
        const suffix = s.branched ? `  ${t("commands.resume.branched")}` : "";
        // cwd is a property of the session - surface it so the user sees which
        // directory each session will resume into (it can differ per session).
        // Abbreviate the home prefix to `~` to save horizontal space.
        const cwdStr = s.cwd ? `  ${tildifyCwd(s.cwd)}` : "";
        if (s.sessionId === managed.sessionManager.sessionId) {
          lines.push(
            `  ● ${label}  ${dateStr}${cwdStr}  ${t("common.current")}`,
          );
        } else {
          lines.push(
            `  ${pickable.length + 1}. ${label}  ${dateStr}${cwdStr}${suffix}`,
          );
          pickable.push(s);
        }
      }
      if (pickable.length === 0) {
        deps.emitEphemeralLog(agentId, "system", t("commands.resume.noOthers"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const instruction = choiceInstruction(t, "resume");
      lines.push(instruction);
      managed.pendingResumeSessions = pickable;
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "resume",
        t("choices.resume.title"),
        instruction,
        pickable.map((session) => {
          const date = formatDateTime(
            language,
            session.lastModified,
            "monthDayTime",
          );
          const cwd = session.cwd ? ` · ${tildifyCwd(session.cwd)}` : "";
          const branched = session.branched
            ? ` · ${t("choices.resume.branched")}`
            : "";
          return {
            value: session.sessionId,
            label: `${session.forked ? "↳ " : ""}${sessionResumeLabel(
              session,
              t("common.untitledConversation"),
            )}`,
            description: `${date}${cwd}${branched}`,
          };
        }),
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async model(agentId, managed, _args, rawText, username, device) {
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      if (managed.info.agentType === "opencode") {
        deps.emitEphemeralLog(
          agentId,
          "system",
          t("commands.model.openCodeUnsupported"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const currentLabel = familyDisplayLabel(managed.info.modelFamily);
      const lines: string[] = [
        `${t("commands.model.header", { current: currentLabel })}\n`,
      ];
      const choices = MODEL_FAMILIES.map((model) => ({
        value: model.family,
        label: familyDisplayLabel(model.family),
        current: model.family === managed.info.modelFamily,
      }));
      lines.push(
        ...choices.map(
          (choice, index) =>
            `  ${index + 1}. ${choice.label}${choice.current ? ` ${t("common.current")}` : ""}`,
        ),
      );
      const instruction = choiceInstruction(t, "model");
      lines.push(instruction);
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "model",
        t("choices.model.title"),
        instruction,
        choices,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async effort(agentId, managed, _args, rawText, username, device) {
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      if (managed.info.agentType === "opencode") {
        deps.emitEphemeralLog(
          agentId,
          "system",
          t("commands.effort.openCodeUnsupported"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const currentLabel = effortDisplayLabel(t, managed.info.effort);
      const lines: string[] = [
        `${t("commands.effort.header", { current: currentLabel })}\n`,
      ];
      // Backend/model-filtered list. The structured interaction carries each
      // level id, so a typed number and a card click resolve to the same value.
      const levels = effortLevelsFor(
        managed.info.agentType,
        managed.info.modelFamily,
      );
      const choices = levels.map((effort) => ({
        value: effort.level,
        label: effortDisplayLabel(t, effort.level),
        current: effort.level === managed.info.effort,
      }));
      lines.push(
        ...choices.map(
          (choice, index) =>
            `  ${index + 1}. ${choice.label}${choice.current ? ` ${t("common.current")}` : ""}`,
        ),
      );
      const instruction = choiceInstruction(t, "effort");
      lines.push(instruction);
      deps.emitEphemeralLog(agentId, "system", lines.join("\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "effort",
        t("choices.effort.title"),
        instruction,
        choices,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxAllHands(agentId, _managed, _args, rawText, username, device) {
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      // Group, sort, and label by the roomId-derived global room index;
      // AgentInfo no longer carries a dense room field.
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
        lines.push(t("commands.isomuxAllHands.room", { number: room + 1 }));
        lines.push("");

        for (const a of roomAgents) {
          const selfTag =
            a.info.id === agentId ? `  ${t("commands.isomuxAllHands.me")}` : "";
          const modelLabel = modelListingLabel(
            a.info.agentType,
            a.info.modelFamily,
          );
          const topic = a.info.topic;
          const hasTopic = topic && topic !== "...";
          const desk = t("commands.isomuxAllHands.desk", {
            number: a.info.desk + 1,
          });
          const header = `**${a.info.name}** (${desk})${selfTag} - ${modelLabel} - \`${a.info.cwd}\``;
          if (hasTopic) {
            lines.push(header);
            lines.push(`  ${t("commands.isomuxAllHands.topic", { topic })}`);
          } else {
            lines.push(`<span style="color: var(--text-dim)">${header}</span>`);
          }
          lines.push("");
        }
      }

      lines.push(t("commands.isomuxAllHands.footer"));

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
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      // A live agent's roomId always resolves; roomById logs loud on a
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
        room.id,
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
        ownerRecord?.language ?? null,
      );
      // Pick a fence longer than any backtick run inside the prompt so the block
      // renders verbatim regardless of what office/room/agent prompts contain.
      const longestRun = (prompt.match(/`+/g) ?? []).reduce(
        (m, s) => Math.max(m, s.length),
        0,
      );
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header = t("commands.isomuxSystemPrompt.header");
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
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const query = args.join(" ").trim();
      const all = listCronjobs();

      if (!query) {
        const lines = [
          t("commands.isomuxCronjobSystemPrompt.usage", {
            usage: CRONJOB_PROMPT_USAGE,
          }),
        ];
        if (all.length === 0) {
          lines.push(
            `\n${t("commands.isomuxCronjobSystemPrompt.noSchedules")}`,
          );
        } else {
          lines.push(`\n${t("commands.isomuxCronjobSystemPrompt.known")}`);
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
            t("commands.isomuxCronjobSystemPrompt.ambiguous", { query }),
          ];
          for (const c of byNameMatches) lines.push(`  \`${c.id}\``);
          deps.addLogEntry(agentId, "system", lines.join("\n"));
        } else {
          deps.addLogEntry(
            agentId,
            "system",
            t("commands.isomuxCronjobSystemPrompt.noMatch", { query }),
          );
        }
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      // The cronjob receives the system prompt + the configured prompt as its
      // first user message, so display both - that's the full initial input.
      const systemPrompt = buildCronjobSystemPrompt(target);
      const combined = `${systemPrompt}\n\n----\n${t(
        "commands.isomuxCronjobSystemPrompt.firstUserMessage",
      )}\n\n${target.prompt}`;
      const longestRun = (combined.match(/`+/g) ?? []).reduce(
        (m, s) => Math.max(m, s.length),
        0,
      );
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      const header = t("commands.isomuxCronjobSystemPrompt.header", {
        name: target.name,
      });
      deps.addLogEntry(
        agentId,
        "system",
        `${header}\n\n${fence}plaintext\n${combined}\n${fence}`,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxEdit(agentId, managed, args, rawText, username, device) {
      const { t, language } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const rawPath = args[0];
      if (!rawPath) {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.usage", {
            usage: EDIT_USAGE,
            cwd: managed.info.cwd,
          }),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const resolved = resolveEditorPath(rawPath, managed.info.cwd);
      if (resolved.kind === "bad_path") {
        deps.addLogEntry(agentId, "system", t("commands.isomuxEdit.emptyPath"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const probe = openEditorFile(resolved.path);
      if (probe.kind === "not_found") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.notFound", { path: resolved.path }),
        );
      } else if (probe.kind === "not_file") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.notFile", { path: resolved.path }),
        );
      } else if (probe.kind === "binary") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.binary", { path: resolved.path }),
        );
      } else if (probe.kind === "too_large") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.tooLarge", {
            path: resolved.path,
            size: `${formatDecimal(language, probe.size / 1024, 1)} KB`,
          }),
        );
      } else if (probe.kind === "io_error") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxEdit.ioError", {
            path: resolved.path,
            message: probe.message,
          }),
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
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      const resolved = resolveDiffCwd(args[0], managed.info.cwd);
      if (resolved.kind === "bad_dir") {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.isomuxDiff.notDirectory", { path: resolved.attempted }),
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
            t("commands.isomuxDiff.notRepo", { path: result.cwd }),
          );
          break;
        case "git_error":
          deps.addLogEntry(
            agentId,
            "system",
            `${t("commands.isomuxDiff.gitError", {
              path: result.cwd,
            })}\n\n\`\`\`\n${result.message}\n\`\`\``,
          );
          break;
        case "clean":
          deps.addLogEntry(
            agentId,
            "system",
            t("commands.isomuxDiff.clean", { path: result.cwd }),
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
      // would surface - single source of truth for "how does this agent
      // authenticate." Codex emits its login card or the auto-clear short
      // text when already authed; Claude emits its
      // /login walkthrough with a `claude` terminal card.
      deps.emitLoginInstructionsFor(agentId, managed, username);
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async logout(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      await deps.emitLogoutAffordanceFor(agentId, managed, username);
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async usage(agentId, _managed, _args, rawText, username, device) {
      const { t } = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      const usageLines = [
        t("commands.usage.heading"),
        "",
        t("commands.usage.intro"),
        "",
        `- ${t("commands.usage.claude")}`,
        `- ${t("commands.usage.codex")}`,
        "",
        t("commands.usage.office"),
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
      // skip the card entirely and surface a one-line system note - a dead
      // card is worse than no card.
      let codexWrapperReady = false;
      try {
        ensureCodexWrapperScript();
        codexWrapperReady = true;
      } catch (err) {
        deps.addLogEntry(
          agentId,
          "system",
          t("commands.usage.codexCardOmitted", { error: errMessage(err) }),
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

    async isomuxStorage(agentId, _managed, _args, rawText, username, device) {
      const i18n = translatorForUsername(username);
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      // Same gate as GET /api/storage/usage: office:read, which every human
      // has and a plain agent token does not. An invocation that did not come
      // from a signed-in person gets nothing rather than office-wide disk
      // totals - the command's equivalent of the route's 403.
      const user = username ? getUserByName(username) : undefined;
      if (!user) {
        deps.addLogEntry(
          agentId,
          "system",
          i18n.t("commands.isomuxStorage.forbidden"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      // Shares the route's memoized measurement (30s), so running the command
      // right after loading the settings page re-walks nothing. Reached only
      // AFTER the user check above, so an unauthenticated invocation never
      // triggers a disk walk either.
      const usage = deps.getStorageUsage();
      // Stored history outlives the agents that wrote it, so a name comes from
      // the live agent when there is one and from agent history when the agent
      // has been killed. The raw directory name is the last resort - a row with
      // no label would hide real bytes. The "killed" flag follows agent
      // history's own killedAt rather than mere absence from the live map, so a
      // name is never annotated on a guess. Names go out RAW; the renderer
      // escapes them.
      const history = loadAgentHistory();
      const agentLabel = (id: string): AgentLabel => {
        const live = deps.agents.get(id);
        if (live) return { name: live.info.name };
        const past = history[id];
        if (!past) return { name: id };
        return { name: past.name, killed: Boolean(past.killedAt) };
      };
      deps.addLogEntry(
        agentId,
        "system",
        renderStorageReport(
          i18n,
          // Per-agent detail and filesystem paths are owner-only, exactly as
          // on the route.
          user.role === "owner" ? usage : aggregateOnly(usage),
          { agentLabel },
        ),
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },
  };

  for (const [name, cfg] of Object.entries(commands)) {
    if (cfg.supported && cfg.handler && !commandHandlers[cfg.handler]) {
      throw new Error(
        `Command /${name} is marked supported with handler "${cfg.handler}" but no handler exists`,
      );
    }
  }

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
    // commands skip the queue - which is right for immediate handlers like
    // /clear or /isomux-diff, but wrong for skills that actually run the
    // model. Multi-step pending flows still take the immediate path: the
    // user's reply during /resume etc. is a pick, not a skill.
    const state = managed.info.state;
    const busy =
      state === "thinking" ||
      state === "tool_executing" ||
      managed.sessionManager.pendingTurn !== null;
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
          translatorForUsername(username).t("commands.skill.queueFailed", {
            command: rawText,
            error: result.error,
          }),
        );
      }
      return true;
    }

    // A dormant agent (lazy-spawned, idle-evicted, or released by /clear) holds
    // no live session, so the runAgentTurn below would throw "agent has no
    // session". Wake it first - this is the skill-dispatch site, reached only
    // for an actual skill (control commands like /clear never get here), so the
    // no-auto-wake escape hatch on broken sessions stays intact. A genuinely-
    // broken (non-dormant) session is left to surface its own error.
    if (!managed.sessionManager.session && managed.info.dormant) {
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
        sdkText: prefixedSkillPrompt,
        humanInput: true,
      });
    } catch (err) {
      // runAgentTurn re-throws whatever the underlying turn threw and has
      // already cleaned up the pendingTurn deferred if session.send fell
      // before await turn. Per-site error semantics remain here.
      if (err instanceof SessionSwappedError) return true;
      deps.addLogEntry(
        agentId,
        "error",
        translatorForUsername(username).t("commands.skill.error", {
          error: errMessage(err),
        }),
      );
      deps.updateState(agentId, "error");
    }
    return true;
  }

  async function handleSlashCommand(
    agentId: string,
    managed: ManagedAgent,
    cmd: string,
    args: string[],
    rawText: string,
    username?: string,
    device?: string,
  ): Promise<boolean> {
    const { t } = translatorForUsername(username);
    const userMeta = buildMeta(username, device);
    const cfg: CommandConfig | undefined = commands[cmd];

    // Count the dispatched use under the invoking user - Sk-menu ranking
    // rides these counts. COMMANDS and skills both count (the
    // menu ranks across both), under the name as typed/picked; only actual
    // dispatches count (unknown/unsupported echoes don't), and senders with
    // no user record (agents/system) are skipped. Hidden command spellings
    // (autocomplete:false - /new, /reset) are skipped too: they can never
    // surface in the menu, so their counts would be dead data.
    const countUse = () => {
      if (!username) return;
      const user = getUserByName(username);
      if (user) recordSkillUse(user.id, cmd);
    };

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
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(t, cmd));
      return true;
    }

    const skillPrompt = resolveSkillPrompt(
      cmd,
      managed.info.cwd,
      deps.claudeConfigDirFor(managed),
    );
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
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(t, cmd));
      return true;
    }

    if (managed.sdkReportedCommands.includes(cmd)) {
      return false; // let sendMessage() pass it through
    }

    deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    deps.emitEphemeralLog(
      agentId,
      "system",
      t("commands.unsupported.unknownCommand", { name: cmd }),
    );
    return true;
  }

  return { commandHandlers, executeSkill, handleSlashCommand };
}
