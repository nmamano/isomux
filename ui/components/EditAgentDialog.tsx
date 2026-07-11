import { useEffect, useRef, useState } from "react";
import type {
  AgentBackendType,
  AgentInfo,
  AgentOutfit,
  BackendModelWire,
  CodexSandboxMode,
  EffortLevel,
} from "../../shared/types.ts";
import {
  MODEL_FAMILIES,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  modelVersionLabel,
  CODEX_MODELS,
  claudeFamilySupportsMaxEffort,
  claudeFamilySupportsAutoPermission,
} from "../../shared/types.ts";
import {
  SHIRT_COLORS,
  HAIR_COLORS,
  SKIN_COLORS,
  HAIR_STYLES,
  BEARDS,
  HATS,
  ACCESSORIES,
} from "../../shared/outfit-options.ts";
import { Character } from "../office/Character.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import type {
  MoveAgentReq,
  SpawnReq,
  EditAgentReq,
  SetPrivilegedReq,
} from "../../shared/contract-shapes.ts";
import { useAppState } from "../store.tsx";
import { getUsername } from "../device-settings.ts";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogChip,
} from "./dialog-styles.ts";

// Cap the recent-cwd suggestion chips so the row stays scannable even when the
// server is tracking its full history of working directories.
const MAX_CWD_SUGGESTIONS = 10;

const HAIR_STYLE_LABELS: Record<AgentOutfit["hairStyle"], string> = {
  short: "Short",
  long: "Long",
  ponytail: "Ponytail",
  bun: "Bun",
  pigtails: "Pigtails",
  curly: "Curly",
  bald: "Bald",
};

const HAT_LABELS: Record<AgentOutfit["hat"], string> = {
  none: "None",
  cap: "Cap",
  beanie: "Beanie",
  bow: "Hair Bow",
  headband: "Headband",
};

const ACCESSORY_LABELS: Record<string, string> = {
  none: "None",
  glasses: "Glasses",
  headphones: "Headphones",
  bow_tie: "Bow Tie",
  tie: "Tie",
  earrings: "Earrings",
};

const BEARD_LABELS: Record<AgentOutfit["beard"], string> = {
  none: "None",
  stubble: "Stubble",
  full: "Full",
  goatee: "Goatee",
  mustache: "Mustache",
};

function makeRandomOutfit(): AgentOutfit {
  return {
    hat: HATS[Math.floor(Math.random() * HATS.length)],
    color: SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)],
    hair: HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)],
    hairStyle: HAIR_STYLES[Math.floor(Math.random() * HAIR_STYLES.length)],
    skin: SKIN_COLORS[Math.floor(Math.random() * SKIN_COLORS.length)],
    beard: BEARDS[Math.floor(Math.random() * BEARDS.length)],
    accessory: ACCESSORIES[Math.floor(Math.random() * ACCESSORIES.length)],
  };
}

type EditAgentDialogProps = {
  onClose: () => void;
} & (
  | {
      agent: AgentInfo;
      deskIndex?: undefined;
      roomId?: undefined;
      defaultCwd?: undefined;
      spawnAgentType?: undefined;
    }
  | {
      agent?: undefined;
      deskIndex: number;
      roomId: string;
      defaultCwd: string;
      spawnAgentType: AgentBackendType;
    }
);

export function EditAgentDialog(props: EditAgentDialogProps) {
  const { onClose } = props;
  const isSpawn = !props.agent;
  const agent = props.agent;
  const agentType: AgentBackendType =
    agent?.agentType ?? props.spawnAgentType ?? "claude";
  // Edit-mode engine switch. The model/effort/approval menus below follow the
  // SELECTED engine (targetEngine), not the agent's current one, so switching
  // re-populates them with the new engine's valid options instead of leaving
  // stale ones. Spawn never changes it (the select is edit-only), so
  // targetEngine === agentType there and behavior is unchanged.
  const [targetEngine, setTargetEngine] = useState<AgentBackendType>(agentType);
  const isCodex = targetEngine === "codex";

  const {
    recentCwds: allRecentCwds,
    isMobile,
    agents,
    rooms,
    sessionContext,
  } = useAppState();
  // Privilege toggle visibility mirrors the (i-b) server gate (agents.setPrivileged):
  // an office owner may toggle any agent; otherwise only the agent's MANAGER (its
  // spawning user) may. At spawn the current user IS the manager. Hiding it for
  // everyone else avoids surfacing a control that would 403 on save.
  const canTogglePrivilege =
    isSpawn ||
    sessionContext?.role === "owner" ||
    (sessionContext?.userId != null && agent?.userId === sessionContext.userId);
  const roomCount = rooms.length;
  // Room of the agent being edited, resolved by stable id. The index is used
  // only for ordinal fallbacks; name is "" when the room isn't visible.
  const agentRoomIndex = agent
    ? rooms.findIndex((r) => r.id === agent.roomId)
    : -1;
  const agentRoomName = agentRoomIndex >= 0 ? rooms[agentRoomIndex].name : "";
  const [name, setName] = useState(agent?.name ?? "");
  const [cwd, setCwd] = useState(agent?.cwd ?? props.defaultCwd ?? "~");
  const [outfit, setOutfit] = useState<AgentOutfit>(
    agent ? { ...agent.outfit } : makeRandomOutfit,
  );
  const [customInstructions, setCustomInstructions] = useState(
    agent?.customInstructions ?? "",
  );
  // Agent memory (edit mode only) — edited via the unified /api/memory verbs
  // (load + version-guarded save), saved separately from the agent PATCH.
  const mem = useMemoryEditor("agent", agent?.id ?? null, !!agent?.id);
  const defaultModel = isCodex
    ? CODEX_MODELS[0].value
    : MODEL_FAMILIES[0].family;
  const [modelFamily, setModelFamily] = useState<string>(
    agent?.modelFamily ?? defaultModel,
  );
  const [effort, setEffort] = useState<EffortLevel>(
    agent?.effort ?? (isCodex ? "medium" : DEFAULT_EFFORT),
  );
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(
    agent?.codexSandbox ?? "workspace-write",
  );
  const claudeDefaultMode: AgentInfo["permissionMode"] =
    agent?.permissionMode === "auto" &&
    !claudeFamilySupportsAutoPermission(
      agent?.modelFamily ?? MODEL_FAMILIES[0].family,
    )
      ? "bypassPermissions"
      : (agent?.permissionMode ?? "auto");
  const codexDefaultMode: AgentInfo["permissionMode"] =
    (agent?.permissionMode as AgentInfo["permissionMode"]) ?? "on-request";
  const initialPermissionMode: AgentInfo["permissionMode"] = isCodex
    ? codexDefaultMode
    : claudeDefaultMode;
  const [permissionMode, setPermissionMode] = useState<
    AgentInfo["permissionMode"]
  >(initialPermissionMode);
  // Privileged operator access. Conferred ONLY via the dedicated, user-gated
  // PUT /api/agents/:id/privileged route (never the spawn/edit PATCH), so an
  // agent can't self-confer. At spawn we two-step: create, then toggle.
  const [privileged, setPrivileged] = useState(agent?.privileged ?? false);
  const [saving, setSaving] = useState(false);
  // Save-time errors route to either the Name input or the Cwd input based on
  // the REST error code (name_taken -> Name). Errors that don't map to a specific
  // field (the common case, e.g. cwd validation) fall back to cwdError, where the
  // inline render lives.
  const [nameError, setNameError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  // Suggestion chips: allRecentCwds is server-maintained newest-first (capped at
  // 20). Drop the current cwd, then show only the most recent few so the chip
  // row stays a glanceable shortcut instead of a wall of paths.
  const recentCwds = allRecentCwds
    .filter((c) => c !== cwd)
    .slice(0, MAX_CWD_SUGGESTIONS);

  // Fetched model list. null = not yet attempted; [] with error set = fetch
  // failed (UI falls back to the hardcoded CODEX_MODELS list). For Codex we
  // hit the server's backends.listModels endpoint which spins up a
  // throwaway codex client and calls model/list against the same env that
  // a real spawn would see. Claude path doesn't need this — the family
  // list is static, identical across auth tiers, and rendered from the
  // shared MODEL_FAMILIES constant.
  const [backendModels, setBackendModels] = useState<BackendModelWire[] | null>(
    null,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<{
    message: string;
    authError: boolean;
  } | null>(null);

  // Validate the existing cwd when the edit dialog opens, so the user sees
  // immediately if the stored directory is gone. Depend only on agent.id.
  useEffect(() => {
    if (isSpawn || !agent) return;
    const initialCwd = agent.cwd;
    let cancelled = false;
    apiFetch<{ ok: boolean; error?: string }>("POST", "/api/validate/cwd", {
      cwd: initialCwd,
    })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) setCwdError(r.error || "Invalid directory");
      })
      .catch(() => {
        // Transport error: leave the field unflagged, matching the old
        // no-reply behavior (a dropped cwd_validation never set an error).
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpawn, agent?.id]);

  // Fetch the auth-appropriate model list for Codex agents. Fires once when
  // the dialog opens (spawn or edit). Re-fetches if `agentType` flips to
  // codex — though in practice the agentType picker is locked at spawn.
  // GET backends.listModels: a DOMAIN failure (auth/transport in the executor's
  // model probe) comes back as a 200 carrying { models: [], authError, error },
  // NOT a thrown ApiError — so read r.error in .then(); only a real HTTP/network
  // failure reaches .catch().
  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    // Seed loading flags synchronously so the dropdown shows the spinner.
    /* eslint-disable react-hooks/set-state-in-effect */
    setModelsLoading(true);
    setModelsError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    apiFetch<{
      models: BackendModelWire[];
      authError?: boolean;
      error?: string;
    }>(
      "GET",
      `/api/backends/${encodeURIComponent(targetEngine)}/models?cwd=${encodeURIComponent(cwd)}`,
    )
      .then((r) => {
        if (cancelled) return;
        setModelsLoading(false);
        if (r.error) {
          setModelsError({ message: r.error, authError: !!r.authError });
          return;
        }
        setBackendModels(r.models);
        // Pick the spawn default. Invariant: prefer Isomux's canonical
        // default (CODEX_MODELS[0], currently gpt-5.6-sol) when this auth tier
        // offers it; otherwise fall back to Codex's per-auth isDefault, then
        // the first listed model. We choose from the visible (non-hidden)
        // models so the value always matches a rendered <option>. The model
        // select is disabled during loading, so the user can't have made a
        // choice we'd be overriding.
        if (isSpawn || targetEngine !== agentType) {
          const preferredModelId = CODEX_MODELS[0].value;
          const visibleModels = r.models.filter((m) => !m.hidden);
          const def =
            visibleModels.find((m) => m.id === preferredModelId) ??
            visibleModels.find((m) => m.isDefault) ??
            visibleModels[0];
          if (def) {
            setModelFamily(def.id);
            if (def.defaultEffort) setEffort(def.defaultEffort as EffortLevel);
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setModelsLoading(false);
        setModelsError({
          message: e instanceof ApiError ? e.message : "Failed to load models",
          authError: false,
        });
      });
    return () => {
      cancelled = true;
    };
    // Intentionally not depending on cwd: re-fetching on every keystroke
    // would spawn a codex subprocess per character. The cwd inherited by
    // model/list rarely affects the result anyway (auth is global).
    // Re-fetches when the dialog's selected engine flips to codex.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCodex, targetEngine]);

  // When the engine is switched in the dialog, re-seed model/effort/approval/
  // sandbox so the menus carry valid options for the newly selected engine (no
  // stale cross-engine values). Switching back to the agent's current engine
  // restores its real settings. Skips the initial mount. For codex the model/
  // effort here are provisional — the model/list effect above refines them once
  // the auth-appropriate list loads.
  const didInitEngine = useRef(false);
  useEffect(() => {
    if (!didInitEngine.current) {
      didInitEngine.current = true;
      return;
    }
    // Synchronous re-seed in response to the engine flip — same intentional
    // pattern (and rule suppression) as the model/list effect above.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (targetEngine === agentType) {
      setModelFamily(
        agent?.modelFamily ??
          (agentType === "codex"
            ? CODEX_MODELS[0].value
            : MODEL_FAMILIES[0].family),
      );
      setEffort(
        agent?.effort ?? (agentType === "codex" ? "medium" : DEFAULT_EFFORT),
      );
      setPermissionMode(initialPermissionMode);
      setCodexSandbox(agent?.codexSandbox ?? "workspace-write");
    } else if (targetEngine === "codex") {
      setModelFamily(CODEX_MODELS[0].value);
      setEffort("medium");
      setPermissionMode("on-request");
      setCodexSandbox("workspace-write");
    } else {
      const claudeDefault = MODEL_FAMILIES[0].family;
      setModelFamily(claudeDefault);
      setEffort(DEFAULT_EFFORT);
      setPermissionMode(
        claudeFamilySupportsAutoPermission(claudeDefault) ? "auto" : "default",
      );
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEngine]);

  function handleSave() {
    // name_taken routes under the Name input; everything else under cwd (the
    // prior agent_save_response.field === "name" routing, now keyed on the REST
    // ApiError.code).
    const showError = (e: unknown) => {
      // ApiError carries the server message; anything else (network failure, demo
      // shim throw, apiFetch guard) falls back to a generic message so the dialog
      // never clears `saving` without surfacing the failure.
      const msg =
        e instanceof ApiError ? e.message || "Save failed" : "Save failed";
      if (e instanceof ApiError && e.code === "name_taken") {
        setNameError(msg);
        setCwdError(null);
      } else {
        setCwdError(msg);
        setNameError(null);
      }
    };

    if (isSpawn) {
      setCwdError(null);
      setNameError(null);
      setSaving(true);
      // username is server-derived (attributionFor) — not sent. The created
      // agent rides the agent_added broadcast. We read the { agent } body only
      // to get its id for the privileged two-step (privilege is its own
      // user-gated route, never a spawn field — so no agent can self-confer).
      apiFetch<{ agent: AgentInfo }>("POST", "/api/agents", {
        name: name || `Agent ${props.deskIndex + 1}`,
        cwd,
        roomId: props.roomId,
        desk: props.deskIndex,
        permissionMode,
        outfit,
        customInstructions: customInstructions.trim() || undefined,
        modelFamily,
        effort,
        agentType,
        ...(isCodex ? { codexSandbox } : {}),
      } satisfies SpawnReq)
        .then((res) =>
          privileged
            ? apiFetch("PUT", `/api/agents/${res.agent.id}/privileged`, {
                privileged: true,
              } satisfies SetPrivilegedReq)
            : undefined,
        )
        .then(() => onClose())
        .catch(showError)
        .finally(() => setSaving(false));
    } else {
      const engineChanged = targetEngine !== agentType;
      const changes: EditAgentReq = {};
      if (name.trim() && name.trim() !== agent!.name)
        changes.name = name.trim();
      if (cwd.trim() && cwd.trim() !== agent!.cwd) changes.cwd = cwd.trim();
      if (JSON.stringify(outfit) !== JSON.stringify(agent!.outfit))
        changes.outfit = outfit;
      const trimmedInstructions = customInstructions.trim();
      if (trimmedInstructions !== (agent!.customInstructions ?? ""))
        changes.customInstructions = trimmedInstructions;
      if (engineChanged) {
        // The menus now show the new engine's options, so send the chosen
        // values along with the switch; the server validates each against the
        // target engine.
        changes.agentType = targetEngine;
        changes.modelFamily = modelFamily;
        changes.effort = effort;
        changes.permissionMode = permissionMode;
        if (targetEngine === "codex") changes.codexSandbox = codexSandbox;
      } else {
        if (modelFamily !== agent!.modelFamily)
          changes.modelFamily = modelFamily;
        if (effort !== agent!.effort) changes.effort = effort;
        if (permissionMode !== agent!.permissionMode)
          changes.permissionMode = permissionMode;
        if (
          isCodex &&
          codexSandbox !== (agent!.codexSandbox ?? "workspace-write")
        )
          changes.codexSandbox = codexSandbox;
      }
      const hasChanges = !!(
        changes.name ||
        changes.cwd ||
        changes.outfit ||
        changes.customInstructions !== undefined ||
        changes.modelFamily ||
        changes.effort ||
        changes.permissionMode ||
        changes.codexSandbox ||
        changes.agentType
      );
      // Privilege is its OWN user-gated route (PUT /privileged), never part of
      // the PATCH — it re-mints the token and restarts the session like a model
      // change. Toggled independently of the other field edits.
      const privilegedChanged = privileged !== (agent!.privileged ?? false);
      if (!hasChanges && !privilegedChanged && !mem.dirty) {
        onClose();
        return;
      }
      setCwdError(null);
      setNameError(null);
      // Thunks, run SEQUENTIALLY (not Promise.all): a cwd/engine PATCH and a
      // privilege PUT each trigger a server-side session-swap, and two
      // overlapping swaps on one agent would race replaceSession. Ordering them
      // keeps each swap clean (both re-read the freshly re-minted token).
      const ops: Array<() => Promise<unknown>> = [];
      if (hasChanges)
        ops.push(() => apiFetch("PATCH", `/api/agents/${agent!.id}`, changes));
      if (privilegedChanged)
        ops.push(() =>
          apiFetch("PUT", `/api/agents/${agent!.id}/privileged`, {
            privileged,
          } satisfies SetPrivilegedReq),
        );
      const runSeq = () =>
        ops.reduce<Promise<unknown>>((p, op) => p.then(op), Promise.resolve());
      // Block the dialog (await + surface errors) when something restarts the
      // session — a cwd change (server cwd validation), an engine switch (fresh
      // conversation), or a privilege toggle (token re-mint + session-swap) —
      // so the user sees it took before closing. Other edits stay
      // fire-and-forget with an optimistic close (prior behavior).
      if (changes.cwd || changes.agentType || privilegedChanged || mem.dirty) {
        // A session-swap (cwd/engine/privilege) or a destructive memory REPLACE
        // must await + surface its error before closing — never fire-and-forget.
        setSaving(true);
        runSeq()
          .then(async () => {
            const m = await mem.save();
            if (!m.ok) {
              setCwdError(m.message);
              setNameError(null);
              return;
            }
            onClose();
          })
          .catch(showError)
          .finally(() => setSaving(false));
      } else {
        runSeq().catch(() => {});
        onClose();
      }
    }
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        className={isMobile ? undefined : "edit-agent-dialog-desktop"}
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: isMobile ? "none" : "1px solid var(--border-light)",
          borderRadius: isMobile ? 0 : 16,
          display: "flex",
          flexDirection: "column",
          width: isMobile ? "100%" : undefined,
          maxWidth: isMobile ? "100%" : undefined,
          height: isMobile ? "100dvh" : undefined,
          maxHeight: isMobile ? "100dvh" : "90vh",
          boxShadow: isMobile ? "none" : "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <div
          style={{
            overflowY: "auto",
            flex: 1,
            padding: isMobile
              ? "max(24px, env(safe-area-inset-top)) 20px 0"
              : "24px 28px 0",
          }}
        >
          <h3
            style={{
              fontSize: 17,
              fontWeight: 700,
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            {isSpawn ? "Spawn New Agent" : "Edit Agent"}
          </h3>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-faint)",
              margin: "2px 0 18px",
            }}
          >
            {isSpawn
              ? `Desk #${props.deskIndex + 1}`
              : `${roomCount > 1 && agentRoomName ? `${agentRoomName}, ` : ""}Desk #${agent!.desk + 1}`}
          </p>

          <label style={labelStyle}>Name</label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            placeholder={isSpawn ? `Agent ${props.deskIndex + 1}` : undefined}
            autoFocus={isSpawn}
            style={
              nameError ? { ...inputStyle, borderColor: "#ff6b6b" } : inputStyle
            }
          />
          {nameError && (
            <p style={{ fontSize: 10, color: "#ff6b6b", margin: "4px 0 0" }}>
              {nameError}
            </p>
          )}

          <label style={{ ...labelStyle, marginTop: 12 }}>
            Working Directory
          </label>
          <input
            value={cwd}
            onChange={(e) => {
              setCwd(e.target.value);
              if (cwdError) setCwdError(null);
            }}
            style={
              cwdError ? { ...inputStyle, borderColor: "#ff6b6b" } : inputStyle
            }
          />
          {cwdError && (
            <p style={{ fontSize: 10, color: "#ff6b6b", margin: "4px 0 0" }}>
              {cwdError}
            </p>
          )}
          {recentCwds.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {recentCwds.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    setCwd(c);
                    if (cwdError) setCwdError(null);
                  }}
                  style={chipStyle}
                >
                  {c.replace(/^\/home\/[^/]+/, "~")}
                </button>
              ))}
            </div>
          )}
          {!isSpawn && (
            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "3px 0 0",
              }}
            >
              Changes take effect on next conversation.
            </p>
          )}

          {/* Manager — set at spawn, immutable. Rendered as a read-only
              badge in both spawn and edit modes so there's no UX
              divergence on which user the agent is bound to. Style
              matches the Engine badge (also locked at spawn). On spawn
              the value comes from the device's bound username; on edit
              it comes from the agent's persisted user record. */}
          <label style={{ ...labelStyle, marginTop: 12 }}>Manager</label>
          <div
            title="Set at spawn — manager cannot be changed after the agent is created."
            style={{
              ...inputStyle,
              display: "flex",
              alignItems: "center",
              color: "var(--text-muted)",
              fontFamily: "'JetBrains Mono',monospace",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontWeight: 600,
              cursor: "not-allowed",
              background: "var(--bg-elevated)",
            }}
          >
            {isSpawn
              ? (getUsername() ?? "(no user assigned)")
              : (agent!.username ?? agent!.userId ?? "(unowned)")}
          </div>
          <p
            style={{
              fontSize: 10,
              color: "var(--text-ghost)",
              margin: "3px 0 0",
            }}
          >
            Locked to the spawning user. Controls which <code>envFile</code>{" "}
            loads on each session (see User Settings).
          </p>

          {/* Privileged operator access. Grants this agent its spawning user's
            room-scoped operator powers (drive other agents' sessions: resume,
            new conversation, send-now, lifecycle; plus cron over the user's own
            jobs). Scope stays the agent — it never posts as the user. Conferred
            via the dedicated user-gated route, so toggling a running agent
            re-mints its token and restarts its session, like a model change.
            Shown only to a user who may actually set it (owner, or the agent's
            manager — see canTogglePrivilege). */}
          {canTogglePrivilege && (
            <>
              <label
                style={{
                  marginTop: 14,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={privileged}
                  onChange={(e) => setPrivileged(e.target.checked)}
                  style={{ cursor: "pointer", margin: 0 }}
                />
                Privileged operator access
              </label>
              <p
                style={{
                  fontSize: 10,
                  color: "var(--text-ghost)",
                  margin: "3px 0 0",
                }}
              >
                Lets this agent drive other agents' sessions (resume, new
                conversation, send-now) and manage its own cronjobs, with the
                spawning user's room-scoped permissions. It still acts as the
                agent, never as the user.
                {!isSpawn &&
                  privileged !== (agent!.privileged ?? false) &&
                  " Saving restarts the agent's session."}
              </p>
            </>
          )}

          {/* Engine. Locked at spawn (chosen via the EngineChooserDialog before
            this opens). Editable in edit mode: switching it starts a fresh
            conversation on the new engine — the current one is preserved in the
            agent's resume history, and the model/effort/approval menus below
            repopulate with the selected engine's options. */}
          <label style={{ ...labelStyle, marginTop: 12 }}>Engine</label>
          {isSpawn ? (
            <div
              title="Pick a different engine by cancelling and using the other button."
              style={{
                ...inputStyle,
                display: "flex",
                alignItems: "center",
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono',monospace",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontWeight: 600,
                cursor: "not-allowed",
                background: "var(--bg-elevated)",
              }}
            >
              {agentType}
            </div>
          ) : (
            <>
              <select
                value={targetEngine}
                onChange={(e) =>
                  setTargetEngine(e.target.value as AgentBackendType)
                }
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              {targetEngine !== agentType && (
                <p
                  style={{
                    margin: "6px 0 0",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    lineHeight: 1.4,
                  }}
                >
                  Switching to {targetEngine === "codex" ? "Codex" : "Claude"}{" "}
                  starts a new conversation. The current one stays in this
                  agent's resume history.
                </p>
              )}
            </>
          )}

          <label style={{ ...labelStyle, marginTop: 12 }}>
            {isCodex ? "Approval Policy" : "Permission Mode"}
          </label>
          <select
            value={permissionMode}
            onChange={(e) =>
              setPermissionMode(e.target.value as AgentInfo["permissionMode"])
            }
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            {isCodex ? (
              <>
                <option value="untrusted">Untrusted (ask on every tool)</option>
                <option value="on-request">
                  On request (model asks when needed)
                </option>
                <option value="never">Never ask (use sandbox-only)</option>
              </>
            ) : (
              <>
                {claudeFamilySupportsAutoPermission(modelFamily) && (
                  <option value="auto">
                    Auto (classifier auto-approves safe actions)
                  </option>
                )}
                <option value="default">Default (ask for everything)</option>
                <option value="acceptEdits">
                  Accept Edits (auto-approve file changes)
                </option>
                <option value="bypassPermissions">
                  Bypass (auto-approve all)
                </option>
              </>
            )}
          </select>

          {isCodex && (
            <>
              <label style={{ ...labelStyle, marginTop: 12 }}>Sandbox</label>
              <select
                value={codexSandbox}
                onChange={(e) =>
                  setCodexSandbox(e.target.value as CodexSandboxMode)
                }
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
              >
                <option value="read-only">
                  Read-only (model can read, never write)
                </option>
                <option value="workspace-write">
                  Workspace write (write inside cwd only)
                </option>
                <option value="danger-full-access">
                  Danger: full access (no sandbox)
                </option>
              </select>
            </>
          )}

          <label style={{ ...labelStyle, marginTop: 12 }}>Model</label>
          {(() => {
            // Codex model options come from the server (auth-aware via
            // model/list). On fetch failure OR an empty list we fall back to the
            // hardcoded CODEX_MODELS list so the dialog is still usable (an empty
            // fetched list would otherwise render a zero-option select). Claude
            // uses the static MODEL_FAMILIES list either way.
            const codexFetched =
              isCodex && backendModels && backendModels.length > 0;
            const codexVisible = codexFetched
              ? backendModels.filter((m) => !m.hidden)
              : null;
            // Pin the stored model as an extra option whenever the rendered
            // list (the fetched list OR the CODEX_MODELS fallback) lacks it, so
            // editing never silently drops a value not offered on this login.
            const renderedModelIds = codexVisible
              ? codexVisible.map((m) => m.id)
              : CODEX_MODELS.map((m) => m.value);
            const storedNotInList =
              !isSpawn && isCodex && !renderedModelIds.includes(modelFamily);
            return (
              <select
                value={modelFamily}
                onChange={(e) => {
                  const next = e.target.value;
                  setModelFamily(next);
                  if (
                    !isCodex &&
                    !claudeFamilySupportsAutoPermission(next) &&
                    permissionMode === "auto"
                  )
                    setPermissionMode("bypassPermissions");
                  if (
                    !isCodex &&
                    !claudeFamilySupportsMaxEffort(next) &&
                    effort === "max"
                  )
                    setEffort("xhigh");
                  // Codex: when the model changes, snap effort to the new
                  // model's default if the current effort isn't supported.
                  if (isCodex && codexVisible) {
                    const picked = codexVisible.find((m) => m.id === next);
                    if (picked) {
                      const supported = new Set(
                        picked.supportedEfforts.map((o) => o.level),
                      );
                      if (!supported.has(effort) && picked.defaultEffort) {
                        setEffort(picked.defaultEffort as EffortLevel);
                      }
                    }
                  }
                }}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                disabled={isCodex && modelsLoading}
              >
                {isCodex ? (
                  <>
                    {codexVisible
                      ? codexVisible.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))
                      : CODEX_MODELS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                    {storedNotInList && (
                      <option key={modelFamily} value={modelFamily}>
                        {modelFamily} (unavailable on current login)
                      </option>
                    )}
                  </>
                ) : (
                  MODEL_FAMILIES.map((m) => (
                    <option key={m.family} value={m.family}>
                      {m.label} ({modelVersionLabel(m.family)})
                    </option>
                  ))
                )}
              </select>
            );
          })()}
          {isCodex && modelsLoading && (
            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "3px 0 0",
              }}
            >
              Loading available models…
            </p>
          )}
          {isCodex && modelsError && !modelsLoading && (
            <p
              style={{
                fontSize: 10,
                color: modelsError.authError ? "#ff6b6b" : "var(--text-ghost)",
                margin: "3px 0 0",
              }}
            >
              {modelsError.authError
                ? "Codex is not signed in. Open a Codex agent and click the sign-in card it emits, then re-open this dialog. (Or set OPENAI_API_KEY in your env.)"
                : `Could not load model list (${modelsError.message}). Showing fallback list — some options may not work on your account.`}
            </p>
          )}

          <label style={{ ...labelStyle, marginTop: 12 }}>
            Thinking Effort
          </label>
          {(() => {
            // For Codex we use the selected model's supportedReasoningEfforts
            // when available; otherwise we fall back to the global EFFORT_LEVELS
            // with the same backend/family filter we used pre-fetch.
            let effortLevels: { level: string; label: string }[];
            if (isCodex && backendModels) {
              const picked = backendModels.find((m) => m.id === modelFamily);
              if (picked && picked.supportedEfforts.length > 0) {
                // Map Codex effort enum strings to friendly labels using the
                // shared EFFORT_LEVELS table when present, falling back to the
                // raw enum value capitalized.
                effortLevels = picked.supportedEfforts.map((o) => {
                  const match = EFFORT_LEVELS.find((e) => e.level === o.level);
                  return {
                    level: o.level,
                    label: match
                      ? match.label
                      : o.level.charAt(0).toUpperCase() + o.level.slice(1),
                  };
                });
              } else {
                // Codex model with no supportedEfforts reported: fall back to
                // the EFFORT_LEVELS list minus "max"/"ultra" (not universal
                // across Codex models — e.g. luna lacks ultra; the dynamic
                // per-model list is the real source when available).
                effortLevels = EFFORT_LEVELS.filter(
                  (opt) => opt.level !== "max" && opt.level !== "ultra",
                ).map((o) => ({ level: o.level, label: o.label }));
              }
            } else {
              effortLevels = EFFORT_LEVELS.filter((opt) => {
                if (opt.level === "max")
                  return !isCodex && claudeFamilySupportsMaxEffort(modelFamily);
                if (opt.level === "minimal") return isCodex;
                if (opt.level === "ultra") return false; // per-model Codex list only
                return true;
              }).map((o) => ({ level: o.level, label: o.label }));
            }
            return (
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as EffortLevel)}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
              >
                {effortLevels.map((opt) => (
                  <option key={opt.level} value={opt.level}>
                    {opt.label}
                  </option>
                ))}
              </select>
            );
          })()}

          <label style={{ ...labelStyle, marginTop: 14 }}>Appearance</label>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginBottom: 10,
            }}
          >
            <div
              style={{
                width: 52,
                height: 70,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Character state="idle" outfit={outfit} />
            </div>
            <button
              onClick={() => setOutfit(makeRandomOutfit())}
              style={randomBtnStyle}
            >
              Randomize
            </button>
          </div>

          {/* Skin Color */}
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            Skin
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {SKIN_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setOutfit({ ...outfit, skin: c })}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: c,
                  cursor: "pointer",
                  border:
                    outfit.skin === c
                      ? "2px solid var(--text-primary)"
                      : "2px solid transparent",
                }}
              />
            ))}
          </div>

          {/* Shirt Color */}
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            Shirt
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {SHIRT_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setOutfit({ ...outfit, color: c })}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: c,
                  cursor: "pointer",
                  border:
                    outfit.color === c
                      ? "2px solid var(--text-primary)"
                      : "2px solid transparent",
                }}
              />
            ))}
          </div>

          {/* Hair Color */}
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            Hair Color
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {HAIR_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setOutfit({ ...outfit, hair: c })}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: c,
                  cursor: "pointer",
                  border:
                    outfit.hair === c
                      ? "2px solid var(--text-primary)"
                      : "2px solid transparent",
                }}
              />
            ))}
          </div>

          {/* Hair Style & Hat */}
          <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                Hair Style
              </div>
              <select
                value={outfit.hairStyle ?? "short"}
                onChange={(e) =>
                  setOutfit({
                    ...outfit,
                    hairStyle: e.target.value as AgentOutfit["hairStyle"],
                  })
                }
                style={selectStyle}
              >
                {HAIR_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {HAIR_STYLE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                Hat
              </div>
              <select
                value={outfit.hat}
                onChange={(e) =>
                  setOutfit({
                    ...outfit,
                    hat: e.target.value as AgentOutfit["hat"],
                  })
                }
                style={selectStyle}
              >
                {HATS.map((h) => (
                  <option key={h} value={h}>
                    {HAT_LABELS[h]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Beard & Accessory */}
          <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                Beard
              </div>
              <select
                value={outfit.beard ?? "none"}
                onChange={(e) =>
                  setOutfit({
                    ...outfit,
                    beard: e.target.value as AgentOutfit["beard"],
                  })
                }
                style={selectStyle}
              >
                {BEARDS.map((b) => (
                  <option key={b} value={b}>
                    {BEARD_LABELS[b]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                Accessory
              </div>
              <select
                value={outfit.accessory ?? "none"}
                onChange={(e) =>
                  setOutfit({
                    ...outfit,
                    accessory:
                      e.target.value === "none"
                        ? null
                        : (e.target.value as AgentOutfit["accessory"]),
                  })
                }
                style={selectStyle}
              >
                {ACCESSORIES.map((a) => (
                  <option key={a ?? "none"} value={a ?? "none"}>
                    {ACCESSORY_LABELS[a ?? "none"]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label style={{ ...labelStyle, marginTop: 14 }}>
            Custom Instructions{" "}
            <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
              (optional)
            </span>
          </label>
          <textarea
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder='e.g. "You are a backend specialist. Always write tests."'
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <p
            style={{
              fontSize: 10,
              color: "var(--text-ghost)",
              margin: "3px 0 0",
            }}
          >
            Run <code>/isomux-system-prompt</code> in a chat to see the agent's
            full system prompt.
            {!isSpawn && " Changes take effect on next conversation."}
          </p>

          {!isSpawn && (
            <>
              <label style={{ ...labelStyle, marginTop: 14 }}>
                Memory{" "}
                <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                  (durable facts for this agent; raw lines)
                </span>
              </label>
              <textarea
                value={mem.memory}
                onChange={(e) => mem.setMemory(e.target.value)}
                placeholder={
                  mem.loaded
                    ? "Some memory relevant to this agent"
                    : "Loading memory…"
                }
                rows={4}
                readOnly={!mem.loaded}
                style={{ ...inputStyle, resize: "vertical" }}
              />
              <p
                style={{
                  fontSize: 10,
                  color: "var(--text-ghost)",
                  margin: "3px 0 0",
                }}
              >
                This editor rewrites the file exactly as shown. Use one memory
                per line; keep existing author/date text unless you mean to
                change it.
              </p>
            </>
          )}

          {/* Move to Room — only show when multiple rooms exist and editing */}
          {!isSpawn && roomCount > 1 && (
            <>
              <label style={{ ...labelStyle, marginTop: 14 }}>
                Move to Room
              </label>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {Array.from({ length: roomCount }, (_, i) => {
                  if (rooms[i]?.id === agent!.roomId) return null;
                  const roomAgentCount = agents.filter(
                    (a) => a.roomId === rooms[i]?.id,
                  ).length;
                  const isFull = roomAgentCount >= 8;
                  return (
                    <button
                      key={i}
                      disabled={isFull}
                      onClick={() => {
                        const targetRoomId = rooms[i]?.id;
                        if (!targetRoomId) return;
                        apiFetch("POST", `/api/agents/${agent!.id}/move`, {
                          targetRoomId,
                        } satisfies MoveAgentReq).catch(() => {});
                        onClose();
                      }}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: isFull
                          ? "var(--bg-input)"
                          : "var(--btn-surface)",
                        color: isFull ? "var(--text-ghost)" : "var(--text-dim)",
                        fontSize: 11,
                        cursor: isFull ? "not-allowed" : "pointer",
                        fontFamily: "'JetBrains Mono',monospace",
                        opacity: isFull ? 0.5 : 1,
                      }}
                    >
                      {rooms[i]?.name ?? `Room ${i + 1}`} ({roomAgentCount}/8)
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: isMobile
              ? "16px 20px max(16px, env(safe-area-inset-bottom))"
              : "16px 28px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>
            Cancel
          </button>
          <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>
            {saving ? "Saving…" : isSpawn ? "Spawn" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = dialogLabel;
const inputStyle: React.CSSProperties = dialogInput;

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
  cursor: "pointer",
  width: "100%",
};

const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const chipStyle: React.CSSProperties = dialogChip;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;

const randomBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid var(--border-light)",
  background: "var(--bg-hover)",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
};
