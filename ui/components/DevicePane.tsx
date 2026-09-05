import { useEffect, useState } from "react";
import { getDevice, setDevice } from "../device-settings.ts";
import { sectionHeader, hint as hintStyle } from "./access-shared.tsx";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";

// Device-scoped settings (one record per browser, stored in localStorage).
// Just the device label: user-level preferences (notifications, env, language)
// live on the server and are edited under You, so they follow the person
// rather than the browser.
//
// The label is dirty-capable, so this pane registers into the settings page's
// closeRef. Without that a sidebar click would drop a typed-but-unsaved label
// with no discard prompt.
export function DevicePane({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const saved = getDevice() ?? "";
  const [label, setLabel] = useState<string>(saved);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = label.trim() !== saved;

  // Mirror the guard into the page's ref every render so the captured closure
  // always sees fresh form state - the same no-deps pattern UserEditPanel and
  // TaskView use for their own dirty checks.
  useEffect(() => {
    if (closeRef) {
      closeRef.current = (after?: () => void) => {
        if (dirty && !confirm("Discard unsaved changes to the device label?")) {
          return;
        }
        after?.();
      };
    }
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  function handleSave() {
    setDevice(label.trim() || null);
    setJustSaved(true);
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>Device label</h4>
      <p style={hintStyle}>
        Stored in this browser. Tells agents which device you are on (for
        example "Phone" against "Laptop") so they can adjust their replies.
      </p>

      <label style={labelStyle}>
        Device Label <span style={hintTextStyle}>(optional)</span>
      </label>
      <input
        value={label}
        onChange={(e) => {
          setLabel(e.target.value.slice(0, 24));
          setJustSaved(false);
        }}
        maxLength={24}
        placeholder="Phone, Laptop, …"
        style={{ ...inputStyle, maxWidth: 320 }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
        }}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button
          onClick={() => {
            setLabel(saved);
            setJustSaved(false);
          }}
          disabled={!dirty}
          style={{ ...cancelBtnStyle, opacity: dirty ? 1 : 0.5 }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty}
          style={{ ...saveBtnStyle, opacity: dirty ? 1 : 0.5 }}
        >
          {justSaved && !dirty ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 16 };
const hintTextStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
