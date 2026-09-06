// Shared editor state for one isomux-memory scope file on the settings modals.
// Loads the raw file + its optimistic-concurrency version via the unified READ
// (GET /api/memory), tracks dirty, and saves via the version-guarded REPLACE
// (PUT /api/memory) - surfacing a 409 conflict as a clear, dialog-keeping error
// instead of silently clobbering a concurrent edit. See
// server/routes/handlers/memory.ts.

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { injectedMemorySize } from "../../shared/memory-size.ts";

export type MemoryScope = "office" | "room" | "agent" | "boss";

export type MemorySaveResult =
  | { ok: true }
  | { ok: false; conflict?: boolean; message: string };

export interface MemoryEditor {
  memory: string;
  setMemory: (v: string) => void;
  loaded: boolean;
  dirty: boolean;
  // Revert unsaved edits back to the loaded baseline.
  reset: () => void;
  size: number;
  cap: number | null;
  // Save the current text if loaded + dirty; a no-op success otherwise. On a 409
  // the file changed under us - returns { conflict } so the caller keeps the
  // dialog open and tells the user to reopen.
  save: () => Promise<MemorySaveResult>;
}

export function useMemoryEditor(
  scope: MemoryScope,
  scopeId: string | null,
  enabled = true,
): MemoryEditor {
  // A hook, so it reads the translator from the context like a component
  // (ruling 18). The two messages below are Isomux's own words for the reader;
  // a message relayed from an ApiError stays as delivered (ruling 2).
  const { t } = useI18n();
  const [memory, setMemory] = useState("");
  const [baseline, setBaseline] = useState("");
  const [version, setVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cap, setCap] = useState<number | null>(null);

  const query =
    scopeId != null
      ? `?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`
      : `?scope=${scope}`;

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoaded(false);
      return;
    }
    let cancelled = false;
    // Reset first so a scopeId change can't leave the previous target's text
    // marked loaded (a fast Save would rewrite the new target with stale text).
    setLoaded(false);
    setMemory("");
    setBaseline("");
    setVersion(null);
    setCap(null);
    apiFetch<{ text: string; version: string; size: number; cap: number }>(
      "GET",
      `/api/memory${query}`,
    )
      .then((r) => {
        if (cancelled) return;
        setMemory(r.text);
        setBaseline(r.text);
        setVersion(r.version);
        setCap(r.cap);
        setLoaded(true);
      })
      .catch(() => {
        // Leave loaded=false -> save() is a no-op until a successful load.
      });
    return () => {
      cancelled = true;
    };
  }, [scope, scopeId, enabled, query]);

  const dirty = loaded && memory !== baseline;

  async function save(): Promise<MemorySaveResult> {
    if (!loaded || !dirty || version == null) return { ok: true };
    try {
      const r = await apiFetch<{ version: string }>("PUT", "/api/memory", {
        scope,
        scopeId,
        text: memory,
        version,
      });
      setBaseline(memory);
      setVersion(r.version);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.code === "memory_conflict") {
        return {
          ok: false,
          conflict: true,
          message: t("common.memoryConflict"),
        };
      }
      return {
        ok: false,
        message:
          e instanceof ApiError ? e.message : t("common.memorySaveFailed"),
      };
    }
  }

  return {
    memory,
    setMemory,
    loaded,
    dirty,
    size: injectedMemorySize(memory),
    cap,
    save,
    // Throw away unsaved edits and go back to what the last load or save
    // returned. Panes need this because their Cancel button reverts in place
    // rather than closing a dialog.
    reset: () => setMemory(baseline),
  };
}
