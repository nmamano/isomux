import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import type {
  OfficeSettingsReq,
  OfficeSettingsRes,
  OfficeUsageStatusWire,
} from "../../shared/contract-shapes.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import {
  DEFAULT_MEMBER_SHARE,
  MEMBER_SHARE_OPTIONS,
} from "../../shared/member-usage-share.ts";
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

// Office name, prompt and memory. Storage and Usage used to hang off buttons
// inside this dialog; they are sibling sidebar rows now, so they are gone from
// here.
export function OfficePane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { office, sessionContext } = useAppState();
  const { t, language } = useI18n();
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
  // The settings PUT is version-guarded (optimistic concurrency, mirroring the
  // memory editor): GET on open (owner-only GET, so skip for read-only members
  // - they never save), send the version back on save; a 409 means another
  // writer saved since. The token must stay coupled to the BYTES read with it,
  // so ALL guarded fields (prompt/name - one version over the whole
  // blob) hydrate from the same GET response; never pair store-snapshot fields
  // with the GET's version, or a fresher server blob gets silently blessed
  // over. Until the load resolves the fields are read-only and Save stays
  // disabled; the store values paint first purely as placeholders.
  const [settingsVersion, setSettingsVersion] = useState<string | null>(null);
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
  // The member usage cap switch and member share, under the same version as
  // name and prompt, and the status lines the GET reads while it is on.
  const [usageCap, setUsageCap] = useState(false);
  const [baselineUsageCap, setBaselineUsageCap] = useState(false);
  const [usageShare, setUsageShare] = useState(DEFAULT_MEMBER_SHARE);
  const [baselineUsageShare, setBaselineUsageShare] =
    useState(DEFAULT_MEMBER_SHARE);
  const [usageStatus, setUsageStatus] = useState<OfficeUsageStatusWire[]>([]);
  // A server from before the switch existed omits it: no switch, no field.
  // The same for the share.
  const [usageCapKnown, setUsageCapKnown] = useState(false);
  const [usageShareKnown, setUsageShareKnown] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsLoaded = settingsVersion != null;

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    apiFetch<OfficeSettingsRes>("GET", "/api/office/settings")
      .then((r) => {
        if (cancelled) return;
        setText(r.prompt ?? "");
        setName(r.name ?? "");
        setBaselinePrompt(r.prompt ?? "");
        setBaselineName(r.name ?? "");
        setUsageCapKnown(r.memberUsageCap !== undefined);
        setUsageCap(r.memberUsageCap ?? false);
        setBaselineUsageCap(r.memberUsageCap ?? false);
        setUsageShareKnown(r.memberUsageShare !== undefined);
        setUsageShare(r.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
        setBaselineUsageShare(r.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
        setUsageStatus(r.memberUsageStatus ?? []);
        setSettingsVersion(r.version);
      })
      .catch(() => {
        // Leave version null -> fields stay read-only, Save stays disabled
        // (no way to write safely).
      });
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  async function handleSave() {
    // The office settings PUT and the memory REPLACE are separate calls: memory
    // rides the permissive /api/memory surface, not the owner-only settings
    // endpoint. Either failing surfaces server.message in the shared status slot
    // and keeps the reader on the pane; a memory conflict (409) says so.
    if (settingsVersion == null) return;
    setSaving(true);
    const body: OfficeSettingsReq = {
      prompt: text.trim() ? text : null,
      name: name.trim() || null,
      version: settingsVersion,
      ...(usageCapKnown ? { memberUsageCap: usageCap } : {}),
      ...(usageShareKnown ? { memberUsageShare: usageShare } : {}),
    };
    try {
      await apiFetch<void>("PUT", "/api/office/settings", body);
      // The PUT SPENT the token, so refresh it here - before anything that can
      // fail and return, or a memory conflict would leave the token spent and
      // the next Save would blame a phantom concurrent writer. Its own
      // try/catch, because a failed re-read is not a failed save. The fields
      // are set from the response too, so a value the server normalized (an
      // all-whitespace prompt stored as null) cannot leave the field and the
      // baseline disagreeing.
      try {
        const next = await apiFetch<OfficeSettingsRes>(
          "GET",
          "/api/office/settings",
        );
        setText(next.prompt ?? "");
        setName(next.name ?? "");
        setBaselinePrompt(next.prompt ?? "");
        setBaselineName(next.name ?? "");
        setUsageCapKnown(next.memberUsageCap !== undefined);
        setUsageCap(next.memberUsageCap ?? false);
        setBaselineUsageCap(next.memberUsageCap ?? false);
        setUsageShareKnown(next.memberUsageShare !== undefined);
        setUsageShare(next.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
        setBaselineUsageShare(next.memberUsageShare ?? DEFAULT_MEMBER_SHARE);
        setUsageStatus(next.memberUsageStatus ?? []);
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
      setSavedAt(Date.now());
      const m = await mem.save();
      if (!m.ok) {
        setStatus({ kind: "error", message: m.message });
        return;
      }
    } catch (e) {
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
    (settingsLoaded &&
      (name !== baselineName ||
        text !== baselinePrompt ||
        usageCap !== baselineUsageCap ||
        usageShare !== baselineUsageShare)) ||
    mem.dirty;
  const discardPrompt = useUnsavedChangesPrompt(dirty, closeRef, () => {
    setName(baselineName);
    setText(baselinePrompt);
    setUsageCap(baselineUsageCap);
    setUsageShare(baselineUsageShare);
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

        {!readOnly && usageCapKnown && (
          <>
            <label
              style={{
                display: "flex",
                gap: 6,
                marginTop: 18,
                fontSize: 12,
                color: "var(--text-primary)",
              }}
            >
              <input
                type="checkbox"
                checked={usageCap}
                disabled={!settingsLoaded}
                onChange={(e) => setUsageCap(e.target.checked)}
              />
              <span>{t("settings.office.memberUsageCap")}</span>
            </label>
            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "3px 0 0",
                lineHeight: 1.4,
              }}
            >
              {t("settings.office.memberUsageCapHint")}
            </p>
            {usageCap && usageShareKnown && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                <span>{t("settings.office.memberUsageShare")}</span>
                <select
                  value={usageShare}
                  disabled={!settingsLoaded}
                  onChange={(e) => setUsageShare(Number(e.target.value))}
                  style={{
                    ...inputStyle,
                    width: "auto",
                    padding: "2px 6px",
                    cursor: "pointer",
                  }}
                >
                  {MEMBER_SHARE_OPTIONS.map((share) => (
                    <option key={share} value={share}>
                      {t("settings.office.memberUsageShareOption", {
                        share: formatNumber(language, share),
                      })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {baselineUsageCap &&
              usageStatus.map((row) => (
                <p
                  key={row.provider}
                  style={{
                    fontSize: 10,
                    color:
                      row.state === "failed" ? "#ff6b6b" : "var(--text-muted)",
                    margin: "3px 0 0",
                  }}
                >
                  {usageStatusLine(row, t, language)}
                </p>
              ))}
          </>
        )}

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
          {t("common.rules")}{" "}
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
                  size: mem.size,
                  cap: mem.cap ?? "…",
                })}
              </span>
            </label>
            <ExpandableTextarea
              title={t("settings.office.memoryTitle")}
              hint={t("common.memoryEditorHint")}
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
                  setUsageCap(baselineUsageCap);
                  setUsageShare(baselineUsageShare);
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
                disabled={saving || settingsVersion == null}
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

// One status line of the member usage cap. Provider names are proper nouns.
function usageStatusLine(
  row: OfficeUsageStatusWire,
  t: ReturnType<typeof useI18n>["t"],
  language: ReturnType<typeof useI18n>["language"],
): string {
  const provider = row.provider === "claude" ? "Claude" : "Codex";
  if (row.state !== "weekly")
    return row.state === "no_limit"
      ? t("settings.office.memberUsageNoLimit", { provider })
      : t("settings.office.memberUsageFailed", { provider });
  return t("settings.office.memberUsageWeekly", {
    provider,
    used: formatNumber(language, Math.round(row.usedPercent)),
    // One decimal: a rounded line (11% for 11.4%) would read as a stop at a
    // use that still runs.
    line: formatNumber(language, Math.round(row.linePercent * 10) / 10),
  });
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
      <p style={{ fontSize: 10, color: "var(--accent)", margin: "4px 0 0" }}>
        {tn("settings.office.loadedVariables", status.keyCount ?? 0)}
      </p>
    );
  }
  return (
    <p style={{ fontSize: 10, color: "#ff6b6b", margin: "4px 0 0" }}>
      {status.message}
    </p>
  );
}

const inputStyle: React.CSSProperties = dialogInput;
// Visually-distinct read-only variant: grayed text + opacity, matches the
// "view only" framing for member sessions opening the office settings.
const readOnlyInputStyle: React.CSSProperties = {
  ...dialogInput,
  color: "var(--text-ghost)",
  background: "var(--bg-input)",
  cursor: "default",
  opacity: 0.75,
};
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
