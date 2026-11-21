import { OPENCODE_DEFAULT_MODEL } from "./types.ts";

export interface OpenCodeFreeModelCandidate {
  id: string;
  isFree?: boolean;
  hidden?: boolean;
}

export function preferredFreeOpenCodeModel<
  T extends OpenCodeFreeModelCandidate,
>(models: readonly T[], preferredId: string): T | undefined {
  // Only the preferred model's provider. Another connected provider can list
  // cost-0 models that still need a subscription: OpenCode Go refuses its
  // "-free" models without one (measured 2026-09-26).
  const provider = preferredId.slice(0, preferredId.indexOf("/") + 1);
  const free = models.filter(
    (model) =>
      !model.hidden && model.isFree === true && model.id.startsWith(provider),
  );
  // The fallback must not depend on the caller's list order: discovery sorts
  // by display label, so a copy-level label change would silently change
  // which model a new agent defaults to. Pick by stable id order instead.
  return (
    free.find((model) => model.id === preferredId) ??
    [...free].sort((a, b) => a.id.localeCompare(b.id))[0]
  );
}

// The model an OpenCode agent gets when none is set: the office's preferred
// free model, then the model OpenCode marks default, then the first visible
// one. `officeFree` is true when the pick is the preferred free model, so the
// caller marks it as the office's choice (AgentInfo.officeFreeModel). The UI
// pickers and the server share it.
export function openCodeDefaultModel<
  T extends OpenCodeFreeModelCandidate & { isDefault?: boolean },
>(models: readonly T[]): { model: T; officeFree: boolean } | undefined {
  const visible = models.filter((model) => !model.hidden);
  const free = preferredFreeOpenCodeModel(visible, OPENCODE_DEFAULT_MODEL);
  if (free) return { model: free, officeFree: true };
  const model = visible.find((entry) => entry.isDefault) ?? visible[0];
  return model ? { model, officeFree: false } : undefined;
}
