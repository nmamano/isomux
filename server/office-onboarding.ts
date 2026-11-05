// The office's onboarding: the welcome agents seeded for the first owner, the
// lobby Receptionist, the free OpenCode model discovery they use with its
// background retry, and the default model of a new Codex agent. Moved out of
// server/isomux-office.ts, which creates it once and wires it.
import type {
  AgentBackendType,
  AgentInfo,
  BackendModelWire,
} from "../shared/types.ts";
import {
  CODEX_MODELS,
  codexDefaultModel,
  LOBBY_ROOM_ID,
  MODEL_FAMILIES,
  OPENCODE_DEFAULT_MODEL,
  type AgentOutfit,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import {
  firstAnsweringModel,
  type FreeModelCheck,
  FREE_WELCOME_AGENT_NAME,
  freeOpenCodeCandidates,
  needsOfficeFreeModelMark,
  RECEPTIONIST_NAME,
  resolveWelcomeOpenCodeModel,
  retryWelcomeOpenCodeModel,
  type FreeModelProbeTiming,
  type RefusedFreeModelReplacer,
  type WelcomeModelRetryTiming,
} from "./welcome-opencode-model.ts";
import {
  loadFreeModelMarkBackfillDone,
  saveFreeModelMarkBackfillDone,
} from "./persistence.ts";
import { getUserByName, listUsers } from "./users.ts";
import { buildPublicOrigin } from "./auth.ts";
import { renderReceptionistProfile } from "./receptionist-profile.ts";
import { RECEPTIONIST_OUTFIT } from "../shared/receptionist-profile.ts";
import {
  agentManager,
  codexModelDiscoveryTimeoutMs,
  discoverWelcomeOpenCodeModels,
  listCodexModelsSeam,
  openCodeRunsOnHost,
} from "./office-managers.ts";

// The seed's discovery timeout, then the background retry after a seed used
// the fallback (see repickFallbackSeeds).
export interface WelcomeModelTiming extends WelcomeModelRetryTiming {
  discoveryTimeoutMs: number;
}

export interface OfficeOnboardingDeps {
  listBackendModels: (input: {
    agentType: string;
    cwd: string;
    includeHidden: boolean;
    userId: string | null;
    signal?: AbortSignal;
  }) => Promise<
    | { ok: true; models: BackendModelWire[] }
    | { ok: false; error: string; authError: boolean }
  >;
  // The boot check met OpenCode's free usage limit (server/opencode-free-limit.ts).
  recordOpenCodeFreeLimit?: () => void;
}

export function createOfficeOnboarding(deps: OfficeOnboardingDeps) {
  const { listBackendModels } = deps;

  const WELCOME_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
  const WELCOME_MODEL_TIMING: WelcomeModelTiming = {
    discoveryTimeoutMs: WELCOME_MODEL_DISCOVERY_TIMEOUT_MS,
    delayMs: 10_000,
    windowMs: 10 * 60_000,
  };
  let welcomeModelTiming = WELCOME_MODEL_TIMING;
  // The probe of a free model before the seed uses it, and in the search after
  // a seeded agent's model is refused. The claim's redirect waits for the seed.
  const FREE_MODEL_PROBE_TIMING: FreeModelProbeTiming = {
    probeTimeoutMs: 15_000,
    probeBudgetMs: 20_000,
  };
  let freeModelProbeTiming = FREE_MODEL_PROBE_TIMING;

  // The model for a new Codex agent or cron job whose request names none: the
  // default of the owner's discovered model list (codexDefaultModel), or
  // CODEX_MODELS[0] when discovery fails, lists no visible model or times out.
  // The timeout aborts discovery and stops its codex process.
  async function resolveCodexDefaultModel(
    userId: string,
    cwd: string,
  ): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${codexModelDiscoveryTimeoutMs} ms`));
      }, codexModelDiscoveryTimeoutMs);
    });
    try {
      const discovery = listCodexModelsSeam
        ? listCodexModelsSeam({ userId, cwd, signal: controller.signal })
        : listBackendModels({
            agentType: "codex",
            cwd,
            includeHidden: false,
            userId,
            signal: controller.signal,
          }).then((r) => {
            if (!r.ok) throw new Error(r.error);
            return r.models;
          });
      // Race the bound here too: a discovery that ignores its signal must not
      // hold the spawn.
      const id = codexDefaultModel(await Promise.race([discovery, timedOut]));
      if (id) return id;
      console.warn(
        `[codex] the model list has no visible model; using ${CODEX_MODELS[0].value}`,
      );
    } catch (err) {
      console.warn(
        `[codex] default model discovery failed; using ${CODEX_MODELS[0].value}:`,
        errMessage(err),
      );
    } finally {
      clearTimeout(timer);
    }
    return CODEX_MODELS[0].value;
  }

  // Where the seed puts a welcome agent: the discovered model, or
  // OPENCODE_DEFAULT_MODEL when discovery failed (fromFallback).
  interface WelcomeModelChoice {
    model: string;
    fromFallback: boolean;
  }

  // One discovery request per owner at a time: a caller that arrives while one
  // is in flight, such as the retry after the seed's request timed out, waits for
  // that request instead of starting another.
  const welcomeDiscoveryInFlight = new Map<
    string,
    Promise<BackendModelWire[]>
  >();

  function discoverWelcomeModels(userId: string): Promise<BackendModelWire[]> {
    const inFlight = welcomeDiscoveryInFlight.get(userId);
    if (inFlight) return inFlight;
    const request = startWelcomeDiscovery(userId).finally(() => {
      if (welcomeDiscoveryInFlight.get(userId) === request)
        welcomeDiscoveryInFlight.delete(userId);
    });
    welcomeDiscoveryInFlight.set(userId, request);
    return request;
  }

  function startWelcomeDiscovery(userId: string): Promise<BackendModelWire[]> {
    return (
      discoverWelcomeOpenCodeModels
        ? discoverWelcomeOpenCodeModels(userId).then((models) => ({
            ok: true as const,
            models,
          }))
        : listBackendModels({
            agentType: "opencode",
            cwd: "~",
            includeHidden: false,
            userId,
          })
    ).then((discovery) => {
      if (!discovery.ok) throw new Error(discovery.error);
      return discovery.models;
    });
  }

  // The seed of one owner checks the free models once for the Receptionist and
  // the Free Welcome Agent: while seedWelcomeAgentsForFirstOwner runs, the
  // owner has an entry here that keeps each check by its candidate list.
  const seedModelChecks = new Map<
    string,
    Map<string, Promise<FreeModelCheck>>
  >();

  function checkFreeModels(
    username: string,
    userId: string,
    candidates: string[],
  ): Promise<FreeModelCheck> {
    const check = () =>
      firstAnsweringModel(
        candidates,
        (model) => probeFreeModel(userId, model),
        freeModelProbeTiming,
      );
    const kept = seedModelChecks.get(username);
    if (!kept) return check();
    const key = candidates.join("\n");
    let result = kept.get(key);
    if (!result) {
      result = check();
      kept.set(key, result);
    }
    return result;
  }

  async function welcomeOpenCodeModel(
    username: string,
  ): Promise<WelcomeModelChoice | null> {
    const user = getUserByName(username);
    if (!user) {
      console.warn(
        `[bootstrap] cannot discover a free OpenCode model: owner ${username} was not found; using the preferred model`,
      );
      return { model: OPENCODE_DEFAULT_MODEL, fromFallback: false };
    }
    let listed: BackendModelWire[] = [];
    const result = await resolveWelcomeOpenCodeModel(
      async () => (listed = await discoverWelcomeModels(user.id)),
      OPENCODE_DEFAULT_MODEL,
      welcomeModelTiming.discoveryTimeoutMs,
    );
    if (result.kind === "no_free_model") {
      console.warn(
        "[bootstrap] Free Welcome Agent was not spawned because OpenCode discovery returned no free model.",
      );
      return null;
    }
    if (result.kind === "discovery_failed") {
      console.warn(
        "[bootstrap] OpenCode model discovery failed; using the preferred free model:",
        result.error,
      );
      return { model: OPENCODE_DEFAULT_MODEL, fromFallback: true };
    }
    // The provider can refuse a free model its catalog lists: check them in
    // order. When none answers in the budget, the seed keeps the first, and a
    // refused turn moves the agent later (switchRefusedFreeModel). The free
    // usage limit ends the check: every free model shares it.
    const check = await checkFreeModels(
      username,
      user.id,
      freeOpenCodeCandidates(listed, OPENCODE_DEFAULT_MODEL),
    );
    if (check.kind === "none")
      console.warn(
        `[bootstrap] no free OpenCode model answered a check; seeding ${result.model}`,
      );
    if (check.kind === "free_limit") {
      deps.recordOpenCodeFreeLimit?.();
      console.warn(
        `[bootstrap] OpenCode's free usage limit is used up on this network; seeding ${result.model}`,
      );
    }
    return {
      model: check.kind === "answered" ? check.model : result.model,
      fromFallback: false,
    };
  }

  // The fallback constant can be withdrawn by the provider before a release
  // updates it. After a seed used it, discovery continues in the background, and
  // the first success moves the agents this process seeded on the fallback to a
  // discovered free model. In memory only: a restart ends the retry. Existing
  // agents and a model a member picked in the meantime are never touched. The
  // window bounds both new requests and model updates.
  const fallbackSeededAgentIds = new Set<string>();
  let fallbackRepickRunning = false;
  // Bumped at shutdown so a retry still in flight does not act on a later server.
  let fallbackRepickGeneration = 0;

  function repickFallbackSeeds(userId: string, agentId: string): void {
    fallbackSeededAgentIds.add(agentId);
    if (fallbackRepickRunning) return;
    fallbackRepickRunning = true;
    const generation = fallbackRepickGeneration;
    const deadline = Date.now() + welcomeModelTiming.windowMs;
    void (async () => {
      const handled: string[] = [];
      try {
        const result = await retryWelcomeOpenCodeModel(
          () => discoverWelcomeModels(userId),
          OPENCODE_DEFAULT_MODEL,
          welcomeModelTiming,
        );
        if (generation !== fallbackRepickGeneration) return;
        if (result.kind !== "selected") {
          console.warn(
            "[bootstrap] OpenCode model discovery retry found no free model; the welcome agents keep the preferred free model.",
          );
          handled.push(...fallbackSeededAgentIds);
          return;
        }
        for (const id of [...fallbackSeededAgentIds]) {
          if (Date.now() > deadline) {
            handled.push(...fallbackSeededAgentIds);
            return;
          }
          handled.push(id);
          const agent = agentManager.getAgent(id);
          if (
            !agent ||
            agent.agentType !== "opencode" ||
            agent.modelFamily !== OPENCODE_DEFAULT_MODEL ||
            result.model === OPENCODE_DEFAULT_MODEL
          )
            continue;
          try {
            await agentManager.editAgent(id, {
              modelFamily: result.model,
              officeFreeModel: result.model,
            });
          } catch (err) {
            console.warn(
              `[bootstrap] could not move ${agent.name} to ${result.model}:`,
              err,
            );
          }
          if (generation !== fallbackRepickGeneration) return;
        }
      } catch (err) {
        console.warn("[bootstrap] OpenCode model discovery retry failed:", err);
      } finally {
        if (generation === fallbackRepickGeneration) {
          fallbackRepickRunning = false;
          for (const id of handled) fallbackSeededAgentIds.delete(id);
          // An agent seeded while the last attempt was being applied.
          const [next] = fallbackSeededAgentIds;
          if (next) {
            fallbackSeededAgentIds.delete(next);
            repickFallbackSeeds(userId, next);
          }
        }
      }
    })();
  }

  // The search after the free model of an agent the office seeded is refused:
  // the owner's free models, without the refused one, and the first that
  // answers a probe.
  const replaceRefusedFreeModel: RefusedFreeModelReplacer = async (
    agent,
    refusedModel,
  ) => {
    if (!agent.userId) return null;
    const userId = agent.userId;
    // The agent is busy while this runs: a model list that does not come in
    // the seed's discovery time ends the search, and today's error shows.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listed = await Promise.race([
      discoverWelcomeModels(userId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenCode model discovery timed out")),
          welcomeModelTiming.discoveryTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const candidates = freeOpenCodeCandidates(
      listed,
      OPENCODE_DEFAULT_MODEL,
    ).filter((model) => model !== refusedModel);
    const check = await firstAnsweringModel(
      candidates,
      (model) => probeFreeModel(userId, model),
      freeModelProbeTiming,
    );
    return check.kind === "answered" ? check.model : null;
  };

  // One tiny real request: the provider can refuse a free model its catalog
  // still lists (task 0387b8de). Resolves when the model answered.
  async function probeFreeModel(userId: string, model: string): Promise<void> {
    await agentManager.oneShotForUser(
      userId,
      "opencode",
      model,
      "Reply with the word OK.",
    );
  }

  function stopFallbackRepick(): void {
    agentManager.cancelFreeModelSearches();
    fallbackRepickGeneration++;
    welcomeDiscoveryInFlight.clear();
    fallbackRepickRunning = false;
    fallbackSeededAgentIds.clear();
  }

  // A default profile is seeded only when the office first gains a lobby.

  async function ensureReceptionist(username: string): Promise<void> {
    const lobby = agentManager
      .getRooms()
      .find((room) => room.id === LOBBY_ROOM_ID);
    if (lobby && !agentManager.lobbySeedIsPending()) return;
    if (
      agentManager
        .getAllAgents()
        .some((agent) => agent.roomId === LOBBY_ROOM_ID)
    ) {
      agentManager.completeLobbySeed();
      return;
    }
    agentManager.ensureLobby(true);
    try {
      // OpenCode runs only on Linux. Elsewhere the Receptionist runs on Claude
      // with the same permission mode, and a member without a Claude sign-in
      // gets the sign-in card on the first message.
      const openCode = openCodeRunsOnHost();
      const choice = openCode ? await welcomeOpenCodeModel(username) : null;
      const model = openCode
        ? (choice?.model ?? OPENCODE_DEFAULT_MODEL)
        : MODEL_FAMILIES[0].family;
      const created = await agentManager.spawn(
        RECEPTIONIST_NAME,
        "~",
        "bypassPermissions",
        0,
        renderReceptionistProfile({
          officeName: agentManager.getOfficeSettings().name,
          members: listUsers(),
          publicOrigin:
            buildPublicOrigin().source === "localhost"
              ? null
              : buildPublicOrigin().origin,
        }),
        LOBBY_ROOM_ID,
        RECEPTIONIST_OUTFIT,
        model,
        undefined,
        username,
        openCode ? "opencode" : "claude",
        undefined,
        undefined,
      );
      if (created) {
        agentManager.completeLobbySeed();
        if (openCode) agentManager.setOfficeFreeModel(created.id, model);
        if (choice?.fromFallback && created.userId)
          repickFallbackSeeds(created.userId, created.id);
      } else {
        console.warn(
          `[bootstrap] ${RECEPTIONIST_NAME} spawn returned null; the next boot will retry.`,
        );
      }
    } catch (err) {
      console.warn(`[bootstrap] ${RECEPTIONIST_NAME} spawn threw:`, err);
    }
  }

  // Once per office, after the restore (task c00b3973): the Free Welcome Agent
  // and lobby Receptionist seeded before AgentInfo.officeFreeModel existed get
  // the mark when they still sit on a free default model, so a refused model
  // moves them as it moves a new seed. The flag is saved only after every agent
  // was checked, so a failure retries at the next boot.
  function backfillOfficeFreeModelMarks(): void {
    if (loadFreeModelMarkBackfillDone()) return;
    let marked = 0;
    for (const agent of agentManager.getAllAgents()) {
      if (!needsOfficeFreeModelMark(agent)) continue;
      agentManager.setOfficeFreeModel(agent.id, agent.modelFamily);
      marked++;
    }
    if (marked > 0)
      console.log(
        `[bootstrap] marked ${marked} seeded agent(s) for the free model fallback`,
      );
    saveFreeModelMarkBackfillDone();
  }

  // Boot-time half: an office that already has an owner but no receptionist
  // (installed before the feature, or its file was removed) gets one, managed by
  // the first owner on record. A fresh office waits for the claim hook.
  async function ensureReceptionistAtBoot(): Promise<void> {
    const owner = listUsers().find((u) => u.role === "owner");
    if (!owner) return;
    await ensureReceptionist(owner.name);
  }

  // First-install onboarding: pre-spawn one welcome agent for each backend.
  // OpenCode's bundled free model answers without provider credentials, so a
  // new owner has one working coworker before signing in to Claude or Codex.
  // Spawn is always allowed (no CLI install check); an unavailable backend
  // surfaces a chat-visible error on first message. Per-spawn try/catch is
  // defense in depth against any unexpected throw. Awaited so all three agents
  // are in officeState before the redirected
  // browser reads `full_state`. Guarded so an owner-recovery on an existing
  // office doesn't double-seed.
  const WELCOME_AGENTS: ReadonlyArray<{
    agentType: AgentBackendType;
    name: string;
    family: string;
  }> = [
    { agentType: "claude", name: "Claude Welcome Agent", family: "Claude" },
    { agentType: "codex", name: "Codex Welcome Agent", family: "Codex" },
    {
      agentType: "opencode",
      name: FREE_WELCOME_AGENT_NAME,
      family: "OpenCode",
    },
  ];

  // OpenCode runs only on Linux, so other hosts get no Free Welcome Agent.
  function seededWelcomeAgents(): typeof WELCOME_AGENTS {
    return openCodeRunsOnHost()
      ? WELCOME_AGENTS
      : WELCOME_AGENTS.filter((agent) => agent.agentType !== "opencode");
  }

  function welcomeAgentPrompt(agentType: AgentBackendType): string {
    const self = WELCOME_AGENTS.find((agent) => agent.agentType === agentType)!;
    const seeded = seededWelcomeAgents();
    const roster = seeded
      .map((agent) => `${agent.name} (${agent.family})`)
      .join(", ");
    const freeAgent = seeded.some((agent) => agent.agentType === "opencode")
      ? " The Free Welcome Agent runs on a free OpenCode model, so it answers immediately with no sign-in and no subscription."
      : "";
    return `You are the ${self.name} in this member's new Isomux office. Isomux is a persistent office of AI agents reachable from any device; each agent lives at a desk in a room with its own chat. New offices come preset with these welcome agents: ${roster}.${freeAgent} The Claude and Codex welcome agents need a subscription sign-in with their provider; if one of them does not answer, that provider account is not signed in yet. If the member messages you without a specific request, welcome them to the office and suggest \`/help\` to see your available commands, skills, and tips. You can also offer to walk them through spawning their first agent or to showcase agent-to-agent communication. If they ask for the showcase, check which welcome agents are present, and then message each one and ask for a message back. Be brief, friendly, and focus on what the member asks. For deeper Isomux questions, use https://github.com/nmamano/isomux/blob/main/README.md or https://isomux.com as references.`;
  }

  // Fixed outfits so all three welcome agents have a recognizable, friendly
  // look on every fresh install instead of the random palette new spawns get. Claude =
  // blue/glasses, Codex = pink/tie - visually distinct so the user can tell
  // them apart at a glance from the desk view.
  const CLAUDE_WELCOME_OUTFIT: AgentOutfit = {
    hat: "bow",
    color: "#45B7D1",
    hair: "#6C5CE7",
    hairStyle: "long",
    skin: "#FDEBD0",
    beard: "none",
    accessory: "glasses",
  };
  const CODEX_WELCOME_OUTFIT: AgentOutfit = {
    hat: "none",
    color: "#E85D75",
    hair: "#E84393",
    hairStyle: "ponytail",
    skin: "#FDEBD0",
    beard: "stubble",
    accessory: "tie",
  };
  const OPENCODE_WELCOME_OUTFIT: AgentOutfit = {
    hat: "beanie",
    color: "#59C9A5",
    hair: "#2D3436",
    hairStyle: "short",
    skin: "#F4C7A1",
    beard: "none",
    accessory: "headphones",
  };

  async function spawnWelcomeAgent(
    name: string,
    agentType: AgentBackendType,
    modelFamily: string,
    permissionMode: AgentInfo["permissionMode"] | undefined,
    outfit: AgentOutfit,
    username: string,
  ): Promise<AgentInfo | null> {
    try {
      const created = await agentManager.spawn(
        name,
        "~",
        permissionMode,
        undefined,
        welcomeAgentPrompt(agentType),
        undefined,
        outfit,
        modelFamily,
        undefined,
        username,
        agentType,
        undefined,
        undefined,
      );
      if (!created) {
        console.warn(
          `[bootstrap] ${name} spawn returned null (duplicate name or full room?)`,
        );
      }
      return created;
    } catch (err) {
      console.warn(`[bootstrap] ${name} spawn threw:`, err);
      return null;
    }
  }

  // Seed welcome agents on the first owner of a fresh office. Fires for
  // both the setup form (handleClaim) and the legacy bootstrap-
  // invite accept (handleAccept where isBootstrap is true). The hook only
  // fires on first-claim flows by design; the agent-count guard below is
  // defensive in case a future call path fires it against an already-
  // populated office.
  const seedWelcomeAgentsForFirstOwner = async (username: string) => {
    seedModelChecks.set(username, new Map());
    try {
      await seedWelcomeAgents(username);
    } finally {
      seedModelChecks.delete(username);
    }
  };
  const seedWelcomeAgents = async (username: string) => {
    const hadAgents = agentManager.getAllAgents().length > 0;
    await ensureReceptionist(username);
    // Branch on the pre-spawn snapshot so the lobby does not suppress welcome agents.
    if (hadAgents) {
      return;
    }
    await spawnWelcomeAgent(
      "Claude Welcome Agent",
      "claude",
      MODEL_FAMILIES[0].family,
      undefined,
      CLAUDE_WELCOME_OUTFIT,
      username,
    );
    const owner = getUserByName(username);
    await spawnWelcomeAgent(
      "Codex Welcome Agent",
      "codex",
      owner
        ? await resolveCodexDefaultModel(owner.id, "~")
        : CODEX_MODELS[0].value,
      undefined,
      CODEX_WELCOME_OUTFIT,
      username,
    );
    if (!openCodeRunsOnHost()) return;
    const openCodeModel = await welcomeOpenCodeModel(username);
    if (openCodeModel) {
      const created = await spawnWelcomeAgent(
        FREE_WELCOME_AGENT_NAME,
        "opencode",
        openCodeModel.model,
        "bypassPermissions",
        OPENCODE_WELCOME_OUTFIT,
        username,
      );
      if (created)
        agentManager.setOfficeFreeModel(created.id, openCodeModel.model);
      if (openCodeModel.fromFallback && created?.userId)
        repickFallbackSeeds(created.userId, created.id);
    }
  };

  function configureWelcomeModelTiming(opts: {
    welcomeModelTiming?: WelcomeModelTiming;
    freeModelProbeTiming?: FreeModelProbeTiming;
  }): void {
    welcomeModelTiming = opts.welcomeModelTiming ?? WELCOME_MODEL_TIMING;
    freeModelProbeTiming = opts.freeModelProbeTiming ?? FREE_MODEL_PROBE_TIMING;
  }

  return {
    resolveCodexDefaultModel,
    replaceRefusedFreeModel,
    stopFallbackRepick,
    backfillOfficeFreeModelMarks,
    ensureReceptionistAtBoot,
    seedWelcomeAgentsForFirstOwner,
    configureWelcomeModelTiming,
  };
}
