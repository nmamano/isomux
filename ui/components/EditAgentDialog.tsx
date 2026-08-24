import { useEffect, useRef, useState } from "react";
import type {
  AgentBackendType,
  AgentInfo,
  AgentOutfit,
  BackendModelWire,
  CodexSandboxMode,
  EffortLevel,
  KilledAgentSummary,
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
import { DESK_COUNT } from "../../shared/desks.ts";
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
import {
  ExpandableTextarea,
  isExpandedEditorOpen,
} from "./ExpandableTextarea.tsx";
import type {
  MoveAgentReq,
  SpawnReq,
  EditAgentReq,
  SetPrivilegedReq,
  ReviveReq,
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
import { shortenCwd } from "../cwd-display.ts";
import {
  AGENT_TEMPLATES,
  blankRestoreValues,
  templateFormValues,
  templateEngineValues,
  type AgentTemplate,
} from "../agent-templates.ts";
import { ENGINE_ACCENT, ENGINE_OPTIONS } from "../engine-options.ts";

// Cap the recent-cwd suggestion chips so the row stays scannable even when the
// server is tracking its full history of working directories.
const MAX_CWD_SUGGESTIONS = 10;

export function codexNewEngineDefaults(isSpawn: boolean): {
  permissionMode: AgentInfo["permissionMode"];
  codexSandbox: CodexSandboxMode;
} {
  return isSpawn
    ? { permissionMode: "never", codexSandbox: "danger-full-access" }
    : { permissionMode: "on-request", codexSandbox: "workspace-write" };
}

export function templateValuesAfterEngineSwitch(
  template: AgentTemplate,
  targetEngine: AgentBackendType,
  isSpawn: boolean,
  backendModels: BackendModelWire[] | null,
  modelsFailed: boolean,
): Pick<
  ReturnType<typeof templateEngineValues>,
  "modelFamily" | "effort" | "permissionMode"
> {
  const targetDefaults =
    targetEngine === "codex"
      ? {
          modelFamily: CODEX_MODELS[0].value,
          effort: DEFAULT_EFFORT,
          permissionMode: codexNewEngineDefaults(isSpawn).permissionMode,
        }
      : {
          modelFamily: MODEL_FAMILIES[0].family,
          effort: DEFAULT_EFFORT,
          permissionMode: "auto" as AgentInfo["permissionMode"],
        };
  return templateEngineValues(
    template,
    targetEngine,
    targetDefaults,
    backendModels,
    modelsFailed,
  );
}

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

// Every value the dialog's form holds, flattened for the unsaved-changes check
// (task 5a20e3f0). `outfit` is pre-serialized because the form replaces the
// whole object on each swatch click, so identity says nothing.
export interface AgentFormSnapshot {
  name: string;
  cwd: string;
  outfit: string;
  customInstructions: string;
  targetEngine: AgentBackendType;
  modelFamily: string;
  effort: EffortLevel;
  permissionMode: AgentInfo["permissionMode"];
  codexSandbox: CodexSandboxMode;
  privileged: boolean;
}

// Does the form hold edits that closing would throw away? Agent memory is
// tracked separately by useMemoryEditor, so it comes in as its own flag.
// The free-text fields are trim-compared for the same reason handleSave trims
// before diffing: trailing whitespace the user can't see isn't a change worth
// a confirmation prompt. Exported for tests.
export function agentFormDirty(
  current: AgentFormSnapshot,
  baseline: AgentFormSnapshot,
  memoryDirty: boolean,
): boolean {
  if (memoryDirty) return true;
  const trimmed = ["name", "cwd", "customInstructions"] as const;
  for (const k of trimmed) {
    if (current[k].trim() !== baseline[k].trim()) return true;
  }
  const exact = [
    "outfit",
    "targetEngine",
    "modelFamily",
    "effort",
    "permissionMode",
    "codexSandbox",
    "privileged",
  ] as const;
  for (const k of exact) {
    if (current[k] !== baseline[k]) return true;
  }
  return false;
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
  const spawnProps = props.agent === undefined ? props : null;
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
    killedAgents,
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
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string | null>(
    null,
  );
  // Synchronous guard for the async Codex model-list response. Once the user
  // chooses a template, that choice owns model and effort until Blank is
  // selected; a late machine default must not overwrite it.
  const templateAppliedRef = useRef(false);
  // Agent memory (edit mode only) - edited via the unified /api/memory verbs
  // (load + version-guarded save), saved separately from the agent PATCH.
  const mem = useMemoryEditor("agent", agent?.id ?? null, !!agent?.id);
  const defaultModel = isCodex
    ? CODEX_MODELS[0].value
    : MODEL_FAMILIES[0].family;
  const [modelFamily, setModelFamily] = useState<string>(
    agent?.modelFamily ?? defaultModel,
  );
  const [effort, setEffort] = useState<EffortLevel>(
    agent?.effort ?? DEFAULT_EFFORT,
  );
  const codexNewEngineDefault = codexNewEngineDefaults(isSpawn);
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(
    agent?.codexSandbox ?? codexNewEngineDefault.codexSandbox,
  );
  const claudeDefaultMode: AgentInfo["permissionMode"] =
    agent?.permissionMode === "auto" &&
    !claudeFamilySupportsAutoPermission(
      agent?.modelFamily ?? MODEL_FAMILIES[0].family,
    )
      ? "bypassPermissions"
      : (agent?.permissionMode ?? "auto");
  const codexDefaultMode: AgentInfo["permissionMode"] =
    (agent?.permissionMode as AgentInfo["permissionMode"]) ??
    codexNewEngineDefault.permissionMode;
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
  const [reviving, setReviving] = useState<string | null>(null);
  const [reviveError, setReviveError] = useState<string | null>(null);
  // Save-time errors route to either the Name input or the Cwd input based on
  // the REST error code (name_taken -> Name). Errors that don't map to a specific
  // field (the common case, e.g. cwd validation) fall back to cwdError, where the
  // inline render lives.
  const [nameError, setNameError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [showRecentCwds, setShowRecentCwds] = useState(false);
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
  // a real spawn would see. Claude path doesn't need this - the family
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
  const templateModelsPending =
    isCodex && backendModels === null && modelsError === null;

  // What "unsaved" is measured against (task 5a20e3f0). Seeded from the same
  // values the form state above is seeded from, so on open the dialog is clean
  // in both spawn and edit mode. The two effects that re-seed the form
  // PROGRAMMATICALLY - the Codex model-list default pick, and the engine-switch
  // re-seed - re-stamp the affected entries: those aren't the user's edits, and
  // counting them as unsaved changes would put a discard prompt in front of
  // someone who has typed nothing.
  const formSnapshot: AgentFormSnapshot = {
    name,
    cwd,
    outfit: JSON.stringify(outfit),
    customInstructions,
    targetEngine,
    modelFamily,
    effort,
    permissionMode,
    codexSandbox,
    privileged,
  };
  // Copied, not aliased: the effects below re-stamp individual baseline entries
  // in place, and sharing the object with this render's snapshot would make
  // those writes invisible to the very comparison they exist for.
  const baselineRef = useRef<AgentFormSnapshot | null>(null);
  if (baselineRef.current === null) baselineRef.current = { ...formSnapshot };
  // The blank text/outfit values are mount-time values. Model, effort, and
  // permission are deliberately excluded because Codex refines those defaults
  // asynchronously and records the valid result in baselineRef.
  const initialBlankRef = useRef<{
    name: string;
    customInstructions: string;
    outfit: AgentOutfit;
  } | null>(null);
  if (initialBlankRef.current === null) {
    initialBlankRef.current = {
      name,
      customInstructions,
      outfit: { ...outfit },
    };
  }

  function applyTemplate(template: AgentTemplate) {
    templateAppliedRef.current = true;
    setSelectedTemplateKey(template.key);
    const values = templateFormValues(
      template,
      targetEngine,
      { modelFamily, effort, permissionMode },
      backendModels,
      modelsError !== null,
    );
    setName(values.name);
    setCustomInstructions(values.customInstructions);
    setOutfit(values.outfit);
    setModelFamily(values.modelFamily);
    setEffort(values.effort);
    setPermissionMode(values.permissionMode);
  }

  function applyBlankTemplate() {
    templateAppliedRef.current = false;
    setSelectedTemplateKey(null);
    // baselineRef follows Codex's machine-selected live default. Restoring its
    // values keeps Blank both valid and clean after model/list resolves.
    const values = blankRestoreValues(
      initialBlankRef.current!,
      baselineRef.current!,
    );
    setName(values.name);
    setCustomInstructions(values.customInstructions);
    setOutfit(values.outfit);
    setModelFamily(values.modelFamily);
    setEffort(values.effort);
    setPermissionMode(values.permissionMode);
  }

  function isDirty(): boolean {
    return agentFormDirty(formSnapshot, baselineRef.current!, mem.dirty);
  }

  // "Discard unsaved changes?" confirmation, same inline-strip convention as
  // the user settings page. `after` runs once the close is committed, so a
  // dismissal that also does something (Move to Room) can chain onto it.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  const pendingReviveRef = useRef<KilledAgentSummary | null>(null);

  // Every dismissal path routes through here: backdrop, Cancel, Escape,
  // Move to Room. Clean form closes immediately; dirty one asks first.
  function requestClose(after?: () => void) {
    if (isDirty()) {
      pendingDiscardActionRef.current = after ?? null;
      setConfirmDiscard(true);
    } else {
      onClose();
      after?.();
    }
  }

  function commitDiscard() {
    const revive = pendingReviveRef.current;
    pendingReviveRef.current = null;
    if (revive) {
      pendingDiscardActionRef.current = null;
      setConfirmDiscard(false);
      performRevive(revive);
      return;
    }
    const next = pendingDiscardActionRef.current;
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
    onClose();
    next?.();
  }

  function cancelDiscard() {
    pendingReviveRef.current = null;
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
  }

  function handleRevive(agentToRevive: KilledAgentSummary) {
    if (!isSpawn || reviving) return;
    if (isDirty()) {
      pendingReviveRef.current = agentToRevive;
      pendingDiscardActionRef.current = null;
      setConfirmDiscard(true);
      return;
    }
    performRevive(agentToRevive);
  }

  function performRevive(agentToRevive: KilledAgentSummary) {
    if (!spawnProps) return;
    setReviveError(null);
    setReviving(agentToRevive.id);
    apiFetch("POST", `/api/agents/${agentToRevive.id}/revive`, {
      desk: spawnProps.deskIndex,
      roomId: spawnProps.roomId,
    } satisfies ReviveReq)
      .then(() => onClose())
      .catch((e) => {
        setReviveError(
          e instanceof ApiError
            ? e.message || "Revive failed"
            : "Revive failed",
        );
      })
      .finally(() => setReviving(null));
  }

  // Escape. App's own handler clears editAgent/spawnReady on Escape and knows
  // nothing about unsaved edits (it doesn't even skip inputs, so Escape while
  // typing in the memory box would drop it), so we claim the key in the CAPTURE
  // phase and stop it there. No deps - re-registers every render so the closure
  // sees fresh form state.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // An expanded textarea overlay collapses on Escape instead of closing
      // this dialog; our capture listener runs first, so stand down for it.
      if (isExpandedEditorOpen()) return;
      e.stopPropagation();
      if (saving) return;
      if (confirmDiscard) cancelDiscard();
      else requestClose();
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  // Tab close / reload is the one dismissal the app can't intercept - the
  // browser's own prompt is the only guard available there.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty()) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });

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
  // codex - though in practice the agentType picker is locked at spawn.
  // GET backends.listModels: a DOMAIN failure (auth/transport in the executor's
  // model probe) comes back as a 200 carrying { models: [], authError, error },
  // NOT a thrown ApiError - so read r.error in .then(); only a real HTTP/network
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
        const selectedTemplate = AGENT_TEMPLATES.find(
          (template) => template.key === selectedTemplateKey,
        );
        if (selectedTemplate) {
          const values = templateValuesAfterEngineSwitch(
            selectedTemplate,
            targetEngine,
            isSpawn,
            r.models,
            false,
          );
          setModelFamily(values.modelFamily);
          setEffort(values.effort);
          setPermissionMode(values.permissionMode);
          baselineRef.current!.modelFamily = values.modelFamily;
          baselineRef.current!.effort = values.effort;
          baselineRef.current!.permissionMode = values.permissionMode;
          return;
        }
        // Pick the spawn default. Invariant: prefer Isomux's canonical
        // default (CODEX_MODELS[0], currently gpt-5.6-sol) when this auth tier
        // offers it; otherwise fall back to Codex's per-auth isDefault, then
        // the first listed model. We choose from the visible (non-hidden)
        // models so the value always matches a rendered <option>. The model
        // select is disabled during loading, so the user can't have made a
        // choice we'd be overriding.
        if (
          (isSpawn || targetEngine !== agentType) &&
          !templateAppliedRef.current
        ) {
          const preferredModelId = CODEX_MODELS[0].value;
          const visibleModels = r.models.filter((m) => !m.hidden);
          const def =
            visibleModels.find((m) => m.id === preferredModelId) ??
            visibleModels.find((m) => m.isDefault) ??
            visibleModels[0];
          if (def) {
            setModelFamily(def.id);
            // A machine-chosen default, not an edit - move the unsaved-changes
            // baseline with it (see baselineRef).
            baselineRef.current!.modelFamily = def.id;
            // Keep Isomux's DEFAULT_EFFORT when the model supports it; only
            // adopt the model's own reported default when it doesn't.
            const supportsDefault = def.supportedEfforts.some(
              (o) => o.level === DEFAULT_EFFORT,
            );
            if (!supportsDefault && def.defaultEffort) {
              setEffort(def.defaultEffort as EffortLevel);
              baselineRef.current!.effort = def.defaultEffort as EffortLevel;
            }
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
  // effort here are provisional - the model/list effect above refines them once
  // the auth-appropriate list loads.
  const didInitEngine = useRef(false);
  useEffect(() => {
    if (!didInitEngine.current) {
      didInitEngine.current = true;
      return;
    }
    // Synchronous re-seed in response to the engine flip - same intentional
    // pattern (and rule suppression) as the model/list effect above.
    let seed: {
      modelFamily: string;
      effort: EffortLevel;
      permissionMode: AgentInfo["permissionMode"];
      codexSandbox?: CodexSandboxMode;
    };
    if (targetEngine === agentType) {
      seed = {
        modelFamily:
          agent?.modelFamily ??
          (agentType === "codex"
            ? CODEX_MODELS[0].value
            : MODEL_FAMILIES[0].family),
        effort: agent?.effort ?? DEFAULT_EFFORT,
        permissionMode: initialPermissionMode,
        codexSandbox: agent?.codexSandbox ?? "workspace-write",
      };
    } else if (targetEngine === "codex") {
      const codexDefault = codexNewEngineDefaults(isSpawn);
      seed = {
        modelFamily: CODEX_MODELS[0].value,
        effort: DEFAULT_EFFORT,
        ...codexDefault,
      };
    } else {
      const claudeDefault = MODEL_FAMILIES[0].family;
      seed = {
        modelFamily: claudeDefault,
        effort: DEFAULT_EFFORT,
        permissionMode: claudeFamilySupportsAutoPermission(claudeDefault)
          ? "auto"
          : "default",
      };
    }
    const selectedTemplate = AGENT_TEMPLATES.find(
      (template) => template.key === selectedTemplateKey,
    );
    if (selectedTemplate && targetEngine === "claude") {
      const values = templateValuesAfterEngineSwitch(
        selectedTemplate,
        targetEngine,
        isSpawn,
        null,
        false,
      );
      seed.modelFamily = values.modelFamily;
      seed.effort = values.effort;
      seed.permissionMode = values.permissionMode;
    }
    /* eslint-disable react-hooks/set-state-in-effect */
    setModelFamily(seed.modelFamily);
    setEffort(seed.effort);
    setPermissionMode(seed.permissionMode);
    if (seed.codexSandbox !== undefined) setCodexSandbox(seed.codexSandbox);
    /* eslint-enable react-hooks/set-state-in-effect */
    // These follow the engine the user picked rather than being edits of their
    // own, so they move the baseline; `targetEngine` itself stays measured
    // against the original, which is what keeps an engine switch "unsaved".
    baselineRef.current!.modelFamily = seed.modelFamily;
    baselineRef.current!.effort = seed.effort;
    baselineRef.current!.permissionMode = seed.permissionMode;
    if (seed.codexSandbox !== undefined)
      baselineRef.current!.codexSandbox = seed.codexSandbox;
    if (isSpawn) baselineRef.current!.targetEngine = targetEngine;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEngine]);

  function handleSave() {
    // Save supersedes an in-flight discard prompt: the user picked Save over
    // Discard, so the stashed action must not be able to replay later.
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
    // name_taken routes under the Name input; everything else under cwd (the
    // prior agent_save_response.field === "name" routing, now keyed on the REST
    // ApiError.code).
    const showError = (e: unknown) => {
      // ApiError carries the server message; anything else (network failure, demo
      // shim throw, apiFetch guard) falls back to a generic message so the dialog
      // never clears `saving` without surfacing the failure.
      const msg =
        e instanceof ApiError && e.code === "version_conflict"
          ? "Custom instructions changed since you opened this - reopen the dialog to edit the latest."
          : e instanceof ApiError
            ? e.message || "Save failed"
            : "Save failed";
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
      // username is server-derived (attributionFor) - not sent. The created
      // agent rides the agent_added broadcast. We read the { agent } body only
      // to get its id for the privileged two-step (privilege is its own
      // user-gated route, never a spawn field - so no agent can self-confer).
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
        agentType: targetEngine,
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
      if (trimmedInstructions !== (agent!.customInstructions ?? "")) {
        changes.customInstructions = trimmedInstructions;
        // Blob-bearing writes are version-guarded: echo the token from the
        // agent object (kept current by agent_updated) so a concurrent edit
        // surfaces as a 409 instead of a silent clobber.
        changes.customInstructionsVersion = agent!.customInstructionsVersion;
      }
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
      // the PATCH - it re-mints the token and restarts the session like a model
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
      // session - a cwd change (server cwd validation), an engine switch (fresh
      // conversation), or a privilege toggle (token re-mint + session-swap) -
      // or when the edit can meaningfully FAIL: a custom-instructions change is
      // version-guarded (409 on a concurrent edit), so it must await and
      // surface the conflict, never fire-and-forget past it. Other edits stay
      // fire-and-forget with an optimistic close (prior behavior).
      if (
        changes.cwd ||
        changes.agentType ||
        changes.customInstructions !== undefined ||
        privilegedChanged ||
        mem.dirty
      ) {
        // A session-swap (cwd/engine/privilege) or a destructive memory REPLACE
        // must await + surface its error before closing - never fire-and-forget.
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
        if (e.target === e.currentTarget) requestClose();
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
        className={
          isMobile
            ? undefined
            : isSpawn
              ? "spawn-agent-dialog-desktop"
              : "edit-agent-dialog-desktop"
        }
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
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginBottom: isSpawn ? 18 : 0,
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
            {isSpawn && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Desk #{props.deskIndex + 1}
              </span>
            )}
          </div>
          {!isSpawn && (
            <p
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                margin: "2px 0 18px",
              }}
            >
              {`${roomCount > 1 && agentRoomName ? `${agentRoomName}, ` : ""}Desk #${agent!.desk + 1}`}
            </p>
          )}

          <div className="agent-dialog-grid">
            <div className="agent-dialog-left-column">
              {isSpawn ? (
                <section className="agent-engine-section">
                  <label style={labelStyle}>Engine</label>
                  <div className="spawn-engine-options">
                    {ENGINE_OPTIONS.map((option) => {
                      const selected = targetEngine === option.agentType;
                      return (
                        <button
                          key={option.agentType}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setTargetEngine(option.agentType)}
                          style={{
                            background: selected
                              ? "var(--bg-hover)"
                              : "var(--bg-surface)",
                            border: `2px solid ${selected ? option.accent : "var(--border-medium)"}`,
                            borderRadius: 8,
                            padding: "12px 14px",
                            textAlign: "left",
                            cursor: "pointer",
                            color: "var(--text-primary)",
                            boxShadow: selected
                              ? `0 0 0 1px ${option.accent}`
                              : "none",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              fontSize: 15,
                              fontWeight: 700,
                              marginBottom: 4,
                            }}
                          >
                            {option.label}
                          </span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 12,
                              color: "var(--text-dim)",
                              lineHeight: 1.4,
                            }}
                          >
                            {option.blurb}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : (
                /* Editable in edit mode: switching starts a fresh conversation
                on the new engine. The current conversation stays in resume
                history, and the settings use the new engine's options. */
                <section className="agent-engine-section">
                  <label style={labelStyle}>Engine</label>
                  <select
                    value={targetEngine}
                    onChange={(e) =>
                      setTargetEngine(e.target.value as AgentBackendType)
                    }
                    style={{
                      ...inputStyle,
                      appearance: "none",
                      cursor: "pointer",
                    }}
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
                      Switching to{" "}
                      {targetEngine === "codex" ? "Codex" : "Claude"} starts a
                      new conversation. The current one stays in this agent's
                      resume history.
                    </p>
                  )}
                </section>
              )}

              {isSpawn && (
                <section className="spawn-template-section">
                  <label style={labelStyle}>Start with a template</label>
                  <p
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      margin: "3px 0 8px",
                    }}
                  >
                    Templates fill the fields below. You can edit every
                    suggestion.
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: isMobile
                        ? "repeat(2, minmax(0, 1fr))"
                        : "repeat(3, minmax(0, 1fr))",
                      gap: 6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={applyBlankTemplate}
                      aria-pressed={selectedTemplateKey === null}
                      style={{
                        ...templateCardStyle(
                          selectedTemplateKey === null,
                          false,
                        ),
                        gridColumn: "1 / -1",
                      }}
                    >
                      <span style={templateCardTextStyle}>
                        <span style={templateCardTitleStyle}>Blank</span>
                        <span style={templateCardDescriptionStyle}>
                          Set up the agent yourself.
                        </span>
                      </span>
                    </button>
                    {AGENT_TEMPLATES.map((template) => {
                      const selected = selectedTemplateKey === template.key;
                      return (
                        <button
                          key={template.key}
                          type="button"
                          disabled={templateModelsPending}
                          onClick={() => applyTemplate(template)}
                          aria-pressed={selected}
                          style={templateCardStyle(
                            selected,
                            templateModelsPending,
                            template.group,
                          )}
                        >
                          <span style={templateAvatarStyle} aria-hidden="true">
                            <Character
                              state="idle"
                              outfit={template.outfit}
                              portrait
                              height={44}
                            />
                          </span>
                          <span style={templateCardTextStyle}>
                            <span style={templateCardTitleStyle}>
                              {template.label}
                            </span>
                            <span style={templateCardDescriptionStyle}>
                              {template.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {templateModelsPending && (
                    <p
                      style={{
                        fontSize: 10,
                        color: "var(--text-muted)",
                        margin: "6px 0 0",
                      }}
                    >
                      Loading models before templates can be applied…
                    </p>
                  )}
                </section>
              )}

              <div className="agent-appearance-section">
                <label style={{ ...labelStyle, marginTop: 14 }}>
                  Appearance
                </label>
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
              </div>
            </div>

            <div className="agent-dialog-right-column">
              <div className="agent-identity-section">
                <label style={labelStyle}>Name</label>
                {/* Mobile autofocus would scroll the engine and templates out of view
              as soon as the full-page spawn dialog opens. */}
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  placeholder={
                    isSpawn ? `Agent ${props.deskIndex + 1}` : undefined
                  }
                  autoFocus={isSpawn && !isMobile}
                  style={
                    nameError
                      ? { ...inputStyle, borderColor: "#ff6b6b" }
                      : inputStyle
                  }
                />
                {nameError && (
                  <p
                    style={{
                      fontSize: 10,
                      color: "#ff6b6b",
                      margin: "4px 0 0",
                    }}
                  >
                    {nameError}
                  </p>
                )}

                <label style={{ ...labelStyle, marginTop: 12 }}>
                  Working Directory
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={cwd}
                    onChange={(e) => {
                      setCwd(e.target.value);
                      if (cwdError) setCwdError(null);
                    }}
                    style={
                      cwdError
                        ? { ...inputStyle, borderColor: "#ff6b6b" }
                        : inputStyle
                    }
                  />
                  {recentCwds.length > 0 && (
                    <button
                      type="button"
                      aria-expanded={showRecentCwds}
                      aria-controls="recent-cwd-suggestions"
                      onClick={() => setShowRecentCwds((shown) => !shown)}
                      style={{ ...dialogCancelBtn, padding: "7px 10px" }}
                    >
                      Recent
                    </button>
                  )}
                </div>
                {cwdError && (
                  <p
                    style={{
                      fontSize: 10,
                      color: "#ff6b6b",
                      margin: "4px 0 0",
                    }}
                  >
                    {cwdError}
                  </p>
                )}
                {showRecentCwds && recentCwds.length > 0 && (
                  <div
                    id="recent-cwd-suggestions"
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
                          setShowRecentCwds(false);
                          if (cwdError) setCwdError(null);
                        }}
                        style={chipStyle}
                      >
                        {shortenCwd(c)}
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

                {/* Manager - set at spawn, immutable. Rendered as a read-only
                badge in both spawn and edit modes so there's no UX
                divergence on which user the agent is bound to. Style
                matches the Engine badge (also locked at spawn). On spawn
                the value comes from the device's bound username; on edit
                it comes from the agent's persisted user record. */}
                <label style={{ ...labelStyle, marginTop: 12 }}>Manager</label>
                <div
                  title="Set at spawn - manager cannot be changed after the agent is created."
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
                    color: "var(--text-muted)",
                    margin: "3px 0 0",
                  }}
                >
                  Locked to the spawning user. Controls which{" "}
                  <code>envFile</code> loads on each session (see User
                  Settings).
                </p>

                {/* Privileged operator access. Grants this agent its spawning user's
              room-scoped operator powers (drive other agents' sessions: resume,
              new conversation, send-now, lifecycle; plus cron over the user's own
              jobs). Scope stays the agent - it never posts as the user. Conferred
              via the dedicated user-gated route, so toggling a running agent
              re-mints its token and restarts its session, like a model change.
              Shown only to a user who may actually set it (owner, or the agent's
              manager - see canTogglePrivilege). */}
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
                        color: "var(--text-muted)",
                        margin: "3px 0 0",
                      }}
                    >
                      Lets this agent drive other agents' sessions (resume, new
                      conversation, send-now) and manage its own cronjobs, with
                      the spawning user's room-scoped permissions. It still acts
                      as the agent, never as the user.
                      {!isSpawn &&
                        privileged !== (agent!.privileged ?? false) &&
                        " Saving restarts the agent's session."}
                    </p>
                  </>
                )}
              </div>

              <div className="agent-engine-settings">
                <label style={{ ...labelStyle, marginTop: 12 }}>
                  {isCodex ? "Approval Policy" : "Permission Mode"}
                </label>
                <select
                  value={permissionMode}
                  onChange={(e) =>
                    setPermissionMode(
                      e.target.value as AgentInfo["permissionMode"],
                    )
                  }
                  style={{
                    ...inputStyle,
                    appearance: "none",
                    cursor: "pointer",
                  }}
                >
                  {isCodex ? (
                    <>
                      <option value="untrusted">
                        Untrusted (ask on every tool)
                      </option>
                      <option value="on-request">
                        On request (model asks when needed)
                      </option>
                      <option value="never">
                        Never ask (use sandbox-only)
                      </option>
                    </>
                  ) : (
                    <>
                      {claudeFamilySupportsAutoPermission(modelFamily) && (
                        <option value="auto">
                          Auto (classifier auto-approves safe actions)
                        </option>
                      )}
                      <option value="default">
                        Default (ask for everything)
                      </option>
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
                    <label style={{ ...labelStyle, marginTop: 12 }}>
                      Sandbox
                    </label>
                    <select
                      value={codexSandbox}
                      onChange={(e) =>
                        setCodexSandbox(e.target.value as CodexSandboxMode)
                      }
                      style={{
                        ...inputStyle,
                        appearance: "none",
                        cursor: "pointer",
                      }}
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
                    !isSpawn &&
                    isCodex &&
                    !renderedModelIds.includes(modelFamily);
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
                          // Same coercion target the server's validateEffort uses
                          // for an invalid Claude "max".
                          setEffort(DEFAULT_EFFORT);
                        // Codex: when the model changes, snap effort to the new
                        // model's default if the current effort isn't supported.
                        if (isCodex && codexVisible) {
                          const picked = codexVisible.find(
                            (m) => m.id === next,
                          );
                          if (picked) {
                            const supported = new Set(
                              picked.supportedEfforts.map((o) => o.level),
                            );
                            if (
                              !supported.has(effort) &&
                              picked.defaultEffort
                            ) {
                              setEffort(picked.defaultEffort as EffortLevel);
                            }
                          }
                        }
                      }}
                      style={{
                        ...inputStyle,
                        appearance: "none",
                        cursor: "pointer",
                      }}
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
                      color: modelsError.authError
                        ? "#ff6b6b"
                        : "var(--text-ghost)",
                      margin: "3px 0 0",
                    }}
                  >
                    {modelsError.authError
                      ? "Codex is not signed in. Open a Codex agent and click the sign-in card it emits, then re-open this dialog. (Or set OPENAI_API_KEY in your env.)"
                      : `Could not load model list (${modelsError.message}). Showing fallback list - some options may not work on your account.`}
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
                    const picked = backendModels.find(
                      (m) => m.id === modelFamily,
                    );
                    if (picked && picked.supportedEfforts.length > 0) {
                      // Map Codex effort enum strings to friendly labels using the
                      // shared EFFORT_LEVELS table when present, falling back to the
                      // raw enum value capitalized.
                      effortLevels = picked.supportedEfforts.map((o) => {
                        const match = EFFORT_LEVELS.find(
                          (e) => e.level === o.level,
                        );
                        return {
                          level: o.level,
                          label: match
                            ? match.label
                            : o.level.charAt(0).toUpperCase() +
                              o.level.slice(1),
                        };
                      });
                    } else {
                      // Codex model with no supportedEfforts reported: fall back to
                      // the EFFORT_LEVELS list minus "max"/"ultra" (not universal
                      // across Codex models - e.g. luna lacks ultra; the dynamic
                      // per-model list is the real source when available).
                      effortLevels = EFFORT_LEVELS.filter(
                        (opt) => opt.level !== "max" && opt.level !== "ultra",
                      ).map((o) => ({ level: o.level, label: o.label }));
                    }
                  } else {
                    effortLevels = EFFORT_LEVELS.filter((opt) => {
                      if (opt.level === "max")
                        return (
                          !isCodex && claudeFamilySupportsMaxEffort(modelFamily)
                        );
                      if (opt.level === "minimal") return isCodex;
                      if (opt.level === "ultra") return false; // per-model Codex list only
                      return true;
                    }).map((o) => ({ level: o.level, label: o.label }));
                  }
                  return (
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as EffortLevel)}
                      style={{
                        ...inputStyle,
                        appearance: "none",
                        cursor: "pointer",
                      }}
                    >
                      {effortLevels.map((opt) => (
                        <option key={opt.level} value={opt.level}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  );
                })()}
              </div>
              <label style={{ ...labelStyle, marginTop: 14 }}>
                Custom Instructions{" "}
                <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                  (optional)
                </span>
              </label>
              <ExpandableTextarea
                title="Custom Instructions"
                hint="Personal system prompt for this agent. Run /isomux-system-prompt in a chat to see the agent's full system prompt."
                value={customInstructions}
                onChange={setCustomInstructions}
                placeholder='e.g. "You are a backend specialist. Always write tests."'
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
              <p
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  margin: "3px 0 0",
                }}
              >
                Run <code>/isomux-system-prompt</code> in a chat to see the
                agent's full system prompt.
                {!isSpawn && " Changes take effect on next conversation."}
              </p>
            </div>
          </div>

          {isSpawn && killedAgents.length > 0 && (
            <section
              style={{
                marginTop: 20,
                paddingTop: 16,
                paddingBottom: 14,
                borderTop: "1px solid var(--border)",
              }}
            >
              <label style={labelStyle}>Revive a killed agent</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {killedAgents.map((killedAgent) => {
                  const isThisReviving = reviving === killedAgent.id;
                  const disabled = reviving !== null && !isThisReviving;
                  return (
                    <button
                      key={killedAgent.id}
                      type="button"
                      disabled={disabled}
                      title={
                        killedAgent.topic
                          ? `${killedAgent.lastRoomName} - ${killedAgent.topic}`
                          : killedAgent.lastRoomName
                      }
                      onClick={() => handleRevive(killedAgent)}
                      style={{
                        background: "var(--bg-surface)",
                        border: `1.5px solid ${ENGINE_ACCENT[killedAgent.agentType]}`,
                        borderRadius: 999,
                        padding: "5px 10px",
                        fontSize: 12,
                        color: "var(--text-primary)",
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.4 : 1,
                      }}
                    >
                      {isThisReviving ? "Reviving…" : killedAgent.name}
                    </button>
                  );
                })}
              </div>
              {reviveError && (
                <p
                  style={{ margin: "8px 0 0", fontSize: 12, color: "#ff6b6b" }}
                >
                  {reviveError}
                </p>
              )}
            </section>
          )}

          {!isSpawn && (
            <>
              <label style={{ ...labelStyle, marginTop: 14 }}>
                Memory{" "}
                <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                  (durable facts for this agent; raw lines; {mem.size} /{" "}
                  {mem.cap ?? "…"})
                </span>
              </label>
              <ExpandableTextarea
                title="Agent Memory"
                value={mem.memory}
                onChange={mem.setMemory}
                placeholder={
                  mem.loaded
                    ? "Some memory relevant to this agent"
                    : "Loading memory…"
                }
                rows={4}
                readOnly={!mem.loaded}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </>
          )}

          {/* Move to Room - only show when multiple rooms exist and editing */}
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
                  const isFull = roomAgentCount >= DESK_COUNT;
                  return (
                    <button
                      key={i}
                      disabled={isFull}
                      onClick={() => {
                        const targetRoomId = rooms[i]?.id;
                        if (!targetRoomId) return;
                        // Moving closes the dialog without saving the rest of
                        // the form, so it goes through the same discard gate as
                        // any other dismissal; the move fires once that commits.
                        requestClose(() => {
                          apiFetch("POST", `/api/agents/${agent!.id}/move`, {
                            targetRoomId,
                          } satisfies MoveAgentReq).catch(() => {});
                        });
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
        {/* Action footer. The discard prompt lives here rather than over the
            form so it sits next to the buttons that trigger it, and so it can't
            appear scrolled out of view. */}
        <div
          style={{
            padding: isMobile
              ? "16px 20px max(16px, env(safe-area-inset-bottom))"
              : "16px 28px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {confirmDiscard && (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 10,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-input)",
              }}
            >
              <span
                style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}
              >
                Discard unsaved changes?
              </span>
              <button
                onClick={commitDiscard}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--red)",
                  background: "var(--red)",
                  color: "var(--bg-base)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Discard
              </button>
              <button
                onClick={cancelDiscard}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={() => requestClose()}
              style={cancelBtnStyle}
              disabled={saving}
            >
              Cancel
            </button>
            <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>
              {saving ? "Saving…" : isSpawn ? "Spawn" : "Save"}
            </button>
          </div>
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

function templateCardStyle(
  selected: boolean,
  disabled: boolean,
  group?: AgentTemplate["group"],
): React.CSSProperties {
  const groupColor = group ? TEMPLATE_GROUP_COLORS[group] : null;
  return {
    minHeight: group ? 78 : 46,
    padding: "8px 9px",
    borderRadius: 7,
    border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    background: selected
      ? "var(--accent-muted, rgba(88,166,255,0.15))"
      : groupColor
        ? `color-mix(in srgb, ${groupColor} 8%, var(--bg-input))`
        : "var(--bg-input)",
    color: "var(--text-primary)",
    textAlign: "left",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    display: "flex",
    alignItems: "center",
    gap: 7,
    boxShadow: groupColor ? `inset 3px 0 0 ${groupColor}` : undefined,
  };
}

const TEMPLATE_GROUP_COLORS: Record<AgentTemplate["group"], string> = {
  build: "#4A90D9",
  work: "var(--success, #50b86c)",
  life: "var(--coral, #e85d75)",
  places: "var(--warning, #d4a843)",
};

const templateAvatarStyle: React.CSSProperties = {
  width: 34,
  height: 46,
  flex: "0 0 34px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const templateCardTextStyle: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const templateCardTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  lineHeight: 1.2,
};

const templateCardDescriptionStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--text-dim)",
  lineHeight: 1.3,
};

const randomBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid var(--border-light)",
  background: "var(--bg-hover)",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
};
