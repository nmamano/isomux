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
import {
  ExpandableTextarea,
  isExpandedEditorOpen,
} from "./ExpandableTextarea.tsx";
import { StorageModal } from "./StorageModal.tsx";
import { UsageModal } from "./UsageModal.tsx";

type ValidationStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; keyCount?: number }
  | { kind: "error"; message: string };

export function OfficePromptModal({ onClose }: { onClose: () => void }) {
  const { office, isMobile, sessionContext } = useAppState();
  // Members can open this modal but can't edit it. Read-only state grays
  // inputs and hides the Save button; the server also rejects the save from
  // non-owner sessions (office.setSettings is gated by the officeOwner guard).
  const isOwner = sessionContext?.role === "owner";
  const readOnly = !isOwner;
  const [text, setText] = useState(office.prompt ?? "");
  const [envFile, setEnvFile] = useState(office.envFile ?? "");
  const [name, setName] = useState(office.name ?? "");
  // Office memory is edited via the unified /api/memory verbs (load + version-
  // guarded save). Disabled until the load resolves; saved separately from the
  // office settings PUT.
  const mem = useMemoryEditor("office", null, !readOnly);
  // The settings PUT is version-guarded (optimistic concurrency, mirroring the
  // memory editor): GET on open (owner-only GET, so skip for read-only members
  // - they never save), send the version back on save; a 409 means another
  // writer saved since. The token must stay coupled to the BYTES read with it,
  // so ALL guarded fields (prompt/envFile/name - one version over the whole
  // blob) hydrate from the same GET response; never pair store-snapshot fields
  // with the GET's version, or a fresher server blob gets silently blessed
  // over. Until the load resolves the fields are read-only and Save stays
  // disabled; the store values paint first purely as placeholders.
  const [settingsVersion, setSettingsVersion] = useState<string | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [status, setStatus] = useState<ValidationStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsLoaded = settingsVersion != null;

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    apiFetch<OfficeSettingsRes>("GET", "/api/office/settings")
      .then((r) => {
        if (cancelled) return;
        setText(r.prompt ?? "");
        setEnvFile(r.envFile ?? "");
        setName(r.name ?? "");
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

  // Ask the server to re-validate the stored env file on open. Members
  // can't validate office env files (the server gates that command to
  // owners), so skip the request entirely - the input still shows the
  // stored path for context.
  useEffect(() => {
    const saved = office.envFile;
    if (!saved || readOnly) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "pending" });
    let cancelled = false;
    apiFetch<{ ok: boolean; keyCount?: number; error?: string }>(
      "POST",
      "/api/validate/env",
      { scope: "office" },
    )
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setStatus({ kind: "ok", keyCount: r.keyCount });
        else
          setStatus({ kind: "error", message: r.error || "Invalid env file" });
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Invalid env file",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [office.envFile, readOnly]);

  async function handleSave() {
    // The office settings PUT and the memory REPLACE are separate calls: memory
    // rides the permissive /api/memory surface, not the owner-only settings
    // endpoint. Either failing surfaces server.message in the shared status slot
    // and keeps the dialog open; a memory conflict (409) asks the user to reopen.
    if (settingsVersion == null) return;
    setSaving(true);
    const body: OfficeSettingsReq = {
      prompt: text.trim() ? text : null,
      envFile: envFile.trim() || null,
      name: name.trim() || null,
      version: settingsVersion,
    };
    try {
      await apiFetch<void>("PUT", "/api/office/settings", body);
      const m = await mem.save();
      if (!m.ok) {
        setStatus({ kind: "error", message: m.message });
        return;
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        setStatus({
          kind: "error",
          message:
            "Office settings changed since you opened this - reopen the dialog to edit the latest.",
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

  // ESC to close. Stands down entirely while the storage panel is up (both
  // listeners sit on `window` in the capture phase, and stopPropagation does
  // not stop a sibling listener on the SAME target - without the storageOpen
  // guard one Escape would close the storage panel and this dialog together),
  // and stands down while an expanded editor is open, which collapses instead
  // (this capture listener runs before the overlay's own).
  useEffect(() => {
    if (storageOpen || usageOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isExpandedEditorOpen()) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, storageOpen, usageOpen]);

  // Exactly ONE dialog layer is live at a time. The storage panel REPLACES this
  // one rather than stacking on it: two overlays means two backdrops, two
  // Escape handlers, and a focus order nobody can predict. This component stays
  // mounted throughout, so unsaved edits in the fields below survive a trip
  // through storage and back.
  if (storageOpen) return <StorageModal onBack={() => setStorageOpen(false)} />;
  if (usageOpen) return <UsageModal onBack={() => setUsageOpen(false)} />;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: "24px 28px",
          marginTop: isMobile ? "env(safe-area-inset-top, 16px)" : undefined,
          marginBottom: isMobile ? 16 : undefined,
          width: isMobile ? "calc(100% - 32px)" : 440,
          maxWidth: isMobile ? "100%" : undefined,
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
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
          Env File Path{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (optional, absolute path)
          </span>
        </label>
        <input
          value={envFile}
          onChange={(e) => {
            setEnvFile(e.target.value);
            setStatus({ kind: "idle" });
          }}
          placeholder="/home/you/.secrets/office.env"
          readOnly={readOnly || !settingsLoaded}
          style={readOnly || !settingsLoaded ? readOnlyInputStyle : inputStyle}
        />
        <ValidationLine status={status} />

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
          Usage{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (tokens and estimated cost)
          </span>
        </label>
        <button
          onClick={() => setUsageOpen(true)}
          style={{
            ...cancelBtnStyle,
            width: "100%",
            textAlign: "left",
            padding: "9px 12px",
          }}
        >
          Open usage…
        </button>

        {/* Storage is owner-only, matching the server: POST /api/storage/prune
            is gated on officeOwner, and GET /api/storage/usage strips the
            per-agent detail and every filesystem path for anyone else. A member
            who opened this dialog read-only never sees the entry point. */}
        {isOwner && (
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
              Storage{" "}
              <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
                (disk usage; delete old files)
              </span>
            </label>
            <button
              onClick={() => setStorageOpen(true)}
              style={{
                ...cancelBtnStyle,
                width: "100%",
                textAlign: "left",
                padding: "9px 12px",
              }}
            >
              Open storage…
            </button>
          </>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button
              onClick={() => void handleSave()}
              style={saveBtnStyle}
              disabled={saving || settingsVersion == null}
            >
              {saving ? "Saving…" : "Save"}
            </button>
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
