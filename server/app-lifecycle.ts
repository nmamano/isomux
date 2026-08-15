import type { AppRecord } from "../shared/types.ts";
import { appRegistrationGeneration } from "./app-registry.ts";

type Retire = () => void;
const active = new Map<string, Set<Retire>>();

export function appRegistrationKey(app: AppRecord): string {
  return JSON.stringify([
    app.hostLabel,
    app.hostGen,
    appRegistrationGeneration(app),
  ]);
}

/**
 * Register before an HTTP connection or WebSocket dial starts. Synchronous by
 * construction: the delete path must not free a name across an await.
 */
export function watchAppRetirement(app: AppRecord, retire: Retire): () => void {
  const key = appRegistrationKey(app);
  let set = active.get(key);
  if (!set) {
    set = new Set();
    active.set(key, set);
  }
  set.add(retire);
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    set.delete(retire);
    if (set.size === 0) active.delete(key);
  };
}

/** Abort every old route before its name and port can be reused. */
export function retireAppRegistration(app: AppRecord): void {
  const key = appRegistrationKey(app);
  const set = active.get(key);
  active.delete(key);
  if (!set) return;
  for (const retire of set) {
    try {
      retire();
    } catch {}
  }
  set.clear();
}

export function _testActiveAppLifecycles(app: AppRecord): number {
  return active.get(appRegistrationKey(app))?.size ?? 0;
}

export function _testResetAppLifecycles(): void {
  active.clear();
}
