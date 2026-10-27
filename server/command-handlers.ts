import type {
  Attachment,
  AgentInfo,
  AgentChoiceInteractionKind,
  AgentState,
  LogEntry,
  OfficeSettings,
  QueuedMessage,
  RoomWire,
  SessionInfo,
} from "../shared/types.ts";
import { ENGINE_NAMES } from "../shared/types.ts";
import { sessionResumeLabel } from "../shared/session-label.ts";
import { isBackSeat } from "../shared/desks.ts";
import { english } from "./i18n.ts";
import { errorText } from "./localized-error.ts";
import { getUserByName } from "./users.ts";
import {
  joinLogText,
  logParts,
  msg,
  renderLogText,
  type ChoiceInput,
  type LogMessage,
  type LogPart,
  type LogText,
} from "../shared/i18n/log-message.ts";
import { COMMAND_DESCRIPTION_KEYS } from "../shared/i18n/command-keys.ts";
import { keyFrom } from "../shared/i18n/translate.ts";
import type { OfficeEvent } from "../shared/office-state.ts";
import {
  effortLevelsFor,
  familyDisplayLabel,
  effortLabelParam,
  knownModelFamiliesFor,
} from "../shared/types.ts";
import { formatPrefix } from "../shared/identity.ts";
import { listAgentSessions, loadAgentHistory } from "./persistence.ts";
import { tildifyCwd } from "./cwd-utils.ts";
import {
  commands,
  runsOnEngine,
  unsupportedMessage,
  type CommandConfig,
} from "./commands.ts";
import { listCronjobs } from "./cronjob-manager.ts";
import { cronjobVisibleTo } from "./cronjob-visibility.ts";
import { resolveSkillPrompt, type UserSkillRoot } from "./skills.ts";
import { rewriteOpenCodeOfficeCommands } from "./system-prompt.ts";
import { recordSkillUse } from "./skill-usage.ts";
import { renderUsageReport, usageAudienceForUser } from "./usage-report.ts";
import { aggregateOnly, type StorageUsage } from "./storage-usage.ts";
import { renderStorageReport, type AgentLabel } from "./storage-report.ts";
import { getAgentHost } from "./agent-host.ts";
import {
  resolveEditorPath,
  openFile as openEditorFile,
} from "./file-editor.ts";
import {
  SessionSwappedError,
  inMultiStepFlow,
  type ManagedAgent,
  type ManualHandoffRequest,
  type AgentEvent,
  type EnqueueResult,
} from "./internal-types.ts";
import { runAgentTurn } from "./agent-turn.ts";
import type { SessionPluginReload } from "./backends/types.ts";
import { directInputCapped } from "./member-usage-cap.ts";
import { modelListingLabel } from "./model-listing-label.ts";

export const DOCS_URL = "https://isomux.com/docs";
// The Skills page route (ui/routes.ts). Relative, so it opens on the office
// the reader is on.
export const SKILLS_PAGE_PATH = "/skills";
const EDIT_USAGE = "`/isomux-edit <path>`";
type HandlerFn = (
  agentId: string,
  managed: ManagedAgent,
  args: string[],
  rawText: string,
  username?: string,
  device?: string,
) => Promise<boolean>;

// The leading newline is layout, so it stays in code; only the sentence is
// a message.
function choiceInstruction(kind: AgentChoiceInteractionKind): LogPart[] {
  if (kind === "resume") return ["\n", msg("choices.resume.instruction")];
  if (kind === "cronjob") return ["\n", msg("choices.cronjob.instruction")];
  return ["\n", msg("choices.model.instruction")];
}

// One numbered row of a picker's typed-reply fallback.
function choiceLine(choice: ChoiceInput, index: number): LogPart[] {
  return joinLogText([
    `  ${index + 1}. `,
    choice.label,
    choice.current ? [" ", msg("common.current")] : "",
  ]);
}

// A session's label in a /resume list: its topic or first message, else the
// catalog's word for a conversation with neither.
function resumeLabel(
  session: Pick<SessionInfo, "topic" | "firstUserMessage">,
): LogText {
  return sessionResumeLabel(session, "") || msg("common.untitledConversation");
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
type AliasItem = { name: string; description?: LogText; aliasFor?: string };
type AliasGroup = { names: string[]; description?: LogText };
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
function formatAliasGroup(names: string[], description?: LogText): LogPart[] {
  const sorted = [...names].sort((a, b) => a.length - b.length);
  const primary = `\`/${sorted[0]}\``;
  const others = sorted.slice(1).map((n) => `\`/${n}\``);
  const head =
    others.length > 0
      ? msg("commands.help.aliasGroup", { primary, others: others.join(", ") })
      : primary;
  return joinLogText([
    "  ",
    head,
    description ? [" - ", ...logParts(description)] : "",
  ]);
}

// What a slash command became. true: handled here, nothing goes to the
// engine. false: not handled; sendMessage sends the text as a normal message.
// "native": the engine runs it (CommandConfig.native, or a command the engine
// reports); sendMessage sends the text exactly as typed, or queues it as a
// native item while the agent is busy.
export type SlashCommandResult = boolean | "native";

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
    content: LogText,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
    extra?: Partial<Pick<LogEntry, "diff" | "file" | "terminal">>,
  ) => void;
  emitEphemeralLog: (
    agentId: string,
    kind: LogEntry["kind"],
    content: LogText,
    metadata?: Record<string, unknown>,
    extra?: Partial<Pick<LogEntry, "diff" | "file">>,
  ) => void;
  updateState: (agentId: string, state: AgentState) => void;
  updateAgent: (agentId: string, changes: Partial<AgentInfo>) => OfficeEvent[];
  beginTurn: (agentId: string, opts: { memberIds: string[] }) => void;
  openChoiceInteraction: (
    agentId: string,
    kind: AgentChoiceInteractionKind,
    title: LogText,
    instruction: LogText,
    choices: readonly ChoiceInput[],
  ) => void;

  // Login-instructions helper. Wraps agentLoginInstructions + per-backend
  // dispatch in agent-manager so the /login handler can render the same
  // explanatory text + [Copy to terminal] cards an auth-error path would.
  emitLoginInstructionsFor: (
    agentId: string,
    managed: ManagedAgent,
    // The person who typed /login: their role decides whether they get the
    // office sign-in.
    username?: string,
  ) => void;
  emitLogoutAffordanceFor: (
    agentId: string,
    managed: ManagedAgent,
    username?: string,
  ) => Promise<void>;

  // POST new-conversation's reset, which the typed /clear (also /reset, /new)
  // runs too. `typed` leaves out the "New conversation started." line: the
  // empty chat is the confirmation (Nil, 2026-09-13).
  newConversation: (agentId: string, opts: { typed: true }) => Promise<void>;
  // The typed /handoff: echoes `rawText`, then arms the server's handoff (one
  // brief turn, then a fresh session with the brief), or writes the line that
  // says why not. agent-manager requestHandoff.
  requestHandoff: (
    agentId: string,
    rawText: string,
    request: ManualHandoffRequest,
  ) => void;
  persistAll: () => void;
  // A skill turn a session swap cut before the backend took it goes back in
  // the queue for the next session (agent-manager requeueSwappedSend).
  // Returns whether `err` was that case.
  requeueSwappedSend: (
    agentId: string,
    err: unknown,
    msg: { text: string; sdkText: string; username?: string; device?: string },
  ) => boolean;
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
  // The account check at a turn start (server/provider-fallback.ts): moves
  // the agent to the sign-in its member's fallback wants before the turn
  // takes the session.
  // null when there is nothing to check.
  alignAccount: (
    agentId: string,
    managed: ManagedAgent,
  ) => Promise<unknown> | null;
  // A rejected turn, after the caller handled its session swaps: the same
  // lines and end state as a member's send (agent-manager ownedTurnFailure).
  // `frame` words an error it cannot classify.
  turnFailure: (
    agentId: string,
    managed: ManagedAgent,
    err: unknown,
    opts: {
      username?: string;
      label: string;
      frame: (error: LogMessage | string) => LogText;
    },
  ) => void;
  // The office's disk-usage measurement, FULL (per-agent detail included) -
  // the same call GET /api/storage/usage makes, memoized for 30s. Injected
  // rather than imported so the /isomux-storage access-control branches can be
  // pinned without walking a real state root, and so the refusal path can be
  // proven not to measure at all.
  getStorageUsage: () => StorageUsage;
  userSkillRootsFor: (managed: ManagedAgent) => UserSkillRoot[];
  claudeConfigDirFor: (managed: ManagedAgent) => string;
  // The Claude families limited in the agent owner's env (env-loader
  // limitedClaudeFamiliesForUserId).
  limitedClaudeFamiliesFor: (managed: ManagedAgent) => string[];
  // Whether the agent's engine has a native plan mode.
  planModeAvailable: (managed: ManagedAgent) => boolean;
  // Turns the engine's plan mode on or off: the live session now, and every
  // later session through ManagedAgent.planMode. Rejects when the engine
  // refuses, leaving the flag as it was.
  setPlanMode: (managed: ManagedAgent, on: boolean) => Promise<void>;
  // The agent's Sk menu, discovered again now and sent to clients.
  refreshSkillMenu: (agentId: string) => void;
  // Asks the agent's engine to load its plugins and config again. Throws
  // when the engine has no reload.
  reloadEnginePlugins: (
    managed: ManagedAgent,
  ) => Promise<"reloaded" | "pending">;
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

// The agent runs a turn, or is about to. An armed automatic handoff counts
// as busy, as in sendMessage.
function turnRunning(managed: ManagedAgent): boolean {
  const state = managed.info.state;
  return (
    state === "thinking" ||
    state === "tool_executing" ||
    managed.sessionManager.pendingTurn !== null ||
    managed.autoHandoffPhase !== null
  );
}

export function createCommandHandling(deps: HandlerDeps) {
  const commandHandlers: Record<string, HandlerFn> = {
    async clear(agentId, _managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      // The same reset as POST new-conversation: the agent goes dormant until
      // the next message, and the queue goes to the fresh session.
      try {
        await deps.newConversation(agentId, { typed: true });
      } catch (err) {
        deps.emitEphemeralLog(
          agentId,
          "error",
          msg("commands.clear.failed", { error: errorText(err) }),
        );
        deps.updateState(agentId, "error");
      }
      return true;
    },

    async handoff(agentId, _managed, args, rawText, username, device) {
      const note = args.join(" ");
      deps.requestHandoff(agentId, rawText, {
        ...(username ? { username } : {}),
        ...(device ? { device } : {}),
        ...(note ? { note } : {}),
      });
      return true;
    },

    async context(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      const headerLines = (u: {
        model: string;
        totalTokens: number;
        maxTokens: number;
        percentage: number;
      }): LogText[] => {
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
          msg("commands.context.header", {
            model: u.model,
            used: { number: u.totalTokens },
            max: { number: u.maxTokens },
            percent: pct,
          }),
          `\`${bar}\``,
        ];
      };
      // No live session (released while idle, or never started), or the live
      // read fails: fall back to the last committed snapshot - the same
      // reading the battery pill shows. Reading the snapshot
      // does NOT wake a dormant session.
      const snapshotFallback = (
        note?: (age: LogMessage) => LogMessage,
      ): boolean => {
        const snap = managed.contextUsage;
        if (!snap) return false;
        const lines: LogText[] = [...headerLines(snap)];
        if (note) {
          const ageMs = Date.now() - snap.sampledAtMs;
          const ageMin = Math.round(ageMs / 60_000);
          const age =
            ageMin < 1
              ? msg("commands.context.ageUnderMinute")
              : ageMin < 60
                ? msg("commands.context.ageMinutes", { minutes: ageMin })
                : msg("commands.context.ageHoursMinutes", {
                    hours: Math.floor(ageMin / 60),
                    minutes: ageMin % 60,
                  });
          lines.push("", note(age));
        }
        deps.addLogEntry(agentId, "system", joinLogText(lines, "\n"));
        return true;
      };
      if (!managed.sessionManager.session) {
        // Released-while-idle renders IDENTICALLY to the live case (no
        // lifecycle note - remaining context doesn't change when the session
        // process is released).
        if (snapshotFallback()) return true;
        deps.addLogEntry(agentId, "system", msg("commands.context.noSession"));
        return true;
      }
      try {
        const ctx = await managed.sessionManager.session.getContextUsage();
        if (!ctx) {
          if (
            snapshotFallback((age) =>
              msg("commands.context.staleUnavailable", { age }),
            )
          )
            return true;
          deps.addLogEntry(
            agentId,
            "system",
            msg("commands.context.unavailable"),
          );
          return true;
        }
        const lines: LogText[] = [...headerLines(ctx)];

        if ((ctx.categories?.length ?? 0) > 0 && ctx.categories) {
          lines.push("");
          for (const cat of ctx.categories) {
            if (cat.tokens > 0) {
              const catPct = (cat.tokens / ctx.maxTokens) * 100;
              lines.push([
                "  ",
                msg("commands.context.category", {
                  name: cat.name,
                  tokens: { number: cat.tokens },
                  percent: { number: catPct, digits: 1 },
                }),
              ]);
            }
          }
        }

        if ((ctx.memoryFiles?.length ?? 0) > 0 && ctx.memoryFiles) {
          lines.push(["\n", msg("commands.context.memoryFiles")]);
          for (const f of ctx.memoryFiles) {
            lines.push([
              "  ",
              msg("commands.context.memoryFile", {
                path: f.path,
                tokens: { number: f.tokens },
              }),
            ]);
          }
        }

        if (
          (ctx.systemPromptSections?.length ?? 0) > 0 &&
          ctx.systemPromptSections
        ) {
          lines.push(["\n", msg("commands.context.systemPrompt")]);
          for (const s of ctx.systemPromptSections) {
            lines.push([
              "  ",
              msg("commands.context.systemPromptSection", {
                name: s.name,
                tokens: { number: s.tokens },
              }),
            ]);
          }
        }

        if (ctx.isAutoCompactEnabled && ctx.autoCompactThreshold) {
          const compactPct = Math.round(
            (ctx.autoCompactThreshold / ctx.maxTokens) * 100,
          );
          lines.push([
            "\n",
            msg("commands.context.autoCompact", {
              percent: compactPct,
              tokens: { number: ctx.autoCompactThreshold },
            }),
          ]);
        }

        deps.addLogEntry(agentId, "system", joinLogText(lines, "\n"));
      } catch (err) {
        if (
          snapshotFallback((age) =>
            msg("commands.context.staleFailed", { age }),
          )
        )
          return true;
        deps.addLogEntry(
          agentId,
          "system",
          msg("commands.context.failed", { error: errorText(err) }),
        );
      }
      return true;
    },

    async help(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);

      // The Receptionist pointer and the docs link lead: anything conceptual is
      // a question for the Receptionist, so a reader meets that before the
      // reference material they came for.
      const lines: LogText[] = [
        msg("commands.help.receptionist"),
        msg("commands.help.docs", { url: DOCS_URL }),
        // Skills are listed on the Skills page, not here (Nil, 2026-10-12).
        msg("commands.help.skills", { url: SKILLS_PAGE_PATH }),
      ];

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
            description: key ? msg(key) : c.description,
            aliasFor: c.aliasFor,
          };
        }),
      );
      const cmdList = joinLogText(
        cmdGroups.map((g) => formatAliasGroup(g.names, g.description)),
        "\n",
      );
      lines.push(joinLogText([msg("commands.help.commands"), "\n", cmdList]));

      // The body is English for agents and older clients, and its parts are
      // worded by each reader's UI (helpContentMessage, task c37a7365).
      const body = joinLogText(lines, "\n");
      deps.addLogEntry(agentId, "system", msg("commands.help.header"), {
        helpContent: renderLogText(english, body),
        helpContentMessage: body,
      });
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async resume(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      const sessions = listAgentSessions(agentId);
      if (sessions.length === 0) {
        deps.emitEphemeralLog(agentId, "system", msg("commands.resume.none"));
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const lines: LogText[] = [[msg("commands.resume.header"), "\n"]];
      const pickable: typeof sessions = [];
      for (const s of sessions.slice(0, 20)) {
        const date = msg("common.date", {
          date: { time: s.lastModified, shape: "monthDayTime" },
        });
        const label = joinLogText([s.forked ? "↳ " : "", resumeLabel(s)]);
        // cwd is a property of the session - surface it so the user sees which
        // directory each session will resume into (it can differ per session).
        // Abbreviate the home prefix to `~` to save horizontal space.
        const cwdStr = s.cwd ? `  ${tildifyCwd(s.cwd)}` : "";
        if (s.sessionId === managed.sessionManager.sessionId) {
          lines.push(
            joinLogText([
              "  ● ",
              label,
              "  ",
              date,
              `${cwdStr}  `,
              msg("common.current"),
            ]),
          );
        } else {
          lines.push(
            joinLogText([
              `  ${pickable.length + 1}. `,
              label,
              "  ",
              date,
              cwdStr,
              s.branched ? ["  ", msg("commands.resume.branched")] : "",
            ]),
          );
          pickable.push(s);
        }
      }
      if (pickable.length === 0) {
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg("commands.resume.noOthers"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const instruction = choiceInstruction("resume");
      lines.push(instruction);
      managed.pendingResumeSessions = pickable;
      deps.emitEphemeralLog(agentId, "system", joinLogText(lines, "\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "resume",
        msg("choices.resume.title"),
        instruction,
        pickable.map((session) => {
          const cwd = session.cwd ? ` · ${tildifyCwd(session.cwd)}` : "";
          return {
            value: session.sessionId,
            label: joinLogText([
              session.forked ? "↳ " : "",
              resumeLabel(session),
            ]),
            description: joinLogText([
              msg("common.date", {
                date: { time: session.lastModified, shape: "monthDayTime" },
              }),
              cwd,
              session.branched ? [" · ", msg("choices.resume.branched")] : "",
            ]),
          };
        }),
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async model(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      if (managed.info.agentType === "opencode") {
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg("commands.model.openCodeUnsupported"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const models = managed.info.claudeFamilyModels;
      const currentLabel = familyDisplayLabel(managed.info.modelFamily, models);
      const lines: LogText[] = [
        [msg("commands.model.header", { current: currentLabel }), "\n"],
      ];
      const families = knownModelFamiliesFor(managed.info.agentType) ?? [];
      const choices = families.map((modelFamily) => ({
        value: modelFamily,
        label: familyDisplayLabel(modelFamily, models),
        current: modelFamily === managed.info.modelFamily,
      }));
      lines.push(...choices.map(choiceLine));
      const instruction = choiceInstruction("model");
      lines.push(instruction);
      deps.emitEphemeralLog(agentId, "system", joinLogText(lines, "\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "model",
        msg("choices.model.title"),
        instruction,
        choices,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async effort(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
      if (managed.info.agentType === "opencode") {
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg("commands.effort.openCodeSettings"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      // Backend/model-filtered list. The structured interaction carries each
      // level id, so a typed number and a card click resolve to the same value.
      const limited = deps.limitedClaudeFamiliesFor(managed);
      const levels = effortLevelsFor(
        managed.info.agentType,
        managed.info.modelFamily,
        limited,
      );
      if (levels.length === 0) {
        const model = familyDisplayLabel(
          managed.info.modelFamily,
          managed.info.claudeFamilyModels,
        );
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg("commands.effort.unsupported", { model }),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const lines: LogText[] = [
        [
          msg("commands.effort.header", {
            current: effortLabelParam(managed.info.effort),
          }),
          "\n",
        ],
      ];
      const choices = levels.map((effort) => ({
        value: effort.level,
        label: effortLabelParam(effort.level),
        current: effort.level === managed.info.effort,
      }));
      lines.push(...choices.map(choiceLine));
      const instruction = choiceInstruction("effort");
      lines.push(instruction);
      deps.emitEphemeralLog(agentId, "system", joinLogText(lines, "\n"), {
        interactionFallback: true,
      });
      deps.openChoiceInteraction(
        agentId,
        "effort",
        msg("choices.effort.title"),
        instruction,
        choices,
      );
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    // A live Claude session reloads its plugins in place and keeps the
    // conversation; its answer becomes the agent's plugin and command lists.
    // Without one, the next Claude process loads plugins fresh, so only the
    // menu is rebuilt. OpenCode loads plugins and config once per server, so
    // a member who edits one asks for a new server.
    async reloadPlugins(agentId, managed, _args, rawText, username, device) {
      deps.emitEphemeralLog(
        agentId,
        "user_message",
        rawText,
        buildMeta(username, device),
      );
      const engine = managed.info.agentType;
      const session = managed.sessionManager.session;
      if (engine === "claude" && session?.reloadPlugins) {
        if (turnRunning(managed)) {
          deps.emitEphemeralLog(
            agentId,
            "system",
            msg("commands.reloadPlugins.busy"),
          );
          return true;
        }
        // A /clear, /resume or engine switch during the reload: the answer
        // describes a process that is gone, and the next one loads plugins
        // fresh.
        const replaced = () => {
          if (managed.sessionManager.session === session) return false;
          deps.emitEphemeralLog(
            agentId,
            "system",
            msg("commands.reloadPlugins.nextMessage"),
          );
          return true;
        };
        let reload: SessionPluginReload;
        try {
          reload = await session.reloadPlugins();
        } catch (err) {
          if (replaced()) return true;
          deps.emitEphemeralLog(
            agentId,
            "error",
            msg("commands.reloadPlugins.failed", { error: errorText(err) }),
          );
          return true;
        }
        if (replaced()) return true;
        managed.reportedPlugins = reload.plugins;
        managed.reportedSkills = reload.commands;
        managed.sdkReportedCommands = reload.commands
          .map((command) => command.name)
          .filter((name) => !name.startsWith("mcp__"));
        deps.refreshSkillMenu(agentId);
        const lines: LogText[] = [
          msg(
            reload.toolsChanged
              ? "commands.reloadPlugins.reloadedToolsChanged"
              : "commands.reloadPlugins.reloaded",
          ),
        ];
        if (reload.errorCount > 0)
          lines.push(
            msg("commands.reloadPlugins.errors", { count: reload.errorCount }),
          );
        deps.emitEphemeralLog(agentId, "system", joinLogText(lines, "\n"));
        return true;
      }
      deps.refreshSkillMenu(agentId);
      if (engine !== "opencode") {
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg(
            engine === "claude"
              ? "commands.reloadPlugins.nextMessage"
              : "commands.reloadPlugins.menuRefreshed",
          ),
        );
        return true;
      }
      try {
        const outcome = await deps.reloadEnginePlugins(managed);
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg(
            outcome === "reloaded"
              ? "commands.reloadPlugins.done"
              : "commands.reloadPlugins.pending",
          ),
        );
      } catch (err) {
        deps.emitEphemeralLog(
          agentId,
          "error",
          msg("commands.reloadPlugins.failed", { error: errorText(err) }),
        );
      }
      return true;
    },

    // Toggles the engine's own plan mode. `/plan <text>` turns it on and sends
    // the text, as in Claude Code.
    async plan(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      const text = rawText.replace(/^\s*\/\S+/, "").trim();
      if (!deps.planModeAvailable(managed)) {
        deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
        deps.emitEphemeralLog(
          agentId,
          "system",
          msg("commands.plan.unavailable", {
            engine: ENGINE_NAMES[managed.info.agentType],
          }),
        );
        return true;
      }
      const on = text ? true : !managed.planMode;
      if (!text) deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      // `/plan <text>` while plan mode is on only sends the text.
      if (on !== (managed.planMode ?? false)) {
        try {
          await deps.setPlanMode(managed, on);
        } catch (err) {
          if (text)
            deps.addLogEntry(agentId, "user_message", rawText, userMeta);
          deps.addLogEntry(
            agentId,
            "error",
            msg("systemEntries.genericError", { error: errorText(err) }),
          );
          return true;
        }
        deps.addLogEntry(
          agentId,
          "system",
          msg(on ? "commands.plan.on" : "commands.plan.off"),
        );
      }
      if (!text) return true;
      return runCommandTurn(
        agentId,
        managed,
        text,
        rawText,
        "systemEntries.genericError",
        username,
        device,
      );
    },

    async isomuxAllHands(agentId, _managed, _args, rawText, username, device) {
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

      const lines: LogText[] = [];
      const sortedRooms = [...roomMap.keys()].sort((a, b) => a - b);

      for (const room of sortedRooms) {
        // A back room shows as one line, not one per agent: it can hold 100.
        const inRoom = roomMap.get(room)!;
        const backCount = inRoom.filter((a) => isBackSeat(a.info.desk)).length;
        const roomAgents = inRoom
          .filter((a) => !isBackSeat(a.info.desk))
          .sort((a, b) => a.info.desk - b.info.desk);
        lines.push(msg("commands.isomuxAllHands.room", { number: room + 1 }));
        lines.push("");

        for (const a of roomAgents) {
          const selfTag: LogText =
            a.info.id === agentId
              ? ["  ", msg("commands.isomuxAllHands.me")]
              : "";
          const modelLabel = modelListingLabel(
            a.info.agentType,
            a.info.modelFamily,
            a.info.claudeFamilyModels,
          );
          const topic = a.info.topic;
          const desk = msg("commands.isomuxAllHands.desk", {
            number: a.info.desk + 1,
          });
          const header = joinLogText([
            `**${a.info.name}** (`,
            desk,
            ")",
            selfTag,
            ` - ${modelLabel} - \`${a.info.cwd}\``,
          ]);
          if (topic) {
            lines.push(header);
            lines.push(["  ", msg("commands.isomuxAllHands.topic", { topic })]);
          } else {
            lines.push(
              joinLogText([
                '<span style="color: var(--text-dim)">',
                header,
                "</span>",
              ]),
            );
          }
          lines.push("");
        }
        if (backCount > 0) {
          lines.push(
            msg("commands.isomuxAllHands.backRoom", { count: backCount }),
          );
          lines.push("");
        }
      }

      lines.push(msg("commands.isomuxAllHands.footer"));

      deps.addLogEntry(agentId, "system", joinLogText(lines, "\n"));
      deps.updateState(agentId, "waiting_for_response");
      return true;
    },

    async isomuxSystemPrompt(
      agentId,
      _managed,
      _args,
      rawText,
      username,
      device,
    ) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      deps.addLogEntry(
        agentId,
        "system",
        msg("commands.isomuxSystemPrompt.header"),
        { systemPrompt: true },
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
      // Only jobs the typing user may see. The chat carries the job's name;
      // each reader's prompt button fetches the prompt with that reader's own
      // authority.
      const typer = username ? getUserByName(username) : undefined;
      const all = listCronjobs().filter((cronjob) =>
        cronjobVisibleTo(
          {
            makerUserId: cronjob.userId ?? null,
            liveRoomId:
              cronjob.roomId && deps.roomById(cronjob.roomId)
                ? cronjob.roomId
                : null,
          },
          {
            userId: typer?.id ?? null,
            isOfficeOwner: typer?.role === "owner",
            canRead: typer !== undefined,
            canManage: typer !== undefined,
            hasRoomAccess: (roomId) =>
              typer?.allowedRooms.includes(roomId) ?? false,
          },
        ),
      );

      if (!query) {
        if (all.length === 0) {
          deps.addLogEntry(
            agentId,
            "system",
            msg("commands.isomuxCronjobSystemPrompt.noSchedules"),
          );
          deps.updateState(agentId, "waiting_for_response");
          return true;
        }
        const instruction = choiceInstruction("cronjob");
        const lines: LogText[] = [
          msg("commands.isomuxCronjobSystemPrompt.pick"),
          "",
        ];
        for (const [index, cronjob] of all.entries()) {
          lines.push(`  ${index + 1}. ${cronjob.name}`);
        }
        lines.push(instruction);
        deps.emitEphemeralLog(agentId, "system", joinLogText(lines, "\n"), {
          interactionFallback: true,
        });
        deps.openChoiceInteraction(
          agentId,
          "cronjob",
          msg("choices.cronjob.title"),
          instruction,
          all.map((cronjob) => ({
            value: cronjob.id,
            label: cronjob.name,
          })),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const byId = all.find((c) => c.id === query);
      const byNameMatches = byId ? [] : all.filter((c) => c.name === query);
      const target =
        byId ?? (byNameMatches.length === 1 ? byNameMatches[0] : null);

      if (!target) {
        if (byNameMatches.length > 1) {
          const lines: LogText[] = [
            msg("commands.isomuxCronjobSystemPrompt.ambiguous", { query }),
          ];
          for (const c of byNameMatches) lines.push(`  \`${c.id}\``);
          deps.addLogEntry(agentId, "system", joinLogText(lines, "\n"));
        } else {
          deps.addLogEntry(
            agentId,
            "system",
            msg("commands.isomuxCronjobSystemPrompt.noMatch", { query }),
          );
        }
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }

      const header = msg("commands.isomuxCronjobSystemPrompt.header", {
        name: target.name,
      });
      deps.addLogEntry(agentId, "system", header, {
        systemPrompt: true,
        cronjobId: target.id,
      });
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
          msg("commands.isomuxEdit.usage", {
            usage: EDIT_USAGE,
            cwd: managed.info.cwd,
          }),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const resolved = resolveEditorPath(rawPath, managed.info.cwd);
      if (resolved.kind === "bad_path") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("commands.isomuxEdit.emptyPath"),
        );
        deps.updateState(agentId, "waiting_for_response");
        return true;
      }
      const probe = openEditorFile(resolved.path);
      if (probe.kind === "not_found") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.pathRefusal.notFound", { path: resolved.path }),
        );
      } else if (probe.kind === "not_file") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.pathRefusal.notFile", { path: resolved.path }),
        );
      } else if (probe.kind === "binary") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.pathRefusal.binary", { path: resolved.path }),
        );
      } else if (probe.kind === "too_large") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.pathRefusal.tooLarge", {
            path: resolved.path,
            size: { bytes: probe.size },
          }),
        );
      } else if (probe.kind === "io_error") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.fileOpenFailed", {
            path: resolved.path,
            message: probe.message,
          }),
        );
      } else if (probe.kind === "credential") {
        deps.addLogEntry(
          agentId,
          "system",
          msg("systemEntries.pathRefusal.credential", { path: resolved.path }),
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

      const result = await getAgentHost().isomuxDiff({
        dir: args[0],
        agentCwd: managed.info.cwd,
      });
      switch (result.kind) {
        case "bad_dir":
          deps.addLogEntry(
            agentId,
            "system",
            msg("commands.isomuxDiff.notDirectory", { path: result.attempted }),
          );
          break;
        case "not_repo":
          deps.addLogEntry(
            agentId,
            "system",
            msg("systemEntries.diffNotRepo", { path: result.cwd }),
          );
          break;
        case "git_error":
          deps.addLogEntry(agentId, "system", [
            msg("systemEntries.diffFailed", { path: result.cwd }),
            `\n\n\`\`\`\n${result.message}\n\`\`\``,
          ]);
          break;
        case "clean":
          deps.addLogEntry(
            agentId,
            "system",
            msg("systemEntries.diffClean", { path: result.cwd }),
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

    async usage(agentId, managed, _args, rawText, username, device) {
      const userMeta = buildMeta(username, device);
      deps.addLogEntry(agentId, "user_message", rawText, userMeta);
      deps.addLogEntry(
        agentId,
        "system",
        joinLogText(
          [
            msg(
              managed.info.agentType === "opencode"
                ? "commands.usage.unavailable"
                : "commands.usage.meter",
            ),
            "",
            msg("commands.usage.office"),
          ],
          "\n",
        ),
      );
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
          msg("commands.isomuxStorage.forbidden"),
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
    // An OpenCode agent has no bearer token: the skill's office calls go out
    // in its own form, as in its system prompt.
    const body =
      managed.info.agentType === "opencode"
        ? rewriteOpenCodeOfficeCommands(skillPrompt)
        : skillPrompt;
    const fullPrompt = userArgs ? `${body}\n\nUser context: ${userArgs}` : body;
    return runCommandTurn(
      agentId,
      managed,
      fullPrompt,
      rawText,
      "commands.skill.error",
      username,
      device,
    );
  }

  // Runs `fullPrompt` as a turn on behalf of a typed command, logged as the
  // command the member typed.
  async function runCommandTurn(
    agentId: string,
    managed: ManagedAgent,
    fullPrompt: string,
    rawText: string,
    errorKey: "commands.skill.error" | "systemEntries.genericError",
    username?: string,
    device?: string,
  ): Promise<boolean> {
    // If the agent is mid-turn, defer the skill via the queue instead of
    // calling session.send now. Otherwise createTurnDeferred below would
    // supersede the in-flight turn and reject it with "Superseded by a new
    // turn". sendMessage's own queueing gate (`!isSlash`) lets all slash
    // commands skip the queue - which is right for immediate handlers like
    // /clear or /isomux-diff, but wrong for skills that actually run the
    // model. Multi-step pending flows still take the immediate path: the
    // user's reply during /resume etc. is a pick, not a skill.
    if (turnRunning(managed) && !inMultiStepFlow(managed)) {
      const result = deps.enqueueMessage(agentId, {
        sender: { kind: "user", username, device },
        text: rawText,
        sdkText: fullPrompt,
      });
      if (!result.ok) {
        deps.addLogEntry(
          agentId,
          "system",
          msg("commands.skill.queueFailed", {
            command: rawText,
            error: result.error,
          }),
        );
      }
      return true;
    }

    const accountCheck = deps.alignAccount(agentId, managed);
    if (accountCheck) await accountCheck;
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
      const typerId = getUserByName(username)?.id;
      await runAgentTurn({
        managed,
        sdkText: prefixedSkillPrompt,
        memberIds: typerId ? [typerId] : [],
        usageCapped: directInputCapped(username),
        usageCapUsername: username,
      });
    } catch (err) {
      // runAgentTurn re-throws whatever the underlying turn threw and has
      // already cleaned up the pendingTurn deferred if session.send fell
      // before await turn. Per-site error semantics remain here.
      if (
        deps.requeueSwappedSend(agentId, err, {
          text: rawText,
          sdkText: fullPrompt,
          username,
          device,
        })
      )
        return true;
      if (err instanceof SessionSwappedError) return true;
      deps.turnFailure(agentId, managed, err, {
        username,
        label: "command",
        frame: (error) => msg(errorKey, { error }),
      });
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
  ): Promise<SlashCommandResult> {
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
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    const skillPrompt = resolveSkillPrompt(
      cmd,
      managed.info.cwd,
      managed.info.agentType,
      deps.userSkillRootsFor(managed),
      true,
      deps.claudeConfigDirFor(managed),
      managed.reportedPlugins,
      managed.reportedSkills,
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
      if (cfg.supported && cfg.native) {
        const engine = managed.info.agentType;
        if (!runsOnEngine(cfg, engine)) {
          deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
          deps.emitEphemeralLog(
            agentId,
            "system",
            msg("commands.unsupported.engine", {
              name: cmd,
              engines: (cfg.engines ?? [])
                .map((e) => ENGINE_NAMES[e])
                .join(", "),
            }),
          );
          return true;
        }
        if (cfg.autocomplete) countUse();
        return "native";
      }
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
      deps.emitEphemeralLog(agentId, "system", unsupportedMessage(cmd));
      return true;
    }

    // A command the engine reports and Isomux does not handle runs in the
    // engine, as a native command does.
    if (managed.sdkReportedCommands.includes(cmd)) return "native";

    deps.emitEphemeralLog(agentId, "user_message", rawText, userMeta);
    deps.emitEphemeralLog(
      agentId,
      "system",
      msg("commands.unsupported.unknownCommand", { name: cmd }),
    );
    return true;
  }

  return { commandHandlers, executeSkill, handleSlashCommand };
}
