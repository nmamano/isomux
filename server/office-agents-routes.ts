// The agents routes: spawn, edit, kill, revive, move, desks, topic, access,
// manager and the system prompt reads. Moved out of buildExecutorDeps in
// server/isomux-office.ts, which registers them and keeps their
// reviveLastRoomAccess precondition.
import { agentAccessOf, FOLDER_NOT_ALLOWED } from "../shared/agent-access.ts";
import { BACK_ROOM_FULL_MESSAGE, hasBackRoom } from "../shared/desks.ts";
import { errMessage } from "../shared/errors.ts";
import { RECEPTIONIST_PROFILE_KEY } from "../shared/receptionist-profile.ts";
import type { AgentInfo } from "../shared/types.ts";
import { folderOverlapRefusal } from "./agent-folder-rules.ts";
import { SpawnAccessRefusedError } from "./agent-manager.ts";
import { buildAgentSystemPrompt, managerOf } from "./agent-system-prompt.ts";
import { hidesManagerData } from "./system-prompt.ts";
import type { Identity } from "./identity/index.ts";
import {
  resolveInteractiveModelSelection,
  validatePermissionMode,
} from "./agent-validators.ts";
import { notePromptContent } from "./audit-context.ts";
import { buildPublicOrigin } from "./auth.ts";
import { engineRunsAccessHere } from "./backends/access-here.ts";
import { resolveCwd } from "./cwd-utils.ts";
import type { createAccessPolicy } from "./office-access-policy.ts";
import { agentManager } from "./office-managers.ts";
import type { createOfficeOnboarding } from "./office-onboarding.ts";
import { saveRecentCwd } from "./persistence.ts";
import { renderReceptionistProfile } from "./receptionist-profile.ts";
import type { RouteHandler } from "./routes/executor.ts";
import { agentsHandlers } from "./routes/handlers/agents.ts";
import { listUsers } from "./users.ts";

// What the agents routes read from server/isomux-office.ts.
export interface AgentsRoutesDeps extends Pick<
  ReturnType<typeof createAccessPolicy>,
  | "ENGINE_BELOW_STANDARD_MESSAGE"
  | "accessChangeRefusal"
  | "announceAppAudienceChanges"
  | "announceWebhookAudienceChanges"
  | "attributionFor"
  | "cwdFolderRefusal"
  | "folderRuleState"
  | "snapshotAppVisibility"
  | "snapshotWebhookAudience"
  | "spawnAccessRefusal"
  | "spawnRefusal"
  | "webhookTargetsAgent"
> {
  resolveCodexDefaultModel: ReturnType<
    typeof createOfficeOnboarding
  >["resolveCodexDefaultModel"];
  transferAgentManager: (
    agentId: string,
    toUserId: string,
    changedBy: string,
  ) => Promise<AgentInfo | null | "unknown_member" | "cannot_move_down">;
  sharesRoomWithMember: (identity: Identity, userId: string) => boolean;
}

export function createAgentsRoutes(
  deps: AgentsRoutesDeps,
): Record<string, RouteHandler> {
  const {
    ENGINE_BELOW_STANDARD_MESSAGE,
    accessChangeRefusal,
    announceAppAudienceChanges,
    announceWebhookAudienceChanges,
    attributionFor,
    cwdFolderRefusal,
    folderRuleState,
    resolveCodexDefaultModel,
    snapshotAppVisibility,
    snapshotWebhookAudience,
    spawnAccessRefusal,
    spawnRefusal,
    transferAgentManager,
    sharesRoomWithMember,
    webhookTargetsAgent,
  } = deps;
  // A manager's private parts of a prompt, for this caller (hidesManagerData).
  // agent.userId first: the prompt keys member memory on it.
  const hidesManagerFrom = (
    caller: Identity,
    agent: Pick<AgentInfo, "userId" | "manager">,
  ) =>
    hidesManagerData(agent.userId ?? managerOf(agent).record?.id, (userId) =>
      sharesRoomWithMember(caller, userId),
    );
  // Agent lifecycle cores own the token lifecycle (spawn/revive mint,
  // kill/rollback revoke) + the agent_*/killed_* broadcasts, so these closures
  // just delegate (handlers stay contract-shaped). move returns a DISCRIMINATED
  // result the handler maps to status: moved / same-room idempotent -> { agent };
  // full target -> no_free_desk; absent target (owner-only) / post-guard race ->
  // room_not_found / agent_not_found. spawn/edit add validateCwd + saveRecentCwd
  // + null-disambiguation; revive delegates straight through (its lastRoomId ACL
  // is the reviveLastRoomAccess precondition in buildExecutorDeps).
  return agentsHandlers({
    kill: async (agentId) => {
      const before = snapshotAppVisibility(
        (app) => app.createdByAgentId === agentId,
      );
      const hooksBefore = snapshotWebhookAudience(webhookTargetsAgent(agentId));
      await agentManager.kill(agentId);
      announceAppAudienceChanges(before);
      announceWebhookAudienceChanges(hooksBefore);
      return { ok: true };
    },
    abort: (agentId, { byAgent }) =>
      byAgent
        ? agentManager.abortByAgent(agentId)
        : agentManager.abort(agentId),
    getAgent: (agentId) => agentManager.getAgent(agentId),
    systemPrompt: (agentId, caller) => {
      const agent = agentManager.getAgent(agentId);
      if (!agent) return undefined;
      const room = agentManager
        .getRooms()
        .find((candidate) => candidate.id === agent.roomId);
      return room
        ? buildAgentSystemPrompt(
            agent,
            room,
            agentManager.getOfficeSettings(),
            undefined,
            hidesManagerFrom(caller, agent),
          )
        : undefined;
    },
    previewSystemPrompt: (input, identity, caller) => {
      const existing = input.agentId
        ? agentManager.getAgent(input.agentId)
        : undefined;
      const room = agentManager
        .getRooms()
        .find((candidate) => candidate.id === input.roomId);
      if (!room || (input.agentId && !existing)) return undefined;
      // The form's mode decides the schedule line; without one, the
      // agent's on the same engine, else the new-agent default.
      const sameEngine = existing?.agentType === input.agentType;
      return buildAgentSystemPrompt(
        {
          id: existing?.id ?? "new-agent",
          roomId: room.id,
          manager: existing ? existing.manager : (identity.username ?? null),
          userId: existing ? existing.userId : identity.userId,
          name: input.name,
          agentType: input.agentType,
          customInstructions: input.instructions,
          privileged: input.privileged,
          ...(input.access ? { access: input.access } : {}),
          permissionMode:
            input.permissionMode ??
            (sameEngine
              ? existing.permissionMode
              : validatePermissionMode(input.agentType, undefined)),
          codexSandbox:
            input.codexSandbox ??
            (sameEngine ? existing.codexSandbox : undefined),
        },
        room,
        agentManager.getOfficeSettings(),
        existing ? input.memory : "",
        !!existing && hidesManagerFrom(caller, existing),
      );
    },
    move: (agentId, targetRoomId, desk) => {
      const before = snapshotAppVisibility(
        (app) => app.createdByAgentId === agentId,
      );
      const hooksBefore = snapshotWebhookAudience(webhookTargetsAgent(agentId));
      const current = agentManager.getAgent(agentId);
      // agentParam proved the agent existed; a miss here is a post-guard race.
      if (!current) return { ok: false, reason: "agent_not_found" };
      const r = agentManager.placeAgent(agentId, targetRoomId, desk);
      if (r.ok) {
        announceAppAudienceChanges(before);
        announceWebhookAudienceChanges(hooksBefore);
        const moved = agentManager.getAgent(agentId);
        return moved
          ? { ok: true, agent: moved }
          : { ok: false, reason: "agent_not_found" };
      }
      // A move to the place the agent already holds (its own room with no
      // desk, or its own seat) is an idempotent no-op: return the
      // unchanged agent, not a false failure.
      if (r.reason === "same_place") return { ok: true, agent: current };
      // invalid_desk cannot reach here (the handler range-checks the desk);
      // treat it like a taken desk rather than inventing a status.
      return {
        ok: false,
        reason: r.reason === "invalid_desk" ? "desk_taken" : r.reason,
      };
    },
    // agent-manager.swapDesks is (deskA, deskB, roomId); the dep takes
    // (roomId, deskA, deskB) so the handler reads room from the path param.
    roomForDesks: (roomId) =>
      agentManager.getRooms().find((r) => r.id === roomId),
    swapDesks: (roomId, deskA, deskB) =>
      agentManager.swapDesks(deskA, deskB, roomId),
    setTopic: (agentId, topic) => agentManager.setTopic(agentId, topic),
    regenerateTopic: (agentId) => agentManager.resetTopic(agentId),
    // 7b response-driven trio. attributionFor derives the spawning user from
    // the token (never the body). spawn/edit do validateCwd + saveRecentCwd;
    // spawn disambiguates a null return; revive delegates to the core.
    attributionFor,
    spawn: async (input) => {
      try {
        agentManager.validateCwd(input.cwd);
      } catch (err) {
        return {
          ok: false,
          reason: "invalid_cwd",
          message: errMessage(err, "Invalid directory"),
        };
      }
      const overlap = folderOverlapRefusal(
        resolveCwd(input.cwd),
        null,
        folderRuleState(),
      );
      if (overlap)
        return { ok: false, reason: FOLDER_NOT_ALLOWED, message: overlap };
      // Strict front-door check: a modelFamily that cannot belong to the
      // agentType is an explicit 422, never silently coerced to the backend
      // default (agentManager.spawn's validateModelFamily coercion stays as
      // canonicalization for boot/restore, not as input laundering here).
      const modelSelection = resolveInteractiveModelSelection(
        input.agentType ?? "claude",
        input.modelFamily,
        input.model,
      );
      if (modelSelection.error) {
        return {
          ok: false,
          reason: "invalid_model_family",
          message: modelSelection.error,
        };
      }
      // A Codex spawn with no model takes the login's default, not the
      // static CODEX_MODELS[0], which the login can lack.
      let modelFamily = modelSelection.modelFamily;
      if (input.agentType === "codex" && !modelFamily && input.userId)
        modelFamily = await resolveCodexDefaultModel(input.userId, input.cwd);
      if (input.spawner) {
        const refusal = spawnRefusal(input, input.spawner, modelFamily);
        if (refusal) return refusal;
      }
      saveRecentCwd(input.cwd);
      try {
        const spawned = await agentManager.spawn(
          input.name,
          input.cwd,
          input.permissionMode,
          input.desk,
          input.profileKey === RECEPTIONIST_PROFILE_KEY
            ? renderReceptionistProfile({
                officeName: agentManager.getOfficeSettings().name,
                members: listUsers(),
                instructions: input.customInstructions,
                publicOrigin:
                  buildPublicOrigin().source === "localhost"
                    ? null
                    : buildPublicOrigin().origin,
              })
            : input.customInstructions,
          input.roomId,
          input.outfit,
          modelFamily,
          input.effort,
          input.username,
          input.agentType,
          input.codexSandbox,
          input.userId,
          input.spawner && {
            spawnedByAgentId: input.spawner.spawnedByAgentId,
            spawnRootAgentId: input.spawner.spawnRootAgentId,
          },
          {
            grant: input.grant ?? { access: "standard" },
            refusal: (name, resolvedCwd) =>
              spawnAccessRefusal(
                name,
                input.agentType ?? "claude",
                modelFamily || null,
                input.grant?.access ?? "standard",
                resolvedCwd,
              ),
          },
        );
        if (spawned) {
          notePromptContent(spawned.customInstructions);
          return { ok: true, agent: spawned };
        }
        // null = duplicate name, unknown target room, or full room (none
        // throw). Disambiguate AFTER the null, in OfficeState.spawn's check
        // order (dup name -> room existence -> desk scan), so the dialog
        // routes the error to the right field. The unknown-room case is
        // reachable only by an owner (rule-based bodyRoom access passes any
        // id) - same post-hoc getRooms() pattern as the move dep above.
        const trimmed = input.name.trim();
        const dup = agentManager
          .getAllAgents()
          .some((a) => a.name.toLowerCase() === trimmed.toLowerCase());
        if (dup) {
          return {
            ok: false,
            reason: "name_taken",
            message: `Name "${trimmed}" is already taken.`,
          };
        }
        if (!agentManager.getRooms().some((r) => r.id === input.roomId)) {
          return {
            ok: false,
            reason: "room_not_found",
            message: "Room not found",
          };
        }
        // The room is full: a room with a back room fills it last; the
        // lobby has its one front desk only.
        const room = agentManager.getRooms().find((r) => r.id === input.roomId);
        return hasBackRoom(room)
          ? {
              ok: false,
              reason: "back_room_full",
              message: BACK_ROOM_FULL_MESSAGE,
            }
          : {
              ok: false,
              reason: "no_free_desk",
              message: "The target room has no free desks.",
            };
      } catch (err) {
        if (err instanceof SpawnAccessRefusedError)
          return {
            ok: false,
            reason: err.refusal.refused,
            message: err.refusal.message,
          };
        return {
          ok: false,
          reason: "spawn_failed",
          message: errMessage(err, "Spawn failed"),
        };
      }
    },
    revive: async (agentId, roomId, desk) => {
      const before = snapshotAppVisibility(
        (app) => app.createdByAgentId === agentId,
      );
      const hooksBefore = snapshotWebhookAudience(webhookTargetsAgent(agentId));
      const result = await agentManager.revive(agentId, roomId, desk);
      if (result.ok) {
        announceAppAudienceChanges(before);
        announceWebhookAudienceChanges(hooksBefore);
      }
      return result;
    },
    edit: async (agentId, changes, changedBy) => {
      // Version guard FIRST, before any field validation - a
      // stale writer is told to re-read before hearing about a bad cwd. Only
      // blob-bearing edits carry a version (the handler enforces presence);
      // compare against the agent's STORED token so the check is exactly
      // "the version the reads returned", independent of derivation details.
      if (changes.customInstructions !== undefined) {
        const current = agentManager.getAgent(agentId);
        if (!current) {
          return {
            ok: false,
            reason: "agent_not_found",
            message: "Agent not found.",
          };
        }
        if (
          changes.customInstructionsVersion !==
          current.customInstructionsVersion
        ) {
          return {
            ok: false,
            reason: "version_conflict",
            version: current.customInstructionsVersion,
          };
        }
      }
      // A folder change keeps the folder rules (agent-folder-rules.ts).
      if (changes.cwd) {
        const current = agentManager.getAgent(agentId);
        const refusal = current
          ? cwdFolderRefusal(current, resolveCwd(changes.cwd))
          : null;
        if (refusal)
          return {
            ok: false,
            reason: FOLDER_NOT_ALLOWED,
            message: refusal,
          };
      }
      // Validation next, side effects (saveRecentCwd) only after ALL checks
      // pass - a rejected edit must not mutate the recent-cwd list. Check
      // order matches the spawn dep: cwd, then modelFamily.
      if (changes.cwd) {
        try {
          agentManager.validateCwd(changes.cwd);
        } catch (err) {
          return {
            ok: false,
            reason: "invalid_cwd",
            message: errMessage(err, "Invalid directory"),
          };
        }
      }
      // Strict front-door check (mirrors the spawn dep): validate a provided
      // modelFamily against the agentType the edit will LAND on - the new
      // engine when this edit switches it, else the agent's current one - so
      // a mismatch is an explicit 422 instead of editAgent's silent
      // coerce-to-default (kept there as boot/restore canonicalization).
      let resolvedModelFamily = changes.modelFamily;
      if (changes.modelFamily !== undefined || changes.model !== undefined) {
        const current = agentManager.getAgent(agentId);
        if (!current) {
          return {
            ok: false,
            reason: "agent_not_found",
            message: "Agent not found.",
          };
        }
        const targetType =
          changes.agentType === "claude" ||
          changes.agentType === "codex" ||
          changes.agentType === "opencode"
            ? changes.agentType
            : current.agentType;
        const modelSelection = resolveInteractiveModelSelection(
          targetType,
          changes.modelFamily,
          changes.model,
        );
        if (modelSelection.error) {
          return {
            ok: false,
            reason: "invalid_model_family",
            message: modelSelection.error,
          };
        }
        resolvedModelFamily = modelSelection.modelFamily;
      }
      // An engine switch to Codex with no model takes the owner's login
      // default, as a new Codex agent does.
      if (changes.agentType === "codex" && !resolvedModelFamily) {
        const current = agentManager.getAgent(agentId);
        if (current && current.agentType !== "codex" && current.userId)
          resolvedModelFamily = await resolveCodexDefaultModel(
            current.userId,
            changes.cwd ?? current.cwd,
          );
      }
      // An agent below Standard stays on an engine and model that confine
      // its stop. A Codex switch with no model was judged on the login
      // default just resolved.
      {
        const current = agentManager.getAgent(agentId);
        const engine = changes.agentType ?? current?.agentType;
        const switched = !!current && engine !== current.agentType;
        if (
          current &&
          engine &&
          (switched || resolvedModelFamily !== undefined) &&
          !engineRunsAccessHere(
            engine,
            agentAccessOf(current),
            (resolvedModelFamily ?? (switched ? null : current.modelFamily)) ||
              null,
          )
        )
          return {
            ok: false,
            reason: "engine_below_standard",
            message: ENGINE_BELOW_STANDARD_MESSAGE,
          };
      }
      if (changes.cwd) saveRecentCwd(changes.cwd);
      try {
        // AgentEdit.customInstructions is string|null|undefined (the
        // AgentInfo Pick widens it); editAgent wants string|undefined. The WS
        // edit_agent command never carried null (the dialog clears via ""), so
        // coerce null->undefined to preserve parity. The version token was
        // consumed by the guard above - strip it so only real agent fields
        // reach the core.
        const {
          customInstructionsVersion: _version,
          model: _model,
          ...fields
        } = changes;
        await agentManager.editAgent(
          agentId,
          {
            ...fields,
            modelFamily: resolvedModelFamily,
            customInstructions: changes.customInstructions ?? undefined,
          },
          changedBy,
        );
        const agent = agentManager.getAgent(agentId);
        if (agent && changes.customInstructions !== undefined)
          notePromptContent(agent.customInstructions);
        return agent
          ? { ok: true, agent }
          : {
              ok: false,
              reason: "agent_not_found",
              message: "Agent not found.",
            };
      } catch (err) {
        return {
          ok: false,
          reason: "edit_failed",
          message: errMessage(err, "Edit failed"),
        };
      }
    },
    setPrivileged: (agentId, privileged) =>
      agentManager.setPrivileged(agentId, privileged),
    setAccess: async (agentId, grant) => {
      const agent = agentManager.getAgent(agentId);
      const refusal = agent ? accessChangeRefusal(agent, grant.access) : null;
      if (refusal) return refusal;
      const r = await agentManager.setAccess(agentId, grant);
      return r === "engine_below_standard"
        ? {
            refused: "engine_below_standard" as const,
            message: ENGINE_BELOW_STANDARD_MESSAGE,
          }
        : r;
    },
    setManager: (agentId, userId, changedBy) =>
      transferAgentManager(agentId, userId, changedBy),
  });
}
