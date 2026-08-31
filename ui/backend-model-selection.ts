import {
  CODEX_MODELS,
  OPENCODE_DEFAULT_MODEL,
  type BackendModelWire,
} from "../shared/types.ts";

export function defaultBackendModel(
  models: BackendModelWire[],
  isCodex: boolean,
): BackendModelWire | undefined {
  const visibleModels = models.filter((model) => !model.hidden);
  const preferredModelId = isCodex
    ? CODEX_MODELS[0].value
    : OPENCODE_DEFAULT_MODEL;
  return (
    visibleModels.find((model) => model.id === preferredModelId) ??
    visibleModels.find((model) => model.isDefault) ??
    visibleModels[0]
  );
}

export function modelSelectCursor(
  usesBackendModels: boolean,
  modelsLoading: boolean,
): "not-allowed" | "pointer" {
  return usesBackendModels && modelsLoading ? "not-allowed" : "pointer";
}

export function modelListErrorMessage(
  isOpenCode: boolean,
  error: { message: string; authError: boolean },
): string {
  if (error.authError) {
    return isOpenCode
      ? "OpenCode has no connected provider for this environment. Use an OpenCode agent's login card, then reopen this dialog."
      : "Codex is not signed in. Open a Codex agent and click the sign-in card it emits, then reopen this dialog. (Or set OPENAI_API_KEY in your env.)";
  }
  const detail = error.message.trim();
  return isOpenCode
    ? `Could not load OpenCode models${detail ? ` (${detail})` : ""}. Reopen this dialog to try again.`
    : `Could not load model list${detail ? ` (${detail})` : ""}. Showing fallback list - some options may not work on your account.`;
}

export function openCodeModelSelectionReady(
  modelFamily: string,
  modelsLoading: boolean,
  modelsFailed: boolean,
  backendModels: BackendModelWire[] | null,
): boolean {
  if (!modelFamily) return false;
  if (modelsLoading || modelsFailed || backendModels === null) return true;
  return backendModels.some(
    (model) => !model.hidden && model.id === modelFamily,
  );
}

export function partitionBackendModelsForPicker(
  models: BackendModelWire[],
  isOpenCode: boolean,
): {
  available: BackendModelWire[];
  free: BackendModelWire[];
  connect: BackendModelWire[];
} {
  if (!isOpenCode) return { available: models, free: [], connect: [] };
  return {
    available: models.filter(
      (model) => !model.requiresConnection && !model.isFree,
    ),
    free: models.filter((model) => !model.requiresConnection && model.isFree),
    connect: models.filter((model) => model.requiresConnection),
  };
}
