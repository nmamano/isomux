import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import type {
  OfficeSettingsReq,
  OfficeSettingsRes,
} from "../../shared/contract-shapes.ts";
import {
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import { ExpandableTextarea } from "./ExpandableTextarea.tsx";

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
        setSettingsVersion(next.version);
      } catch {
        // No safe token to write with: null disables Save rather than leaving
        // it unsafe, matching the failed-hydration path above. The save that
        // already landed still counts.
        setSettingsVersion(null);
        setStatus({
          kind: "error",
          message:
            "Saved, but this page could not reload the office. Select another row and come back to keep editing.",
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
          message:
            "Office settings changed somewhere else since this page loaded. Select another row and come back to load the latest.",
        });
      } else {
        setStatus({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Save failed",
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
  useEffect(() => {
    if (closeRef) {
      closeRef.current = (after?: () => void) => {
        if (dirty && !confirm("Discard unsaved changes to the office?")) return;
        after?.();
      };
    }
    return () => {
      if (closeRef) closeRef.current = null;
    };
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
          Office Settings
        </h3>
        <p
          style={{
            fontSize: 11,
            color: "var(--text-ghost)",
            margin: "6px 0 0",
            lineHeight: 1.4,
          }}
        >
          The framed sign on the office wall opens this page.
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
            View only. Only office owners can edit office-wide settings.
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
          Office Name{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (optional, shown in browser tab)
          </span>
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nil's Office"
          maxLength={60}
          readOnly={readOnly || !settingsLoaded}
          style={readOnly || !settingsLoaded ? readOnlyInputStyle : inputStyle}
        />

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
          Rules{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (system prompt for all agents)
          </span>
        </label>
        <ExpandableTextarea
          textareaRef={textareaRef}
          title="Office Rules"
          hint="System prompt for all agents. Changes take effect on next conversation."
          value={text}
          onChange={setText}
          placeholder="e.g. Always write tests. Use TypeScript. Be concise."
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
          Changes take effect on next conversation.
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
              Memory{" "}
              <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                (durable office-wide facts; raw lines; {mem.size} /{" "}
                {mem.cap ?? "…"})
              </span>
            </label>
            <ExpandableTextarea
              title="Office Memory"
              hint="This editor rewrites the file exactly as shown. Use one memory per line."
              value={mem.memory}
              onChange={mem.setMemory}
              placeholder={
                mem.loaded
                  ? "Some memory relevant to the entire office"
                  : "Loading memory…"
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
              This editor rewrites the file exactly as shown. Use one memory per
              line.
            </p>
          </>
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
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                style={saveBtnStyle}
                disabled={saving || settingsVersion == null}
              >
                {saving ? "Saving…" : savedAt && !dirty ? "Saved" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationLine({ status }: { status: ValidationStatus }) {
  if (status.kind === "idle") return null;
  if (status.kind === "pending") {
    return (
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "4px 0 0" }}
      >
        Checking…
      </p>
    );
  }
  if (status.kind === "ok") {
    return (
      <p style={{ fontSize: 10, color: "var(--accent)", margin: "4px 0 0" }}>
        Loaded {status.keyCount ?? 0} variable{status.keyCount === 1 ? "" : "s"}
        .
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
