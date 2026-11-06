// The "Recording mode" pane on the Settings page (task 6e08239a). The switch
// is this browser's (ui/recording-mode.ts), like the theme, and applies at
// once. The word list is the member's: it saves to their record through
// PATCH /api/me/preferences, so it follows them to every device. A member
// who never saved a list sees the default (the office name row).

import { useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState } from "../store.tsx";
import { useSelfUser } from "../hooks/useSelfUser.ts";
import { useI18n } from "../i18n.tsx";
import { setRecording, useRecording } from "../recording-mode.ts";
import {
  MAX_RECORDING_WORD_CHARS,
  MAX_RECORDING_WORDS,
  defaultRecordingWords,
  recordingWordsProblem,
  type RecordingWord,
  type RecordingWordsProblem,
} from "../../shared/recording-redact.ts";
import {
  dialogHint,
  dialogInput,
  dialogSaveBtn,
  disabledLook,
  filledSecondaryBtn,
} from "./dialog-styles.ts";
import { sectionHeader, hint, cardStyle } from "./access-shared.tsx";

export function RecordingPane() {
  const { t } = useI18n();
  const on = useRecording();
  const self = useSelfUser();
  const { office } = useAppState();
  const savedList =
    self?.recordingWords ?? defaultRecordingWords(office.name ?? null);
  // Only what the member touched; until then the list is the record's.
  const [edited, setEdited] = useState<RecordingWord[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loading = self === null;
  const rows = edited ?? savedList;
  const dirty =
    edited !== null && JSON.stringify(edited) !== JSON.stringify(savedList);
  // An empty row the member is still filling in is not a problem yet.
  const filled = rows.filter((r) => r.word.trim() || r.standIn.trim());
  const problem = recordingWordsProblem(filled);
  const canSave = dirty && problem === null && !saving;

  const edit = (next: RecordingWord[]) => {
    setEdited(next);
    setSaved(false);
    setError(null);
  };

  function save() {
    setSaving(true);
    setError(null);
    apiFetch<void>("PATCH", "/api/me/preferences", {
      recordingWords: filled.map((r) => ({
        word: r.word.trim(),
        standIn: r.standIn,
      })),
    })
      .then(() => {
        setEdited(null);
        setSaved(true);
      })
      .catch((e) =>
        setError(
          e instanceof ApiError ? e.message : t("preferences.saveFailed"),
        ),
      )
      .finally(() => setSaving(false));
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.recording")}</h4>
      <p style={{ ...hint, marginTop: 4 }}>{t("recording.intro")}</p>

      <div style={cardStyle}>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 12,
            color: "var(--text-primary)",
          }}
        >
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setRecording(e.target.checked)}
          />
          {t("recording.switch")}
        </label>
        <p style={{ ...dialogHint, margin: "6px 0 0" }}>
          {t("recording.switchHint", { keys: "Alt+Shift+R" })}
        </p>
      </div>

      <h4 style={{ ...sectionHeader, marginTop: 20 }}>
        {t("recording.words")}
      </h4>
      <p style={{ ...hint, marginTop: 4 }}>{t("recording.wordsHint")}</p>
      <div style={cardStyle}>
        {/* Until the member's record arrives, the rows show the default
            list, dimmed and disabled, so the pane keeps its layout. */}
        <div style={loading ? disabledLook : undefined}>
          {rows.map((row, i) => (
            <div
              key={i}
              data-recording-word-row
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                marginBottom: 6,
                flexWrap: "wrap",
              }}
            >
              <input
                aria-label={t("recording.word")}
                placeholder={t("recording.word")}
                value={row.word}
                disabled={loading}
                maxLength={MAX_RECORDING_WORD_CHARS}
                onChange={(e) =>
                  edit(
                    rows.map((r, k) =>
                      k === i ? { ...r, word: e.target.value } : r,
                    ),
                  )
                }
                style={{ ...dialogInput, flex: "1 1 140px", minWidth: 0 }}
              />
              <span aria-hidden style={{ color: "var(--text-muted)" }}>
                →
              </span>
              <input
                aria-label={t("recording.standIn")}
                placeholder={t("recording.standIn")}
                value={row.standIn}
                disabled={loading}
                maxLength={MAX_RECORDING_WORD_CHARS}
                onChange={(e) =>
                  edit(
                    rows.map((r, k) =>
                      k === i ? { ...r, standIn: e.target.value } : r,
                    ),
                  )
                }
                style={{ ...dialogInput, flex: "1 1 140px", minWidth: 0 }}
              />
              <button
                disabled={loading}
                onClick={() => edit(rows.filter((_, k) => k !== i))}
                style={filledSecondaryBtn}
              >
                {t("recording.remove")}
              </button>
            </div>
          ))}
          <button
            onClick={() => edit([...rows, { word: "", standIn: "" }])}
            disabled={loading || rows.length >= MAX_RECORDING_WORDS}
            style={{
              ...filledSecondaryBtn,
              ...(rows.length >= MAX_RECORDING_WORDS ? disabledLook : null),
            }}
          >
            {t("recording.add")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={save}
          disabled={!canSave}
          style={{ ...dialogSaveBtn, ...(canSave ? null : disabledLook) }}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {problem !== null && dirty && (
          <span role="alert" style={{ fontSize: 11, color: "var(--red-text)" }}>
            {problemText(t, problem)}
          </span>
        )}
        {saved && !dirty && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("preferences.saved")}
          </span>
        )}
        {error && (
          <span style={{ fontSize: 11, color: "var(--red-text)" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function problemText(
  t: ReturnType<typeof useI18n>["t"],
  problem: RecordingWordsProblem,
): string {
  switch (problem) {
    case "empty_word":
      return t("recording.problem.emptyWord");
    case "empty_stand_in":
      return t("recording.problem.emptyStandIn");
    case "duplicate_word":
      return t("recording.problem.duplicateWord");
    case "stand_in_is_a_word":
      return t("recording.problem.standInIsAWord");
    case "too_many":
      return t("recording.problem.tooMany", { max: MAX_RECORDING_WORDS });
    case "too_long":
      return t("recording.problem.tooLong", { max: MAX_RECORDING_WORD_CHARS });
  }
}
