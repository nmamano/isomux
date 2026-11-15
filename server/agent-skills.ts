// The Sk menu and member skill folders of each agent, and the environment of
// the member's OpenCode server that skill folders and session starts read.
// Moved out of createAgentManager (server/agent-manager.ts), which wires it.
import { hostFor } from "./member-hosts.ts";
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
import { officeAgentHost } from "./agent-host.ts";
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
  memberSpaceSkillFolderPath,
} from "./member-skill-folder.ts";
import {
  createMemberSkillFolders,
  type MemberSkillFolderInput,
} from "./member-skill-folder-host.ts";
import type { AgentHost } from "./agent-host.ts";
import { agentAccessOf, belowStandard } from "../shared/agent-access.ts";
import {
  claudeConfigDirOf,
  codexUserHomeOf,
  officeClaudeSourceRoot,
} from "./provider-skill-links.ts";
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
  rootSkillFolders,
  userSkillFolders,
  type UserSkillRoot,
} from "./skills.ts";
import { listUsers } from "./users.ts";
import { memberFolderHost } from "./agent-folder.ts";
import {
  fetchProjectSkillList,
  projectSkillInfos,
} from "./member-project-skills.ts";
import {
  fetchUserSkillLists,
  userSkillInfos,
  type UserSkillLists,
  type UserSkillScanInput,
} from "./member-user-skills.ts";

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
    const host = hostFor(info.userId);
    if (host.member !== undefined)
      return memberSpaceSkillFolderFor(info, env, host, built !== undefined);
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
              claudeConfigDirOf()
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

  // An isolated member's skill folders, built by their runner in their
  // agent space (member-skill-folder-host.ts).
  const memberSkillFolders = createMemberSkillFolders();

  // What the member's runner builds the folder from: their own folders and
  // the engine's, as strings. Null when their host has no home (not ready)
  // or no env.
  function memberSkillFolderInput(
    info: Pick<AgentInfo, "agentType" | "userId">,
    env: { [key: string]: string | undefined } | undefined,
    host: AgentHost,
  ): MemberSkillFolderInput | null {
    const engine = info.agentType;
    if (!env || !info.userId) return null;
    let home: string;
    let agentRoot: string;
    try {
      home = env.HOME || host.home();
      agentRoot = host.agentRoot();
    } catch {
      return null;
    }
    const userFolders = rootSkillFolders(userSkillRootsForInfo(info, env));
    if (engine === "opencode") {
      // As the office path below: the member's one OpenCode server runs in
      // their profile; only the runner can see whether their config folder
      // is there.
      const launchEnv =
        buildOpenCodeLaunchEnvironmentForUserId(info.userId) ?? env;
      const profile = openCodeProfilePaths(
        environmentSourceKeyForUserId(info.userId),
      );
      const configDir = openCodeUserConfigDir(launchEnv);
      const base = { XDG_CONFIG_HOME: profile.configHome };
      return {
        engine,
        agentRoot,
        folder: memberSpaceSkillFolderPath(
          agentRoot,
          engine,
          profile.profileDir,
        ),
        userFolders,
        nativeDirs: [],
        openCodeConfig: {
          dir: configDir,
          ifThere: engineNativeSkillDirs(
            engine,
            { ...base, OPENCODE_CONFIG_DIR: configDir },
            profile.home,
          ),
          otherwise: engineNativeSkillDirs(engine, base, profile.home),
        },
      };
    }
    const providerRoot =
      engine === "claude" ? claudeConfigDirOf(env) : codexUserHomeOf(env);
    return {
      engine,
      agentRoot,
      folder: memberSpaceSkillFolderPath(agentRoot, engine, providerRoot),
      userFolders,
      nativeDirs: engineNativeSkillDirs(
        engine,
        engine === "claude"
          ? { ...env, CLAUDE_CONFIG_DIR: providerRoot }
          : { ...env, CODEX_HOME: providerRoot },
        home,
      ),
    };
  }

  // The path of an isolated member's folder for a session: only after their
  // runner's build for this input answered; else null, and a build starts.
  // A refresh pass (`rebuild`) builds again, so a skill added since reaches
  // the folder.
  function memberSpaceSkillFolderFor(
    info: Pick<AgentInfo, "agentType" | "userId">,
    env: { [key: string]: string | undefined } | undefined,
    host: AgentHost,
    rebuild: boolean,
  ): string | null {
    const input = memberSkillFolderInput(info, env, host);
    if (!input || !info.userId) return null;
    return memberSkillFolders.pathFor(host, info.userId, input, rebuild);
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
    // An isolated member's runs come with slice 3; until then they run as
    // the office user, who cannot read their agent space.
    if (memberFolderHost(userId)) return null;
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

  // The project skills of an isolated member's agent, as their runner last
  // listed them for the agent's folder and engine (member-project-skills.ts):
  // the office cannot read the folder, and never reads a path from it.
  const memberProjectSkills = new Map<
    string,
    { cwd: string; engine: AgentBackendType; skills: SkillInfo[] }
  >();
  // The list request in flight per agent, by folder and engine.
  const projectSkillsInFlight = new Map<string, string>();

  // The agent's project skills for the menu. For an isolated member, the
  // cached list of the agent's current folder and engine, empty until the
  // runner answers (refreshMemberProjectSkills).
  function projectSkillsFor(
    info: Pick<AgentInfo, "id" | "cwd" | "agentType" | "userId">,
  ): SkillInfo[] {
    if (!memberFolderHost(info.userId))
      return discoverProjectSkills(info.cwd, info.agentType);
    const cached = memberProjectSkills.get(info.id);
    return cached && cached.cwd === info.cwd && cached.engine === info.agentType
      ? cached.skills
      : [];
  }

  // Asks an isolated member's runner for the agent's project skills; the
  // answer goes into the cache and the menu. A failed call or a reply out of
  // shape leaves an empty list and one log line. An answer for a folder or
  // engine the agent no longer has is dropped.
  function refreshMemberProjectSkills(agentId: string): void {
    const managed = agents.get(agentId);
    if (!managed) return;
    const { cwd, agentType, userId } = managed.info;
    const host = memberFolderHost(userId);
    if (!host) return;
    const key = `${agentType}\0${cwd}`;
    if (projectSkillsInFlight.get(agentId) === key) return;
    projectSkillsInFlight.set(agentId, key);
    void fetchProjectSkillList(host, cwd, agentType).then((list) => {
      if (projectSkillsInFlight.get(agentId) === key)
        projectSkillsInFlight.delete(agentId);
      const now = agents.get(agentId);
      if (
        now !== managed ||
        now.info.cwd !== cwd ||
        now.info.agentType !== agentType
      )
        return;
      if (list === null)
        console.error(
          `[skills] ${agentId}: the member runner gave no project skill list for ${agentType}`,
        );
      memberProjectSkills.set(agentId, {
        cwd,
        engine: agentType,
        skills: projectSkillInfos(list ?? []),
      });
      applySkillMenu(agentId);
    });
  }

  function forgetMemberProjectSkills(agentId: string): void {
    memberProjectSkills.delete(agentId);
    projectSkillsInFlight.delete(agentId);
    memberUserSkills.delete(agentId);
    userSkillsInFlight.delete(agentId);
  }

  // What an isolated member's runner reads for the agent's user, plugin and
  // synced skills (member-user-skills.ts): the member's own roots, Claude
  // root and reported plugins, as strings; the office reads none of them.
  // Null for an agent of the office or of a member without their own OS
  // user, and when the member's env cannot be built.
  function memberUserSkillInput(
    managed: ManagedAgent,
  ): UserSkillScanInput | null {
    if (!memberFolderHost(managed.info.userId)) return null;
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildSessionEnv(managed);
    } catch {
      return null;
    }
    if (!env) return null;
    return {
      engine: managed.info.agentType,
      cwd: managed.info.cwd,
      roots: userSkillRootsForInfo(managed.info, env),
      claudeConfigDir: claudeConfigDirOf(env),
      plugins: managed.reportedPlugins
        ? managed.reportedPlugins.map((p) => ({
            name: p.name,
            path: p.path,
            ...(p.source !== undefined ? { source: p.source } : {}),
          }))
        : null,
      synced: !managed.reportedSkills,
    };
  }

  // An isolated member's agent: their runner lists its project skills and
  // its user, plugin and synced skills again.
  function refreshMemberSkills(agentId: string): void {
    refreshMemberProjectSkills(agentId);
    refreshMemberUserSkills(agentId);
    prepareMemberSkillFolder(agentId);
  }

  // An isolated member's agent: its skill folder built now when no build
  // for its input answered yet, so its next session start finds it. An
  // agent below standard loads no skills.
  function prepareMemberSkillFolder(agentId: string): void {
    const managed = agents.get(agentId);
    if (!managed || !memberFolderHost(managed.info.userId)) return;
    if (belowStandard(agentAccessOf(managed.info))) return;
    if (managed.info.agentType === "opencode") {
      openCodeSkillPathsForUserId(managed.info.userId);
      return;
    }
    let env: { [key: string]: string | undefined } | undefined;
    try {
      env = buildSessionEnv(managed);
    } catch {
      return;
    }
    memberSkillFolderFor(managed.info, env);
  }

  // A member's runner connected: their agents' lists and folders again.
  function memberConnected(userId: string): void {
    for (const [agentId, managed] of agents)
      if (managed.info.userId === userId) refreshSkillMenu(agentId);
  }

  // The user, plugin and synced skills of an isolated member's agents, as
  // their runner last listed them for the input of that moment.
  const memberUserSkills = new Map<
    string,
    { key: string; lists: UserSkillLists }
  >();
  const userSkillsInFlight = new Map<string, string>();
  const NO_USER_SKILLS: UserSkillLists = { user: [], plugin: [], synced: [] };

  function cachedUserSkills(managed: ManagedAgent): UserSkillLists {
    const input = memberUserSkillInput(managed);
    const cached = memberUserSkills.get(managed.info.id);
    return input && cached && cached.key === JSON.stringify(input)
      ? cached.lists
      : NO_USER_SKILLS;
  }

  // Asks an isolated member's runner for the agent's user, plugin and synced
  // skills, at the moments the office lists its own again (refreshSkillMenu).
  // A failed call, a runner that does not answer in time or a reply out of
  // shape leaves empty lists and one log line; an answer for an input the
  // agent no longer has is dropped.
  function refreshMemberUserSkills(agentId: string): void {
    const managed = agents.get(agentId);
    if (!managed) return;
    const host = memberFolderHost(managed.info.userId);
    const input = memberUserSkillInput(managed);
    if (!host || !input) return;
    const key = JSON.stringify(input);
    if (userSkillsInFlight.get(agentId) === key) return;
    userSkillsInFlight.set(agentId, key);
    void fetchUserSkillLists(host, input).then((lists) => {
      if (userSkillsInFlight.get(agentId) === key)
        userSkillsInFlight.delete(agentId);
      const now = agents.get(agentId);
      if (now !== managed) return;
      const nowInput = memberUserSkillInput(now);
      if (!nowInput || JSON.stringify(nowInput) !== key) return;
      if (lists === null)
        console.error(
          `[skills] ${agentId}: the member runner gave no user skill list for ${input.engine}`,
        );
      memberUserSkills.set(agentId, { key, lists: lists ?? NO_USER_SKILLS });
      applySkillMenu(agentId);
    });
  }

  function userSkillRootsFor(managed: ManagedAgent): UserSkillRoot[] {
    return userSkillRootsForInfo(managed.info, buildSessionEnv(managed));
  }

  // The agent's skills in priority order, deduplicated by name (highest
  // priority wins). The Sk menu lists these.
  function discoverSkillsFor(managed: ManagedAgent): SkillInfo[] {
    if (memberFolderHost(managed.info.userId))
      return discoverMemberSkillsFor(managed);
    const claudeConfigDir = claudeConfigDirFor(managed);
    const found = [
      ...discoverUserSkills(userSkillRootsFor(managed)),
      ...projectSkillsFor(managed.info),
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

  // The same list for an isolated member's agent, in the same order, with
  // no office read of the member's files: their user, plugin and synced
  // skills as their runner listed them, their project skills likewise, and
  // the bundled skills (our code).
  function discoverMemberSkillsFor(managed: ManagedAgent): SkillInfo[] {
    const claude = managed.info.agentType === "claude";
    const lists = cachedUserSkills(managed);
    const found = [
      ...userSkillInfos(lists.user, "user"),
      ...projectSkillsFor(managed.info),
      ...(claude ? userSkillInfos(lists.plugin, "plugin") : []),
      ...discoverBundledSkills(),
    ];
    const listed = new Set([
      ...found.map((skill) => skill.name),
      ...autocompleteCommands(managed.info.agentType).map((c) => c.name),
    ]);
    // Live rows need no read; without them, the runner's synced list.
    const synced = !claude
      ? []
      : managed.reportedSkills
        ? discoverSyncedSkills("", managed.reportedSkills, listed)
        : userSkillInfos(lists.synced, "user");
    return deduplicateSkills([...found, ...synced]);
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
    const reload = () =>
      session.reloadSkills?.().catch((err: unknown) => {
        console.error(
          `[skills] reloadSkills failed for ${managed.info.id}:`,
          errMessage(err),
        );
      });
    // An isolated member's runner builds the folder: Codex reads it again
    // only after that build answered.
    const host = hostFor(managed.info.userId);
    if (host.member !== undefined) {
      const input = memberSkillFolderInput(
        managed.info,
        managed.launchedSkillEnv,
        host,
      );
      if (!input || !managed.info.userId) return;
      void memberSkillFolders
        .build(host, managed.info.userId, input)
        .then((path) => (path === null ? undefined : reload()));
      return;
    }
    memberSkillFolderFor(managed.info, managed.launchedSkillEnv, built);
    void reload();
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
    applySkillMenu(agentId);
    refreshMemberSkills(agentId);
  }

  // The agent's Sk menu, discovered again now and sent to clients.
  function applySkillMenu(agentId: string): void {
    const managed = agents.get(agentId);
    if (!managed) return;
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
      pluginRoot: claudeConfigDirOf(env),
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
        ...(env ?? officeAgentHost().baseEnv()),
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
    projectSkillsFor,
    refreshMemberSkills,
    memberUserSkillInput,
    memberConnected,
    forgetMemberProjectSkills,
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
