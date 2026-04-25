import { useEffect, useRef, useState } from "react";
import type { AgentInfo, AgentOutfit, ClientCommand, EffortLevel, ModelFamily } from "../../shared/types.ts";
import { MODEL_FAMILIES, EFFORT_LEVELS, DEFAULT_EFFORT, modelVersionLabel } from "../../shared/types.ts";
import { SHIRT_COLORS, HAIR_COLORS, SKIN_COLORS, HAIR_STYLES, BEARDS, HATS, ACCESSORIES } from "../../shared/outfit-options.ts";
import { Character } from "../office/Character.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import { useAppState } from "../store.tsx";

const HAIR_STYLE_LABELS: Record<AgentOutfit["hairStyle"], string> = {
  short: "Short",
  long: "Long",
  ponytail: "Ponytail",
  bun: "Bun",
  pigtails: "Pigtails",
  curly: "Curly",
  bald: "Bald",
};

const HAT_LABELS: Record<AgentOutfit["hat"], string> = {
  none: "None",
  cap: "Cap",
  beanie: "Beanie",
  bow: "Hair Bow",
  headband: "Headband",
};

const ACCESSORY_LABELS: Record<string, string> = {
  none: "None",
  glasses: "Glasses",
  headphones: "Headphones",
  bow_tie: "Bow Tie",
  tie: "Tie",
  earrings: "Earrings",
};

const BEARD_LABELS: Record<AgentOutfit["beard"], string> = {
  none: "None",
  stubble: "Stubble",
  full: "Full",
  goatee: "Goatee",
  mustache: "Mustache",
};

function makeRandomOutfit(): AgentOutfit {
  return {
    hat: HATS[Math.floor(Math.random() * HATS.length)],
    color: SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)],
    hair: HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)],
    hairStyle: HAIR_STYLES[Math.floor(Math.random() * HAIR_STYLES.length)],
    skin: SKIN_COLORS[Math.floor(Math.random() * SKIN_COLORS.length)],
    beard: BEARDS[Math.floor(Math.random() * BEARDS.length)],
    accessory: ACCESSORIES[Math.floor(Math.random() * ACCESSORIES.length)],
  };
}

type EditAgentDialogProps = {
  onClose: () => void;
} & (
  | { agent: AgentInfo; deskIndex?: undefined; room?: undefined; defaultCwd?: undefined }
  | { agent?: undefined; deskIndex: number; room: number; defaultCwd: string }
);

export function EditAgentDialog(props: EditAgentDialogProps) {
  const { onClose } = props;
  const isSpawn = !props.agent;
  const agent = props.agent;

  const { recentCwds: allRecentCwds, isMobile, agents, rooms } = useAppState();
  const roomCount = rooms.length;
  const [name, setName] = useState(agent?.name ?? "");
  const [cwd, setCwd] = useState(agent?.cwd ?? props.defaultCwd ?? "~");
  const [outfit, setOutfit] = useState<AgentOutfit>(agent ? { ...agent.outfit } : makeRandomOutfit);
  const [customInstructions, setCustomInstructions] = useState(agent?.customInstructions ?? "");
  const [modelFamily, setModelFamily] = useState<ModelFamily>(agent?.modelFamily ?? MODEL_FAMILIES[0].family);
  const [effort, setEffort] = useState<EffortLevel>(agent?.effort ?? DEFAULT_EFFORT);
  const initialPermissionMode: AgentInfo["permissionMode"] =
    agent?.permissionMode === "auto" && (agent?.modelFamily ?? MODEL_FAMILIES[0].family) !== "opus"
      ? "bypassPermissions"
      : (agent?.permissionMode ?? "auto");
  const [permissionMode, setPermissionMode] = useState<AgentInfo["permissionMode"]>(initialPermissionMode);
  const [saving, setSaving] = useState(false);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const pendingListener = useRef<((data: string) => void) | null>(null);
  const recentCwds = allRecentCwds.filter((c) => c !== cwd);

  useEffect(() => {
    return () => {
      if (pendingListener.current) removeRawListener(pendingListener.current);
    };
  }, []);

  // Validate the existing cwd when the edit dialog opens, so the user sees
  // immediately if the stored directory is gone.
  useEffect(() => {
    if (isSpawn || !agent) return;
    const initialCwd = agent.cwd;
    const reqId = `cwd-check-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "cwd_validation" && msg.requestId === reqId) {
          removeRawListener(listener);
          if (!msg.ok) setCwdError(msg.error || "Invalid directory");
        }
      } catch {}
    };
    addRawListener(listener);
    send({ type: "request_cwd_validation", requestId: reqId, cwd: initialCwd });
    return () => removeRawListener(listener);
  }, [isSpawn, agent?.id]);

  function handleSave() {
    const reqId = `agent-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "agent_save_response" && msg.requestId === reqId) {
          removeRawListener(listener);
          pendingListener.current = null;
          setSaving(false);
          if (msg.ok) {
            onClose();
          } else {
            setCwdError(msg.error || "Save failed");
          }
        }
      } catch {}
    };

    if (isSpawn) {
      const targetRoomId = rooms[props.room!]?.id;
      setCwdError(null);
      setSaving(true);
      addRawListener(listener);
      pendingListener.current = listener;
      send({
        type: "spawn",
        requestId: reqId,
        name: name || `Agent ${props.deskIndex! + 1}`,
        cwd,
        permissionMode,
        desk: props.deskIndex!,
        roomId: targetRoomId,
        outfit,
        customInstructions: customInstructions.trim() || undefined,
        modelFamily,
        effort,
      });
    } else {
      const cmd: Extract<ClientCommand, { type: "edit_agent" }> = { type: "edit_agent", agentId: agent!.id };
      if (name.trim() && name.trim() !== agent!.name) cmd.name = name.trim();
      if (cwd.trim() && cwd.trim() !== agent!.cwd) cmd.cwd = cwd.trim();
      if (JSON.stringify(outfit) !== JSON.stringify(agent!.outfit)) cmd.outfit = outfit;
      const trimmedInstructions = customInstructions.trim();
      if (trimmedInstructions !== (agent!.customInstructions ?? "")) cmd.customInstructions = trimmedInstructions;
      if (modelFamily !== agent!.modelFamily) cmd.modelFamily = modelFamily;
      if (effort !== agent!.effort) cmd.effort = effort;
      if (permissionMode !== agent!.permissionMode) cmd.permissionMode = permissionMode;
      if (!(cmd.name || cmd.cwd || cmd.outfit || cmd.customInstructions !== undefined || cmd.modelFamily || cmd.effort || cmd.permissionMode)) {
        onClose();
        return;
      }
      setCwdError(null);
      // Only round-trip through the server when we need cwd validation; other
      // edits have no failure mode worth blocking the dialog on.
      if (cmd.cwd) {
        cmd.requestId = reqId;
        setSaving(true);
        addRawListener(listener);
        pendingListener.current = listener;
        send(cmd);
      } else {
        send(cmd);
        onClose();
      }
    }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: isMobile ? "none" : "1px solid var(--border-light)",
          borderRadius: isMobile ? 0 : 16,
          display: "flex",
          flexDirection: "column",
          width: isMobile ? "100%" : 380,
          maxWidth: isMobile ? "100%" : undefined,
          height: isMobile ? "100dvh" : undefined,
          maxHeight: isMobile ? "100dvh" : "90vh",
          boxShadow: isMobile ? "none" : "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <div style={{ overflowY: "auto", flex: 1, padding: isMobile ? "max(24px, env(safe-area-inset-top)) 20px 0" : "24px 28px 0" }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>{isSpawn ? "Spawn New Agent" : "Edit Agent"}</h3>
        <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "2px 0 18px" }}>
          {isSpawn
            ? `Desk #${props.deskIndex! + 1}`
            : `${roomCount > 1 ? `${rooms[agent!.room]?.name ?? `Room ${agent!.room + 1}`}, ` : ""}Desk #${agent!.desk + 1}`}
        </p>

        <label style={labelStyle}>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSpawn ? `Agent ${props.deskIndex! + 1}` : undefined}
          autoFocus={isSpawn}
          style={inputStyle}
        />

        <label style={{ ...labelStyle, marginTop: 12 }}>Working Directory</label>
        <input
          value={cwd}
          onChange={(e) => { setCwd(e.target.value); if (cwdError) setCwdError(null); }}
          style={cwdError ? { ...inputStyle, borderColor: "#ff6b6b" } : inputStyle}
        />
        {cwdError && <p style={{ fontSize: 10, color: "#ff6b6b", margin: "4px 0 0" }}>{cwdError}</p>}
        {recentCwds.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {recentCwds.map((c) => (
              <button
                key={c}
                onClick={() => { setCwd(c); if (cwdError) setCwdError(null); }}
                style={chipStyle}
              >
                {c.replace(/^\/home\/[^/]+/, "~")}
              </button>
            ))}
          </div>
        )}
        {!isSpawn && <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>Changes take effect on next conversation.</p>}

        <label style={{ ...labelStyle, marginTop: 12 }}>Permission Mode</label>
        <select
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as AgentInfo["permissionMode"])}
          style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
        >
          {modelFamily === "opus" && <option value="auto">Auto (classifier auto-approves safe actions)</option>}
          <option value="default">Default (ask for everything)</option>
          <option value="acceptEdits">Accept Edits (auto-approve file changes)</option>
          <option value="bypassPermissions">Bypass (auto-approve all)</option>
        </select>

        <label style={{ ...labelStyle, marginTop: 12 }}>Model</label>
        <select
          value={modelFamily}
          onChange={(e) => {
            const next = e.target.value as ModelFamily;
            setModelFamily(next);
            if (next !== "opus" && permissionMode === "auto") setPermissionMode("bypassPermissions");
            if (next !== "opus" && effort === "max") setEffort("xhigh");
          }}
          style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
        >
          {MODEL_FAMILIES.map((m) => (
            <option key={m.family} value={m.family}>{m.label} ({modelVersionLabel(m.family)})</option>
          ))}
        </select>

        <label style={{ ...labelStyle, marginTop: 12 }}>Thinking Effort</label>
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value as EffortLevel)}
          style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
        >
          {EFFORT_LEVELS.filter((opt) => opt.level !== "max" || modelFamily === "opus").map((opt) => (
            <option key={opt.level} value={opt.level}>{opt.label}</option>
          ))}
        </select>

        <label style={{ ...labelStyle, marginTop: 14 }}>Appearance</label>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
          <div style={{ width: 52, height: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Character state="idle" outfit={outfit} />
          </div>
          <button onClick={() => setOutfit(makeRandomOutfit())} style={randomBtnStyle}>
            Randomize
          </button>
        </div>

        {/* Skin Color */}
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Skin</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
          {SKIN_COLORS.map((c) => (
            <div
              key={c}
              onClick={() => setOutfit({ ...outfit, skin: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: c,
                cursor: "pointer",
                border: outfit.skin === c ? "2px solid var(--text-primary)" : "2px solid transparent",
              }}
            />
          ))}
        </div>

        {/* Shirt Color */}
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Shirt</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
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
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hair Color</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
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

        {/* Hair Style & Hat */}
        <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hair Style</div>
            <select
              value={outfit.hairStyle ?? "short"}
              onChange={(e) => setOutfit({ ...outfit, hairStyle: e.target.value as AgentOutfit["hairStyle"] })}
              style={selectStyle}
            >
              {HAIR_STYLES.map((s) => (
                <option key={s} value={s}>{HAIR_STYLE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hat</div>
            <select
              value={outfit.hat}
              onChange={(e) => setOutfit({ ...outfit, hat: e.target.value as AgentOutfit["hat"] })}
              style={selectStyle}
            >
              {HATS.map((h) => (
                <option key={h} value={h}>{HAT_LABELS[h]}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Beard & Accessory */}
        <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Beard</div>
            <select
              value={outfit.beard ?? "none"}
              onChange={(e) => setOutfit({ ...outfit, beard: e.target.value as AgentOutfit["beard"] })}
              style={selectStyle}
            >
              {BEARDS.map((b) => (
                <option key={b} value={b}>{BEARD_LABELS[b]}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Accessory</div>
            <select
              value={outfit.accessory ?? "none"}
              onChange={(e) => setOutfit({ ...outfit, accessory: e.target.value === "none" ? null : e.target.value as AgentOutfit["accessory"] })}
              style={selectStyle}
            >
              {ACCESSORIES.map((a) => (
                <option key={a ?? "none"} value={a ?? "none"}>{ACCESSORY_LABELS[a ?? "none"]}</option>
              ))}
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
        <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>
          Run <code>/isomux-system-prompt</code> in a chat to see the agent's full system prompt.
          {!isSpawn && " Changes take effect on next conversation."}
        </p>

        {/* Move to Room — only show when multiple rooms exist and editing */}
        {!isSpawn && roomCount > 1 && (
          <>
            <label style={{ ...labelStyle, marginTop: 14 }}>Move to Room</label>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {Array.from({ length: roomCount }, (_, i) => {
                if (i === agent!.room) return null;
                const roomAgentCount = agents.filter((a) => a.room === i).length;
                const isFull = roomAgentCount >= 8;
                return (
                  <button
                    key={i}
                    disabled={isFull}
                    onClick={() => {
                      const targetRoomId = rooms[i]?.id;
                      if (!targetRoomId) return;
                      send({ type: "move_agent", agentId: agent!.id, targetRoomId });
                      onClose();
                    }}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: isFull ? "var(--bg-input)" : "var(--btn-surface)",
                      color: isFull ? "var(--text-ghost)" : "var(--text-dim)",
                      fontSize: 11,
                      cursor: isFull ? "not-allowed" : "pointer",
                      fontFamily: "'JetBrains Mono',monospace",
                      opacity: isFull ? 0.5 : 1,
                    }}
                  >
                    {rooms[i]?.name ?? `Room ${i + 1}`} ({roomAgentCount}/8)
                  </button>
                );
              })}
            </div>
          </>
        )}

        </div>
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: isMobile ? "16px 20px max(16px, env(safe-area-inset-bottom))" : "16px 28px",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>Cancel</button>
          <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>{saving ? "Saving…" : (isSpawn ? "Spawn" : "Save")}</button>
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
};

const randomBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid var(--border-light)",
  background: "var(--bg-hover)",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
};
