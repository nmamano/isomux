import { useState } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { send } from "../ws.ts";

export function SpawnDialog({
  deskIndex,
  defaultCwd,
  onClose,
}: {
  deskIndex: number;
  defaultCwd: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [permissionMode, setPermissionMode] = useState<AgentInfo["permissionMode"]>("acceptEdits");

  function handleSpawn() {
    send({
      type: "spawn",
      name: name || `Agent ${deskIndex + 1}`,
      cwd,
      permissionMode,
      desk: deskIndex,
    });
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "rgba(14,20,35,0.96)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: "24px 28px",
          width: 360,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "#e0e8f5" }}>Spawn New Agent</h3>
        <p style={{ fontSize: 12, color: "#4a5a7a", margin: "2px 0 18px" }}>Desk #{deskIndex + 1}</p>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6a7a9a", marginBottom: 5 }}>
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Agent ${deskIndex + 1}`}
          autoFocus
          style={inputStyle}
        />

        <label
          style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6a7a9a", marginBottom: 5, marginTop: 12 }}
        >
          Working Directory
        </label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project"
          style={inputStyle}
        />

        <label
          style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6a7a9a", marginBottom: 5, marginTop: 12 }}
        >
          Permission Mode
        </label>
        <select
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as AgentInfo["permissionMode"])}
          style={{
            ...inputStyle,
            appearance: "none",
            cursor: "pointer",
          }}
        >
          <option value="default">Default (ask for everything)</option>
          <option value="acceptEdits">Accept Edits (auto-approve file changes)</option>
          <option value="bypassPermissions">Bypass (auto-approve all)</option>
        </select>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={cancelBtnStyle}>
            Cancel
          </button>
          <button onClick={handleSpawn} style={spawnBtnStyle}>
            Spawn
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  background: "rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  color: "#e0e8f5",
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.06)",
  background: "transparent",
  color: "#8a9ab8",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};

const spawnBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "#7eb8ff",
  color: "#0a0e16",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};
