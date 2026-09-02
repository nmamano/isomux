import { useEffect, useMemo, useState } from "react";

import type { UserEnvRes } from "../../shared/contract-shapes.ts";
import { apiFetch, ApiError } from "../api.ts";
import {
  dialogCancelBtn,
  dialogHint,
  dialogInput,
  dialogSaveBtn,
} from "./dialog-styles.ts";

interface Entry {
  id: number;
  key: string;
  value: string;
}

let nextEntryId = 1;

function entriesOf(values: Record<string, string>): Entry[] {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ id: nextEntryId++, key, value }));
}

export function ManagedEnvEditor({ path }: { path: string }) {
  const [mode, setMode] = useState<UserEnvRes | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    apiFetch<UserEnvRes>("GET", path)
      .then((result) => {
        setMode(result);
        if (result.mode === "managed") {
          setEntries(entriesOf(result.values));
          setSaved(result.values);
        }
        setError(null);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : "Could not load variables",
        ),
      );

  useEffect(() => {
    void load();
    // The path is the complete identity of this self-scoped resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const current = useMemo(
    () => Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    [entries],
  );
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const duplicate = entries.some(
    (entry, index) =>
      entry.key &&
      entries.findIndex((other) => other.key === entry.key) !== index,
  );

  async function save() {
    if (duplicate || entries.some((entry) => !entry.key)) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch("PUT", path, { values: current });
      setSaved(current);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not save variables",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!mode) {
    return (
      <div data-managed-env-path={path} style={dialogHint}>
        {error ?? "Loading variables…"}
      </div>
    );
  }

  return (
    <div data-managed-env-path={path}>
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1.5fr auto",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <input
            aria-label="Variable name"
            value={entry.key}
            placeholder="VARIABLE_NAME"
            style={dialogInput}
            onChange={(event) =>
              setEntries((all) =>
                all.map((item) =>
                  item.id === entry.id
                    ? { ...item, key: event.target.value }
                    : item,
                ),
              )
            }
          />
          <input
            aria-label={`${entry.key || "Variable"} value`}
            value={entry.value}
            placeholder="Value"
            style={dialogInput}
            onChange={(event) =>
              setEntries((all) =>
                all.map((item) =>
                  item.id === entry.id
                    ? { ...item, value: event.target.value }
                    : item,
                ),
              )
            }
          />
          <button
            type="button"
            style={dialogCancelBtn}
            onClick={() =>
              setEntries((all) => all.filter((item) => item.id !== entry.id))
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={dialogCancelBtn}
          onClick={() =>
            setEntries((all) => [
              ...all,
              { id: nextEntryId++, key: "", value: "" },
            ])
          }
        >
          Add variable
        </button>
        <button
          type="button"
          style={dialogSaveBtn}
          disabled={
            !dirty || duplicate || entries.some((entry) => !entry.key) || saving
          }
          onClick={() => void save()}
        >
          {saving ? "Saving…" : dirty ? "Save variables" : "Variables saved"}
        </button>
      </div>
      {duplicate && (
        <div style={{ color: "var(--red)", marginTop: 6 }}>
          Variable names must be unique.
        </div>
      )}
      {error && (
        <div style={{ color: "var(--red)", marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}
