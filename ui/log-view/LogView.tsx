import { useState, useRef, useEffect } from "react";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import { StatusLight } from "../office/StatusLight.tsx";
import { send } from "../ws.ts";

export function LogView({
  agent,
  logs,
  onBack,
}: {
  agent: AgentInfo;
  logs: LogEntry[];
  onBack: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    send({ type: "send_message", agentId: agent.id, text });
    setInput("");
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0a0e16",
        animation: "termEnter 0.3s ease-out",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          height: 48,
          background: "rgba(15,20,32,0.95)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.07)",
            background: "rgba(255,255,255,0.03)",
            color: "#8a9ab8",
            fontFamily: "'DM Sans',sans-serif",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ← Back to Office
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <StatusLight state={agent.state} size={8} />
          <span style={{ fontWeight: 600, color: "#e0e8f5" }}>{agent.name}</span>
          <span style={{ color: "#3a4a6a" }}>&middot;</span>
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              color: "#5a6f8f",
              fontSize: 12,
            }}
          >
            {agent.cwd}
          </span>
        </div>
        <div style={{ width: 100 }} />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 24px",
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 13,
          lineHeight: 1.7,
          color: "#c0c8d8",
        }}
      >
        {logs.length === 0 && (
          <div style={{ color: "#3a4a6a", textAlign: "center", marginTop: 40 }}>
            Send a message to start a conversation.
          </div>
        )}
        {logs.map((entry) => (
          <div
            key={entry.id}
            style={{
              marginBottom: 8,
              padding: "6px 10px",
              borderRadius: 6,
              background:
                entry.kind === "user_message"
                  ? "rgba(126,184,255,0.06)"
                  : entry.kind === "error"
                    ? "rgba(232,93,117,0.08)"
                    : "transparent",
            }}
          >
            {entry.kind === "user_message" && (
              <span style={{ color: "#7eb8ff", fontWeight: 600, fontSize: 11, marginRight: 8 }}>You:</span>
            )}
            <span
              style={{
                color:
                  entry.kind === "error"
                    ? "#E85D75"
                    : entry.kind === "user_message"
                      ? "#7eb8ff"
                      : "#c0c8d8",
              }}
            >
              {entry.content}
            </span>
          </div>
        ))}
      </div>

      {/* Input */}
      <div
        style={{
          padding: "12px 24px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          background: "rgba(15,20,32,0.95)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#50B86C", fontWeight: 600 }}>&#10095;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            placeholder="Type a message to the agent..."
            autoFocus
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#c0c8d8",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 13,
              caretColor: "#50B86C",
            }}
          />
        </div>
      </div>
    </div>
  );
}
