// The Sk menu and member skill folders of each agent, and the environment of
// the member's OpenCode server that skill folders and session starts read.
// Moved out of createAgentManager (server/agent-manager.ts), which wires it.
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  AgentBackendType,
  AgentInfo,
  SkillInfo,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import type { ManagerDeps } from "./agent-manager.ts";
import { getAgentHost } from "./agent-host.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { openCodeUserConfigDir } from "./backends/opencode/config-layers.ts";
import { openCodeProfilePaths } from "./backends/opencode/profile-paths.ts";
import type { Backend } from "./backends/types.ts";
import { autocompleteCommands } from "./commands.ts";
import {
  buildEnvForUserId,
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
} from "./env-loader.ts";
import type { AgentEvent, ManagedAgent } from "./internal-types.ts";
import type { mcpServersForUserId } from "./mcp-servers.ts";
import {
  buildMemberSkillFolder,
  engineNativeSkillDirs,
  memberSkillFolderPath,
} from "./member-skill-folder.ts";
import { officeClaudeSourceRoot } from "./provider-skill-links.ts";
import type { SecretScope } from "./secret-store.ts";
import type { createSessionAccounts } from "./session-accounts.ts";
import { SKILL_ENGINES, type SkillEngineContext } from "./skill-catalog.ts";
import {
  BUNDLED_SKILLS_DIR,
  deduplicateSkills,
  discoverBundledSkills,
  discoverPluginSkills,
  discoverProjectSkills,
  discoverSyncedSkills,
  discoverUserSkills,
  userSkillFolders,
  type UserSkillRoot,
} from "./skills.ts";
import { listUsers } from "./users.ts";

type SessionAccounts = ReturnType<typeof createSessionAccounts>;

export interface AgentSkillsDeps {
  agents: Map<string, ManagedAgent>;
  emit: (event: AgentEvent) => void;
  getBackend: (agentType: AgentBackendType) => Backend;
  agentMcpServers: (
    userId: string | null | undefined,
  ) => ReturnType<typeof mcpServersForUserId>;
  claudeConfigDirFor: (managed: ManagedAgent) => string;
  userSkillRootsForInfo: (
    info: Pick<AgentInfo, "agentType" | "userId">,
    env: { [key: string]: string | undefined } | undefined,
  ) => UserSkillRoot[];
  buildSessionEnv: SessionAccounts["buildSessionEnv"];
  officeWanted: SessionAccounts["officeWanted"];
  providerSkillSourceRoots: ManagerDeps["providerSkillSourceRoots"];
  bundledSkillsDir: ManagerDeps["bundledSkillsDir"];
}

export function createAgentSkills(deps: AgentSkillsDeps) {
  const {
    agents,
    emit,
    getBackend,
    agentMcpServers,
    claudeConfigDirFor,
    userSkillRootsForInfo,
    buildSessionEnv,
    officeWanted,
  } = deps;

  // The member skill folder of one engine and provider root
  // (server/member-skill-folder.ts), built or updated now: the skills of the
  // Sk menu's user folders and the bundled skills that the engine does not
  // read by itself. Null in split mode (the box roots would be the server's
  // home, not the agent user's) and after a failure, which never blocks a
  // session start. `built` shares one build per folder across a refresh pass.
  function memberSkillFolderFor(
    info: Pick<AgentInfo, "agentType" | "userId">,
    env: { [key: string]: string | undefined } | undefined,
    built?: Map<string, string | null>,
  ): string | null {
    const host = getAgentHost();
    if (host.kind === "runner") return null;
    try {
      const engine = info.agentType;
      // The env and HOME the engine process gets. One OpenCode server serves
      // all of a member's OpenCode work: it runs in the member's profile
      // (HOME and XDG folders there, OPENCODE_CONFIG_DIR the member's own
      // config folder) and gets none of the member's OPENCODE_* flags
      // (openCodeServerEnvironment).
      let processEnv = env;
      let home = (env ?? host.baseEnv()).HOME || homedir();
      let providerRoot: string;
      if (engine === "opencode") {
        const launchEnv =
          buildOpenCodeLaunchEnvironmentForUserId(info.userId) ??
          host.baseEnv();
        const profile = openCodeProfilePaths(
          environmentSourceKeyForUserId(info.userId),
        );
        const userConfigDir = openCodeUserConfigDir(launchEnv);
        home = profile.home;
        providerRoot = profile.profileDir;
        processEnv = {
          XDG_CONFIG_HOME: profile.configHome,
          ...(existsSync(userConfigDir)
            ? { OPENCODE_CONFIG_DIR: userConfigDir }
            : {}),
        };
      } else
        providerRoot =
          engine === "claude"
            ? env?.CLAUDE_CONFIG_DIR ||
              deps.providerSkillSourceRoots?.claude ||
              join(homedir(), ".claude")
            : env?.CODEX_HOME || ISOMUX_CODEX_HOME;
      const folder = memberSkillFolderPath(info.userId, engine, providerRoot);
      const done = built?.get(folder);
      if (done !== undefined) return done;
      const nativeDirs = engineNativeSkillDirs(
        engine,
        engine === "claude"
          ? { ...processEnv, CLAUDE_CONFIG_DIR: providerRoot }
          : processEnv,
        home,
      );
      const given = buildMemberSkillFolder({
        engine,
        folder,
        userFolders: userSkillFolders(userSkillRootsForInfo(info, env)),
        bundledDir: deps.bundledSkillsDir ?? BUNDLED_SKILLS_DIR,
        nativeDirs,
      });
      built?.set(folder, given);
      return given;
    } catch (err) {
      console.error(
        `[skills] no member skill folder for a ${info.agentType} agent of ${info.userId ?? "the office"}:`,
        errMessage(err),
      );
      return null;
    }
  }

  // The skill folders OpenCode's own skill tool reads: the member's skill
  // folder. One OpenCode server serves all of a member's OpenCode work, so
  // only the member's inputs go in, and every path that can start that
  // server passes them: a server started without them is replaced at the
  // next agent session. Undefined in split mode.
  function openCodeSkillPathsForUserId(
    userId: string | null | undefined,
    built?: Map<string, string | null>,
  ): string[] | undefined {
    userId ??= null;
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(userId);
    } catch {
      env = undefined;
    }
    const folder = memberSkillFolderFor(
      { agentType: "opencode", userId },
      env,
      built,
    );
    return folder ? [folder] : undefined;
  }

  // A scheduled run's member skill folder: the member's env, as the run's.
  function skillFolderForUserId(
    agentType: "claude" | "codex",
    userId: string | null | undefined,
  ): string | null {
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(userId ?? null);
    } catch {
      return null;
    }
    return memberSkillFolderFor({ agentType, userId: userId ?? null }, env);
  }

  function openCodeSkillInput(
    agentType: AgentBackendType,
    userId: string | null | undefined,
  ): { skillPaths?: string[] } {
    if (agentType !== "opencode") return {};
    const skillPaths = openCodeSkillPathsForUserId(userId);
    return skillPaths ? { skillPaths } : {};
  }

  function userSkillRootsFor(managed: ManagedAgent): UserSkillRoot[] {
    return userSkillRootsForInfo(managed.info, buildSessionEnv(managed));
  }

  // The agent's skills in priority order, deduplicated by name (highest
  // priority wins). The Sk menu lists these.
  function discoverSkillsFor(managed: ManagedAgent): SkillInfo[] {
    const claudeConfigDir = claudeConfigDirFor(managed);
    const found = [
      ...discoverUserSkills(userSkillRootsFor(managed)),
      ...discoverProjectSkills(managed.info.cwd, managed.info.agentType),
      // Only Claude loads plugin skills.
      ...(managed.info.agentType === "claude"
        ? discoverPluginSkills(
            claudeConfigDir,
            managed.info.cwd,
            managed.reportedPlugins,
          )
        : []),
      ...discoverBundledSkills(),
    ];
    const listed = new Set([
      ...found.map((skill) => skill.name),
      ...autocompleteCommands(managed.info.agentType).map((c) => c.name),
    ]);
    return deduplicateSkills([
      ...found,
      // Account-synced skills are Claude's too.
      ...(managed.info.agentType === "claude"
        ? discoverSyncedSkills(claudeConfigDir, managed.reportedSkills, listed)
        : []),
    ]);
  }

  // The live session's command rows, for the account's skills in the menu.
  // Rows that arrive after the session was replaced describe a process that
  // is gone.
  function listSessionCommands(agentId: string, managed: ManagedAgent): void {
    const session = managed.sessionManager.session;
    if (!session?.listCommands) return;
    session
      .listCommands()
      .then((rows) => {
        if (
          agents.get(agentId) !== managed ||
          managed.sessionManager.session !== session
        )
          return;
        managed.reportedSkills = rows;
        refreshSkillMenu(agentId);
      })
      .catch((err: unknown) => {
        console.error(`listCommands failed for ${agentId}:`, errMessage(err));
      });
  }

  // The live session's member skill folder, built again from the env its
  // session started with, so a skill added since reaches the engine's own
  // tool; Codex then reads its skill folders again. A dormant agent gets its
  // folder at its next session start.
  function refreshSkillFolder(
    managed: ManagedAgent,
    built: Map<string, string | null>,
  ): void {
    const session = managed.sessionManager.session;
    if (!session) return;
    if (managed.info.agentType === "opencode") {
      openCodeSkillPathsForUserId(managed.info.userId, built);
      return;
    }
    if (!managed.launchedSkillFolder) return;
    memberSkillFolderFor(managed.info, managed.launchedSkillEnv, built);
    void session.reloadSkills?.().catch((err: unknown) => {
      console.error(
        `[skills] reloadSkills failed for ${managed.info.id}:`,
        errMessage(err),
      );
    });
  }

  // The agent's Sk menu, discovered again now and sent to clients, and its
  // member skill folder brought up to date. `built` shares one folder build
  // across a refresh of many agents.
  function refreshSkillMenu(
    agentId: string,
    built: Map<string, string | null> = new Map(),
  ): void {
    const managed = agents.get(agentId);
    if (!managed) return;
    refreshSkillFolder(managed, built);
    let skills: SkillInfo[];
    try {
      skills = discoverSkillsFor(managed);
    } catch {
      return;
    }
    managed.skills = skills;
    emit({
      type: "slash_commands",
      agentId,
      commands: managed.slashCommands,
      skills,
    });
  }

  // A skill created, saved or deleted on the skills page reaches every agent's Sk menu
  // now instead of at the agent's next session start.
  function refreshSkillMenus(): void {
    const built = new Map<string, string | null>();
    for (const agentId of agents.keys()) refreshSkillMenu(agentId, built);
  }

  // What the skills page needs to list what agents run, per engine: the user
  // roots and plugin root an agent of this user gets on that engine (the same
  // environment discovery uses at spawn), and the working folders of the
  // agents on that engine that `visible` admits.
  function skillEngineContexts(
    userId: string | null,
    visible: (info: AgentInfo) => boolean,
  ): SkillEngineContext[] {
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildEnvForUserId(userId);
    } catch {
      env = undefined;
    }
    const infos = [...agents.values()]
      .map((managed) => managed.info)
      .filter(visible);
    return SKILL_ENGINES.map((engine) => ({
      engine,
      userRoots: userSkillRootsForInfo({ agentType: engine, userId }, env),
      pluginRoot: env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      cwds: infos
        .filter((info) => info.agentType === engine)
        .map((info) => info.cwd),
    }));
  }

  // The folder the skills page creates new skills in: the Claude source root
  // discovery and personal-home linking use (officeClaudeSourceRoot in
  // production), so a new skill shows for every engine.
  function newSkillDir(): string {
    return join(
      deps.providerSkillSourceRoots?.claude ?? officeClaudeSourceRoot(),
      "skills",
    );
  }

  // The only author of the environment used to launch a shared OpenCode
  // server. Discovery and agent sessions both call this boundary, so whichever
  // one reaches a cold profile first supplies identical process input. The
  // start-server spawn builder applies the final OPENCODE_* and agent-token
  // stripping before exec.
  function buildOpenCodeLaunchEnvironmentForUserId(
    userId: string | null | undefined,
  ): { [key: string]: string | undefined } | undefined {
    const env = buildEnvForUserId(userId);
    // A member on the office sign-in (server/provider-fallback.ts): one
    // server serves all of the member's OpenCode work, so all of it moves.
    const wanted = officeWanted(userId, "opencode", undefined);
    if (wanted && "apiKey" in wanted.office)
      return {
        ...(env ?? getAgentHost().baseEnv()),
        OPENCODE_API_KEY: wanted.office.apiKey,
      };
    return env;
  }

  // The environment revision an agent's sessions pass.
  function sessionEnvironmentRevision(managed: ManagedAgent): string {
    return managed.info.agentType === "opencode"
      ? openCodeEnvironmentRevisionForUserId(managed.info.userId)
      : environmentSourceRevisionForUserId(managed.info.userId);
  }

  // The environment revision of the member's OpenCode server: a new one when
  // the server must start again on the other key.
  function openCodeEnvironmentRevisionForUserId(
    userId: string | null | undefined,
  ): string {
    const revision = environmentSourceRevisionForUserId(userId);
    return officeWanted(userId, "opencode", undefined)
      ? `${revision}:office-fallback`
      : revision;
  }

  // A saved env variable, secret or MCP server in `scope` (an office save
  // reaches every member) goes to each existing OpenCode server now, with the
  // inputs a session start passes. A failure is logged and never fails the
  // save.
  function pushOpenCodeSettings(scope: SecretScope): void {
    try {
      const userIds: (string | null)[] =
        scope.kind === "user"
          ? [scope.userId]
          : [null, ...listUsers().map((user) => user.id)];
      // Each owner has a key of their own; the set only guards a repeat.
      const pushed = new Set<string>();
      for (const userId of userIds) {
        const key = environmentSourceKeyForUserId(userId);
        if (pushed.has(key)) continue;
        pushed.add(key);
        getBackend("opencode").updateSavedSettings?.({
          environmentKey: key,
          env: buildOpenCodeLaunchEnvironmentForUserId(userId),
          environmentRevision: openCodeEnvironmentRevisionForUserId(userId),
          mcpServers: agentMcpServers(userId),
        });
      }
    } catch {
      console.error("[opencode] Saved settings did not reach the server.");
    }
  }

  // Error-path env build for diagnostic hints. Resume preflights deliberately
  // fail loudly on an environment load error (an agent expecting custom creds must not
  // silently fall through to host creds). Hint generators are different: they
  // annotate an already-failed backend error, and an environment load error here would
  // mask the real cause. Swallow and return undefined - the hint just falls back
  // to inspecting the default ~/.claude path, which is the worst-case-correct
  // behavior when we can't resolve user env.
  function envForHints(
    managed: ManagedAgent,
  ): { [key: string]: string | undefined } | undefined {
    try {
      return buildSessionEnv(managed);
    } catch {
      return undefined;
    }
  }

  return {
    memberSkillFolderFor,
    openCodeSkillPathsForUserId,
    skillFolderForUserId,
    openCodeSkillInput,
    userSkillRootsFor,
    discoverSkillsFor,
    listSessionCommands,
    refreshSkillMenu,
    refreshSkillMenus,
    skillEngineContexts,
    newSkillDir,
    buildOpenCodeLaunchEnvironmentForUserId,
    sessionEnvironmentRevision,
    openCodeEnvironmentRevisionForUserId,
    pushOpenCodeSettings,
    envForHints,
  };
}
