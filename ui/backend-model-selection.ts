import {
  CODEX_MODELS,
  OPENCODE_DEFAULT_MODEL,
  type BackendModelWire,
} from "../shared/types.ts";
import { preferredFreeOpenCodeModel } from "../shared/opencode-model.ts";

export function defaultBackendModel(
  models: BackendModelWire[],
  isCodex: boolean,
): BackendModelWire | undefined {
  const visibleModels = models.filter((model) => !model.hidden);
  const preferredModelId = isCodex ? CODEX_MODELS[0].value : undefined;
  return (
    (preferredModelId
      ? visibleModels.find((model) => model.id === preferredModelId)
      : preferredFreeOpenCodeModel(visibleModels, OPENCODE_DEFAULT_MODEL)) ??
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
      ? "To use your own Anthropic or OpenAI API key with OpenCode, add ANTHROPIC_API_KEY or OPENAI_API_KEY under User Settings → Connections. Then reopen this dialog."
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
  subscription: BackendModelWire[];
} {
  if (!isOpenCode) return { available: models, free: [], subscription: [] };
  // OpenCode's house providers: "opencode" bills Zen credits per request,
  // "opencode-go" is the flat-rate Go subscription. Same key, same models
  // listed twice; the picker shows them as Pay-as-you-go and Subscription.
  const isSubscription = (model: BackendModelWire) =>
    model.id.startsWith("opencode-go/");
  return {
    available: models.filter(
      (model) => !model.isFree && !isSubscription(model),
    ),
    free: models.filter((model) => model.isFree),
    subscription: models.filter(
      (model) => !model.isFree && isSubscription(model),
    ),
  };
}
