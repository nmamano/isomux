import { useState } from "react";
import type { AgentInfo, AgentOutfit } from "../../shared/types.ts";
import { SHIRT_COLORS, HAIR_COLORS, HATS, ACCESSORIES } from "../../shared/outfit-options.ts";
import { Character } from "../office/Character.tsx";
import { send } from "../ws.ts";
import { useAppState } from "../store.tsx";

export function EditAgentDialog({
  agent,
  onClose,
}: {
  agent: AgentInfo;
  onClose: () => void;
}) {
  const { recentCwds: allRecentCwds, isMobile } = useAppState();
  const [name, setName] = useState(agent.name);
  const [cwd, setCwd] = useState(agent.cwd);
  const [outfit, setOutfit] = useState<AgentOutfit>({ ...agent.outfit });
  const [customInstructions, setCustomInstructions] = useState(agent.customInstructions ?? "");
  const recentCwds = allRecentCwds.filter((c) => c !== cwd);

  function randomizeOutfit() {
    setOutfit({
      hat: HATS[Math.floor(Math.random() * HATS.length)],
      color: SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)],
      hair: HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)],
      accessory: ACCESSORIES[Math.floor(Math.random() * ACCESSORIES.length)],
    });
  }

  function handleSave() {
    const cmd: any = { type: "edit_agent", agentId: agent.id };
    if (name.trim() && name.trim() !== agent.name) cmd.name = name.trim();
    if (cwd.trim() && cwd.trim() !== agent.cwd) cmd.cwd = cwd.trim();
    if (JSON.stringify(outfit) !== JSON.stringify(agent.outfit)) cmd.outfit = outfit;
    const trimmedInstructions = customInstructions.trim();
    if (trimmedInstructions !== (agent.customInstructions ?? "")) cmd.customInstructions = trimmedInstructions;
    if (cmd.name || cmd.cwd || cmd.outfit || cmd.customInstructions !== undefined) send(cmd);
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
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: "24px 28px",
          marginTop: isMobile ? "env(safe-area-inset-top, 16px)" : undefined,
          marginBottom: isMobile ? 16 : undefined,
          width: isMobile ? "calc(100% - 32px)" : 380,
          maxWidth: isMobile ? "100%" : undefined,
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>Edit Agent</h3>
        <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "2px 0 18px" }}>Desk #{agent.desk + 1}</p>

        <label style={labelStyle}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus style={inputStyle} />

        <label style={{ ...labelStyle, marginTop: 12 }}>Working Directory</label>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} style={inputStyle} />
        {recentCwds.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {recentCwds.map((c) => (
              <button
                key={c}
                onClick={() => setCwd(c)}
                style={chipStyle}
              >
                {c.replace(/^\/home\/[^/]+/, "~")}
              </button>
            ))}
          </div>
        )}
        <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>Changes take effect on next conversation.</p>

        <label style={{ ...labelStyle, marginTop: 14 }}>Appearance</label>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
          <div style={{ width: 52, height: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Character state="idle" outfit={outfit} />
          </div>
          <button onClick={randomizeOutfit} style={randomBtnStyle}>
            Randomize
          </button>
        </div>

        {/* Shirt Color */}
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Shirt</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {SHIRT_COLORS.map((c) => (
            <div
              key={c}
              onClick={() => setOutfit({ ...outfit, color: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: c,
                cursor: "pointer",
                border: outfit.color === c ? "2px solid var(--text-primary)" : "2px solid transparent",
              }}
            />
          ))}
        </div>

        {/* Hair Color */}
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hair</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {HAIR_COLORS.map((c) => (
            <div
              key={c}
              onClick={() => setOutfit({ ...outfit, hair: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: c,
                cursor: "pointer",
                border: outfit.hair === c ? "2px solid var(--text-primary)" : "2px solid transparent",
              }}
            />
          ))}
        </div>

        {/* Hat & Accessory */}
        <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hat</div>
            <select
              value={outfit.hat}
              onChange={(e) => setOutfit({ ...outfit, hat: e.target.value as AgentOutfit["hat"] })}
              style={selectStyle}
            >
              <option value="none">None</option>
              <option value="cap">Cap</option>
              <option value="beanie">Beanie</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Accessory</div>
            <select
              value={outfit.accessory ?? "none"}
              onChange={(e) => setOutfit({ ...outfit, accessory: e.target.value === "none" ? null : e.target.value as "glasses" | "headphones" })}
              style={selectStyle}
            >
              <option value="none">None</option>
              <option value="glasses">Glasses</option>
              <option value="headphones">Headphones</option>
            </select>
          </div>
        </div>

        <label style={{ ...labelStyle, marginTop: 14 }}>Custom Instructions <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>(optional)</span></label>
        <textarea
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          placeholder='e.g. "You are a backend specialist. Always write tests."'
          rows={3}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>Changes take effect on next conversation.</p>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={saveBtnStyle}>Save</button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 5,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "none",
  cursor: "pointer",
  width: "100%",
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};

const chipStyle: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--btn-surface)",
  color: "var(--text-muted)",
  fontSize: 10,
  cursor: "pointer",
  fontFamily: "'JetBrains Mono',monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};

const randomBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid var(--border-light)",
  background: "var(--bg-hover)",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};
