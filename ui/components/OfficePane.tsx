import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import type {
  InstructionsReq,
  InstructionsRes,
  OfficeSettingsReq,
  OfficeSettingsRes,
} from "../../shared/contract-shapes.ts";
import {
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { ExpandableTextarea } from "./ExpandableTextarea.tsx";
import { useI18n } from "../i18n.tsx";
import {
  UnsavedChangesPrompt,
  useUnsavedChangesPrompt,
} from "./UnsavedChangesPrompt.tsx";

type ValidationStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; keyCount?: number }
  | { kind: "error"; message: string };

// Office name, instructions and memory. Storage and Usage used to hang off buttons
// inside this dialog; they are sibling sidebar rows now, so they are gone from
// here.
export function OfficePane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { office, sessionContext } = useAppState();
  const { t } = useI18n();
  // Members can open this modal but can't edit it. Read-only state grays
  // inputs and hides the Save button; the server also rejects the save from
  // non-owner sessions (office.setSettings is gated by the officeOwner guard).
  const isOwner = sessionContext?.role === "owner";
  const readOnly = !isOwner;
  const [text, setText] = useState(office.prompt ?? "");
  const [name, setName] = useState(office.name ?? "");
  // Office memory is edited via the unified /api/memory verbs (load + version-
  // guarded save). Disabled until the load resolves; saved separately from the
  // office settings PUT.
  const mem = useMemoryEditor("office", null, !readOnly);
  // The name and the instructions are two version-guarded routes (optimistic
  // concurrency, mirroring the memory editor): GET each on open (owner-only
  // GETs, so skip for read-only members - they never save), send each version
  // back on save; a 409 means another writer saved since. Each token stays
  // coupled to the BYTES read with it: the name hydrates from the settings GET,
  // the text from the instructions GET; never pair store-snapshot fields with
  // a GET's version, or a fresher server value gets silently blessed over.
  // Until both loads resolve the fields are read-only and Save stays
  // disabled; the store values paint first purely as placeholders.
  const [settingsVersion, setSettingsVersion] = useState<string | null>(null);
  const [instructionsVersion, setInstructionsVersion] = useState<string | null>(
    null,
  );
  const [status, setStatus] = useState<ValidationStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // What the fields held when they last agreed with the server. Dirtiness is
  // measured against THIS, not the store snapshot: the prompt and name hydrate
  // from the version-guarded GET and can legitimately differ from the store's
  // copy, so comparing against the store makes an untouched pane look dirty.
  // A read-only member never loads, so settingsLoaded gates the whole thing
  // and their pane can never be dirty.
  const [baselineName, setBaselineName] = useState("");
  const [baselinePrompt, setBaselinePrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsLoaded = settingsVersion != null && instructionsVersion != null;

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    Promise.all([
      apiFetch<OfficeSettingsRes>("GET", "/api/office/settings"),
      apiFetch<InstructionsRes>("GET", "/api/office/instructions"),
    ])
      .then(([settings, instructions]) => {
        if (cancelled) return;
        setText(instructions.instructions ?? "");
        setName(settings.name ?? "");
        setBaselinePrompt(instructions.instructions ?? "");
        setBaselineName(settings.name ?? "");
        setSettingsVersion(settings.version);
        setInstructionsVersion(instructions.version);
      })
      .catch(() => {
        // Leave the versions null -> fields stay read-only, Save stays
        // disabled (no way to write safely).
      });
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  async function handleSave() {
    // The name (settings PUT), the instructions (instructions PUT) and the
    // memory REPLACE are separate calls, each sent only when its field
    // changed. Settings go first: until the old prompt field is retired, the
    // settings version also covers the text, so an instructions write first
    // would spend the version the settings write carries. A failure surfaces
    // server.message in the shared status slot and keeps the reader on the
    // pane; what saved before it stays saved, and the rest stays dirty.
    if (settingsVersion == null || instructionsVersion == null) return;
    setSaving(true);
    // Either write moves the settings version, so it is re-read after any
    // write lands - also when a later step fails, or the next Save would
    // blame a phantom concurrent writer. Its own try/catch, because a failed
    // re-read is not a failed save.
    let wrote = false;
    const refreshSettingsVersion = async () => {
      try {
        const next = await apiFetch<OfficeSettingsRes>(
          "GET",
          "/api/office/settings",
        );
        setName(next.name ?? "");
        setBaselineName(next.name ?? "");
        setSettingsVersion(next.version);
      } catch {
        // No safe token to write with: null disables Save rather than leaving
        // it unsafe, matching the failed-hydration path above. The save that
        // already landed still counts.
        setSettingsVersion(null);
        setStatus({
          kind: "error",
          message: t("settings.office.reloadFailed"),
        });
      }
    };
    try {
      if (name !== baselineName) {
        const body: OfficeSettingsReq = {
          name: name.trim() || null,
          version: settingsVersion,
        };
        await apiFetch<void>("PUT", "/api/office/settings", body);
        wrote = true;
        setBaselineName(name);
      }
      if (text !== baselinePrompt) {
        const body: InstructionsReq = {
          instructions: text.trim() ? text : null,
          version: instructionsVersion,
        };
        // The answer is the stored text and its version, so a value the
        // server normalized (an all-whitespace text stored as null) cannot
        // leave the field and the baseline disagreeing.
        const saved = await apiFetch<InstructionsRes>(
          "PUT",
          "/api/office/instructions",
          body,
        );
        wrote = true;
        setText(saved.instructions ?? "");
        setBaselinePrompt(saved.instructions ?? "");
        setInstructionsVersion(saved.version);
      }
      // Before anything that can fail and return: a memory conflict must not
      // leave the settings token spent.
      if (wrote) await refreshSettingsVersion();
      setSavedAt(Date.now());
      const m = await mem.save();
      if (!m.ok) {
        setStatus({ kind: "error", message: m.message });
        return;
      }
    } catch (e) {
      if (wrote) await refreshSettingsVersion();
      if (e instanceof ApiError && e.code === "version_conflict") {
        setStatus({
          kind: "error",
          message: t("settings.office.conflict"),
        });
      } else {
        setStatus({
          kind: "error",
          message: e instanceof ApiError ? e.message : t("common.saveFailed"),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  // Place cursor at end of text on mount. Skip for read-only mode so we
  // don't auto-focus an input the member can't edit.
  useEffect(() => {
    if (readOnly) return;
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [readOnly]);

  // Mirror the unsaved-changes guard into the page's ref every render, so the
  // captured closure sees fresh field state - the no-deps pattern
  // UserEditPanel, DevicePane and RoomPane use. Name, prompt and memory are
  // all dirty-capable. A read-only member never loads, so dirty is false for
  // them and they are never asked about discarding anything.
  const dirty =
    (settingsLoaded && (name !== baselineName || text !== baselinePrompt)) ||
    mem.dirty;
  const discardPrompt = useUnsavedChangesPrompt(dirty, closeRef, () => {
    setName(baselineName);
    setText(baselinePrompt);
    mem.reset();
    setStatus({ kind: "idle" });
  });

  return (
    <div style={{ marginTop: 24 }}>
      <div>
        <h3
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: 0,
            color: "var(--text-primary)",
          }}
        >
          {t("settings.office.title")}
        </h3>
        <p
          style={{
            fontSize: 11,
            color: "var(--text-ghost)",
            margin: "6px 0 0",
            lineHeight: 1.4,
          }}
        >
          {t("settings.office.intro")}
        </p>
        {readOnly && (
          <p
            style={{
              fontSize: 11,
              color: "var(--text-ghost)",
              margin: "8px 0 0",
              padding: "8px 10px",
              background: "var(--bg-input)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              lineHeight: 1.4,
            }}
          >
            {t("settings.office.viewOnly")}
          </p>
        )}

        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 18,
            marginBottom: 5,
          }}
        >
          {t("settings.office.name")}{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            {t("settings.office.nameHint")}
          </span>
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.office.namePlaceholder")}
          maxLength={60}
          readOnly={readOnly || !settingsLoaded}
          style={readOnly || !settingsLoaded ? readOnlyInputStyle : inputStyle}
        />

        <h4 className="agent-settings-group-title" style={{ marginTop: 24 }}>
          {t("common.instructionsAndMemory")}
        </h4>

        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 14,
            marginBottom: 5,
          }}
        >
          {t("common.instructions")}{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            {t("settings.office.rulesHint")}
          </span>
        </label>
        <ExpandableTextarea
          textareaRef={textareaRef}
          title={t("settings.office.rulesTitle")}
          hint={t("settings.office.rulesExpandedHint")}
          value={text}
          onChange={setText}
          placeholder={t("settings.office.rulesPlaceholder")}
          rows={8}
          readOnly={readOnly || !settingsLoaded}
          style={{
            ...(readOnly || !settingsLoaded ? readOnlyInputStyle : inputStyle),
            resize: "vertical",
          }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          {t("common.nextConversation")}
        </p>

        {!readOnly && (
          <>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
                marginTop: 14,
                marginBottom: 5,
              }}
            >
              {t("common.memory")}{" "}
              <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                {t("settings.office.memoryHint", {
                  size: mem.loaded ? mem.size : "…",
                  cap: mem.cap ?? "…",
                })}
              </span>
            </label>
            <ExpandableTextarea
              title={t("settings.office.memoryTitle")}
              hint={t("common.memoryEditorHint")}
              status={t("common.memorySize", {
                size: mem.loaded ? mem.size : "…",
                cap: mem.cap ?? "…",
              })}
              value={mem.memory}
              onChange={mem.setMemory}
              placeholder={
                mem.loaded
                  ? t("settings.office.memoryPlaceholder")
                  : t("common.loadingMemory")
              }
              rows={6}
              readOnly={!mem.loaded}
              style={{
                ...(mem.loaded ? inputStyle : readOnlyInputStyle),
                resize: "vertical",
              }}
            />
            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "3px 0 0",
              }}
            >
              {t("common.memoryEditorHint")}
            </p>
          </>
        )}

        {discardPrompt.open && (
          <UnsavedChangesPrompt
            onDiscard={discardPrompt.discard}
            onCancel={discardPrompt.cancel}
          />
        )}

        <ValidationLine status={status} />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          {!readOnly && (
            <>
              <button
                onClick={() => {
                  setName(baselineName);
                  setText(baselinePrompt);
                  mem.reset();
                  setStatus({ kind: "idle" });
                }}
                style={cancelBtnStyle}
                disabled={saving || !dirty}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void handleSave()}
                style={saveBtnStyle}
                disabled={saving || !settingsLoaded}
              >
                {saving
                  ? t("common.saving")
                  : savedAt && !dirty
                    ? t("common.saved")
                    : t("common.save")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationLine({ status }: { status: ValidationStatus }) {
  const { t, tn } = useI18n();
  if (status.kind === "idle") return null;
  if (status.kind === "pending") {
    return (
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "4px 0 0" }}
      >
        {t("common.checking")}
      </p>
    );
  }
  if (status.kind === "ok") {
    return (
      <p
        style={{ fontSize: 10, color: "var(--accent-text)", margin: "4px 0 0" }}
      >
        {tn("settings.office.loadedVariables", status.keyCount ?? 0)}
      </p>
    );
  }
  return (
    <p style={{ fontSize: 10, color: "var(--red-text)", margin: "4px 0 0" }}>
      {status.message}
    </p>
  );
}

const inputStyle: React.CSSProperties = dialogInput;
// Visually-distinct read-only variant: the floor text colour matches the
// "view only" framing for member sessions opening the office settings.
const readOnlyInputStyle: React.CSSProperties = {
  ...dialogInput,
  color: "var(--text-hint)",
  background: "var(--bg-input)",
  cursor: "default",
};
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
