export interface OpenCodeFreeModelCandidate {
  id: string;
  isFree?: boolean;
  hidden?: boolean;
}

export function preferredFreeOpenCodeModel<
  T extends OpenCodeFreeModelCandidate,
>(models: readonly T[], preferredId: string): T | undefined {
  const free = models.filter((model) => !model.hidden && model.isFree === true);
  // The fallback must not depend on the caller's list order: discovery sorts
  // by display label, so a copy-level label change would silently change
  // which model one-shot prompts run on. Pick by stable id order instead.
  return (
    free.find((model) => model.id === preferredId) ??
    [...free].sort((a, b) => a.id.localeCompare(b.id))[0]
  );
}
