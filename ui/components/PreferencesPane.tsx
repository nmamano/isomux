// Self-scoped "Language and chat" pane on the Settings page: the language and
// whether the chat shows every tool call (task e7579473):
// the settings that belong to a PERSON rather than to a browser, so they
// follow them to their phone. Sits next to My devices, which is its opposite
// number - the device label there stays local on purpose.
//
// Writes go to PATCH /api/me/preferences, which is self-only: there is no
// :username in the path, so an owner opening this page still edits their own
// preferences and nobody else's. Reads come off the user record in the store
// (useSelfUser), so a change saved on another device repaints here through the
// same event that carries the rest of the record.

import { useId, useState } from "react";
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
import { dialogHint } from "./dialog-styles.ts";
import { useUnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { SettingsFormLayout, SettingsSaveFooter } from "./SettingsItemPage.tsx";
import { sectionHeader, hint, cardStyle } from "./access-shared.tsx";

export function PreferencesPane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const self = useSelfUser();
  const { t } = useI18n();
  const languageId = useId();
  // The form holds only what the user has TOUCHED; everything else is derived
  // from the record by resolvePreferenceForm. That way a record arriving late
  // (or a change saved on another device) simply shows up, with no effect
  // re-seeding state and no window where the form silently disagrees with the
  // server. Nothing here writes on mount: the browser-detected language is
  // only PRESELECTED, and a request is issued exclusively from save().
  const [edits, setEdits] = useState<PreferenceEdits>(NO_EDITS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save succeeded since the pane opened.
  const [saved, setSaved] = useState(false);

  const { language, showToolCalls, showAgentMessages, canSave, request } =
    resolvePreferenceForm(
      self,
      typeof navigator === "undefined" ? null : navigator.language,
      edits,
    );

  // Only the member's own edits ask before leaving: a browser language the
  // server does not hold yet keeps Save on but is not theirs to lose.
  const discardPrompt = useUnsavedChangesPrompt(canSave && edits !== NO_EDITS, {
    closeRef,
    onDiscard: () => setEdits(NO_EDITS),
  });

  function save() {
    setSaving(true);
    setError(null);
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

  const footer = (
    <SettingsSaveFooter
      error={error}
      prompt={discardPrompt}
      dirty={canSave}
      saving={saving}
      saved={saved}
      onCancel={() => {
        setEdits(NO_EDITS);
        setError(null);
      }}
      onSave={save}
    />
  );

  if (!self) {
    return (
      <SettingsFormLayout footer={footer}>
        <div style={{ marginTop: 24 }}>
          <h4 style={sectionHeader}>{t("settings.sidebar.languageAndChat")}</h4>
          <p style={hint}>{t("common.loading")}</p>
        </div>
      </SettingsFormLayout>
    );
  }

  return (
    <SettingsFormLayout footer={footer}>
      <div style={{ marginTop: 24 }}>
        <h4 style={sectionHeader}>{t("settings.sidebar.languageAndChat")}</h4>
        <p style={{ ...hint, marginTop: 4 }}>{t("preferences.intro")}</p>

        <div style={cardStyle}>
          {/* The heading names the pane, which holds more than the language,
              so the select has its own visible label. */}
          <label
            htmlFor={languageId}
            style={{ display: "block", fontSize: 13, marginBottom: 6 }}
          >
            {t("preferences.language")}
          </label>
          <select
            id={languageId}
            value={language}
            onChange={(e) =>
              setEdits((prev) => ({
                ...prev,
                language: e.target.value as SupportedLanguageCode,
              }))
            }
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

        <div style={cardStyle}>
          <ChatChoiceBox
            choice="showToolCalls"
            checked={showToolCalls}
            onChange={(checked) =>
              setEdits((prev) => ({ ...prev, showToolCalls: checked }))
            }
          />
        </div>

        <div style={cardStyle}>
          <ChatChoiceBox
            choice="showAgentMessages"
            checked={showAgentMessages}
            onChange={(checked) =>
              setEdits((prev) => ({ ...prev, showAgentMessages: checked }))
            }
          />
        </div>
      </div>
    </SettingsFormLayout>
  );
}

// A chat choice's checkbox and its hint: "Show tool calls" (task e7579473)
// or "Show messages between agents" (task d5c0f33d). The owner's member page
// and New member form use it too.
export type ChatChoice = "showToolCalls" | "showAgentMessages";

export function ChatChoiceBox({
  choice,
  checked,
  onChange,
}: {
  choice: ChatChoice;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  const marker =
    choice === "showToolCalls"
      ? { "data-show-tool-calls": "" }
      : { "data-show-agent-messages": "" };
  return (
    <>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          {...marker}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t(`preferences.${choice}`)}
      </label>
      <p style={{ ...dialogHint, margin: "6px 0 0" }}>
        {t(`preferences.${choice}Hint`)}
      </p>
    </>
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
