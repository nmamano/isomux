import { useEffect, useMemo, useState } from "react";

import type { UserEnvRes } from "../../shared/contract-shapes.ts";
import { CONNECTION_NOTE_MAX_LENGTH } from "../../shared/connection-notes.ts";
import { apiFetch, ApiError } from "../api.ts";
import {
  dialogCancelBtn,
  dialogHint,
  dialogInput,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import { notifyManagedEnvSaved } from "../connections-events.ts";

interface Entry {
  id: number;
  key: string;
  value: string;
  // The usage note for agents (integrations A4); "" for none.
  note: string;
}

interface Saved {
  values: Record<string, string>;
  notes: Record<string, string>;
}

let nextEntryId = 1;

function entriesOf(saved: Saved): Entry[] {
  return Object.entries(saved.values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      id: nextEntryId++,
      key,
      value,
      note: saved.notes[key] ?? "",
    }));
}

function savedOf(result: UserEnvRes): Saved {
  return { values: result.values, notes: result.notes ?? {} };
}

export function ManagedEnvEditor({ path }: { path: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<UserEnvRes | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [saved, setSaved] = useState<Saved>({ values: {}, notes: {} });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Values are secrets. They render masked until the user reveals them, so a
  // shared or streamed screen on the Connections page shows nothing (Nil).
  const [showValues, setShowValues] = useState(false);

  const load = () =>
    apiFetch<UserEnvRes>("GET", path)
      .then((result) => {
        setMode(result);
        if (result.mode === "managed") {
          setEntries(entriesOf(savedOf(result)));
          setSaved(savedOf(result));
        }
        setError(null);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : t("settings.env.loadFailed"),
        ),
      );

  useEffect(() => {
    void load();
    // The path is the complete identity of this self-scoped resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const current = useMemo<Saved>(
    () => ({
      values: Object.fromEntries(
        entries.map((entry) => [entry.key, entry.value]),
      ),
      notes: Object.fromEntries(
        entries
          .filter((entry) => entry.note.trim())
          .map((entry) => [entry.key, entry.note.trim()]),
      ),
    }),
    [entries],
  );
  const dirty =
    JSON.stringify(current.values) !== JSON.stringify(saved.values) ||
    JSON.stringify(Object.entries(current.notes).sort()) !==
      JSON.stringify(Object.entries(saved.notes).sort());
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
      await apiFetch("PUT", path, current);
      setSaved(current);
      notifyManagedEnvSaved();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("settings.env.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  if (!mode) {
    return (
      <div data-managed-env-path={path} style={dialogHint}>
        {error ?? t("settings.env.loadingVariables")}
      </div>
    );
  }

  return (
    <div data-managed-env-path={path}>
      {entries.map((entry) => (
        <div key={entry.id} data-env-entry style={{ marginBottom: 10 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1.5fr auto",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <input
              aria-label={t("settings.env.variableName")}
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
              aria-label={t("settings.env.valueLabel", {
                name: entry.key || t("settings.env.variable"),
              })}
              type={showValues ? "text" : "password"}
              autoComplete="off"
              value={entry.value}
              placeholder={t("settings.env.valuePlaceholder")}
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
              {t("settings.env.remove")}
            </button>
          </div>
          <textarea
            aria-label={t("settings.connections.note")}
            rows={1}
            maxLength={CONNECTION_NOTE_MAX_LENGTH}
            value={entry.note}
            placeholder={t("settings.connections.notePlaceholder")}
            style={{
              ...dialogInput,
              fontFamily: "inherit",
              resize: "vertical",
            }}
            onChange={(event) =>
              setEntries((all) =>
                all.map((item) =>
                  item.id === entry.id
                    ? { ...item, note: event.target.value }
                    : item,
                ),
              )
            }
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={dialogCancelBtn}
          onClick={() =>
            setEntries((all) => [
              ...all,
              { id: nextEntryId++, key: "", value: "", note: "" },
            ])
          }
        >
          {t("settings.env.add")}
        </button>
        <button
          type="button"
          style={dialogCancelBtn}
          onClick={() => setShowValues((shown) => !shown)}
        >
          {showValues
            ? t("settings.env.hideValues")
            : t("settings.env.showValues")}
        </button>
        <button
          type="button"
          style={dialogSaveBtn}
          disabled={
            !dirty || duplicate || entries.some((entry) => !entry.key) || saving
          }
          onClick={() => void save()}
        >
          {saving
            ? t("common.saving")
            : dirty
              ? t("settings.env.save")
              : t("settings.env.saved")}
        </button>
      </div>
      {duplicate && (
        <div style={{ color: "var(--red-text)", marginTop: 6 }}>
          {t("settings.env.duplicate")}
        </div>
      )}
      {error && (
        <div style={{ color: "var(--red-text)", marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}
