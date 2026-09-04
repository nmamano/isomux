import {
  CODEX_MODELS,
  OPENCODE_DEFAULT_MODEL,
  type BackendModelWire,
} from "../shared/types.ts";
import { preferredFreeOpenCodeModel } from "../shared/opencode-model.ts";
import { apiFetch, ApiError } from "./api.ts";

export interface BackendModelsResponse {
  models: BackendModelWire[];
  authError?: boolean;
  error?: string;
}

interface FetchBackendModelsOptions {
  fetchFn?: (method: "GET", path: string) => Promise<BackendModelsResponse>;
  retries?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  onStarting?: () => void;
  startingDelayMs?: number;
}

// One retry can catch the server just after a cold start; the second covers a
// transient proxy failure without making a broken backend retry indefinitely.
export const BACKEND_MODEL_FETCH_RETRIES = 2;
// Keep retries close together because the request itself already waits for the
// bounded cold start; this pause only lets a newly started server settle.
export const BACKEND_MODEL_RETRY_DELAY_MS = 750;
// Warm discovery was measured at 2-5 seconds, so show startup state near the
// upper end of that range while the first cold-start request is still pending.
export const BACKEND_MODEL_STARTING_DELAY_MS = 4_000;

export async function fetchBackendModels(
  path: string,
  opts: FetchBackendModelsOptions = {},
): Promise<BackendModelsResponse> {
  const fetchFn = opts.fetchFn ?? apiFetch<BackendModelsResponse>;
  const retries = opts.retries ?? BACKEND_MODEL_FETCH_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? BACKEND_MODEL_RETRY_DELAY_MS;
  const sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const startingTimer = opts.onStarting
    ? setTimeout(
        opts.onStarting,
        opts.startingDelayMs ?? BACKEND_MODEL_STARTING_DELAY_MS,
      )
    : undefined;

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fetchFn("GET", path);
        if (!result.error || result.authError || attempt >= retries)
          return result;
      } catch (error) {
        const retryable = !(error instanceof ApiError) || error.status >= 500;
        if (!retryable || attempt >= retries) throw error;
      }
      opts.onStarting?.();
      await sleepFn(retryDelayMs);
    }
  } finally {
    if (startingTimer !== undefined) clearTimeout(startingTimer);
  }
}

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
      ? "OpenCode could not list its models. Reopen this dialog."
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
