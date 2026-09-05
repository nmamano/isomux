// Self-scoped "Preferences" pane on the Settings page:
// the settings that belong to a PERSON rather than to a browser, so they
// follow them to their phone. Sits next to My devices, which is its opposite
// number - the device label there stays local on purpose.
//
// Writes go to PATCH /api/me/preferences, which is self-only: there is no
// :username in the path, so an owner opening this page still edits their own
// preferences and nobody else's. Reads come off the user record in the store
// (useSelfUser), so a change saved on another device repaints here through the
// same event that carries the rest of the record.

import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useSelfUser } from "../hooks/useSelfUser.ts";
import { useI18n } from "../i18n.tsx";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "../../shared/languages.ts";
import {
  NO_EDITS,
  resolvePreferenceForm,
  type PreferenceEdits,
} from "../preference-form.ts";
import { dialogLabel, dialogHint, dialogSaveBtn } from "./dialog-styles.ts";
import { sectionHeader, hint, cardStyle } from "./access-shared.tsx";

export function PreferencesPane() {
  const self = useSelfUser();
  const { t } = useI18n();
  // The form holds only what the user has TOUCHED; everything else is derived
  // from the record by resolvePreferenceForm. That way a record arriving late
  // (or a change saved on another device) simply shows up, with no effect
  // re-seeding state and no window where the form silently disagrees with the
  // server. Nothing here writes on mount: the browser-detected language is
  // only PRESELECTED, and a request is issued exclusively from save().
  const [edits, setEdits] = useState<PreferenceEdits>(NO_EDITS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { language, canSave, request } = resolvePreferenceForm(
    self,
    typeof navigator === "undefined" ? null : navigator.language,
    edits,
  );

  function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    apiFetch<void>("PATCH", "/api/me/preferences", request)
      .then(() => {
        // Drop the local edits: the record is authoritative from here, and the
        // updated one is already on its way over the socket.
        setEdits(NO_EDITS);
        setSaved(true);
      })
      .catch((e) =>
        setError(
          e instanceof ApiError ? e.message : t("preferences.saveFailed"),
        ),
      )
      .finally(() => setSaving(false));
  }

  if (!self) {
    return (
      <div style={{ marginTop: 24 }}>
        <h4 style={sectionHeader}>{t("common.preferences")}</h4>
        <p style={hint}>{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("common.preferences")}</h4>
      <p style={{ ...hint, marginTop: 4 }}>{t("preferences.intro")}</p>

      <div style={cardStyle}>
        <label style={{ ...dialogLabel, marginTop: 0 }}>
          {t("preferences.language")}
        </label>
        <select
          value={language}
          onChange={(e) => {
            setEdits((prev) => ({
              ...prev,
              language: e.target.value as SupportedLanguageCode,
            }));
            setSaved(false);
          }}
          style={selectStyle}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <p style={{ ...dialogHint, margin: "6px 0 0" }}>
          {t("preferences.languageHint")}
        </p>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 14,
        }}
      >
        <button
          onClick={save}
          disabled={saving || !canSave}
          style={{
            ...dialogSaveBtn,
            opacity: saving || !canSave ? 0.45 : 1,
            cursor: saving || !canSave ? "not-allowed" : "pointer",
          }}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {saved && !canSave && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("preferences.saved")}
          </span>
        )}
        {error && (
          <span style={{ fontSize: 11, color: "#ff6b6b" }}>{error}</span>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};
