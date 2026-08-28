import type { BackendModelWire } from "../shared/types.ts";

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
