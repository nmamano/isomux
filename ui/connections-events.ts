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

// A secret or an MCP server changed: the integrations list and the Secrets
// list reload (the MCP server editor can add a secret).
const changeListeners = new Set<() => void>();

export function onConnectionsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function notifyConnectionsChanged(): void {
  for (const listener of changeListeners) listener();
}
