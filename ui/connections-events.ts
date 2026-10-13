// The integrations list reloads after a variables editor saves, so a name the
// member just added shows in the list above the editor without a reload.
const listeners = new Set<() => void>();

export function onManagedEnvSaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyManagedEnvSaved(): void {
  for (const listener of listeners) listener();
}
