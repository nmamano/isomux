export interface OpenCodeFreeModelCandidate {
  id: string;
  isFree?: boolean;
  hidden?: boolean;
  requiresConnection?: boolean;
}

export function preferredFreeOpenCodeModel<
  T extends OpenCodeFreeModelCandidate,
>(models: readonly T[], preferredId: string): T | undefined {
  const free = models.filter(
    (model) =>
      !model.hidden && model.isFree === true && !model.requiresConnection,
  );
  return free.find((model) => model.id === preferredId) ?? free[0];
}
