import { useState, useRef, useEffect } from "react";
import type { AgentInfo, AgentState, LogEntry } from "../../shared/types.ts";
import { StatusLight } from "../office/StatusLight.tsx";
import { send } from "../ws.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { LogEntryCard } from "./LogEntryCard.tsx";

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  thinking: "Thinking",
  tool_executing: "Running tool",
  starting: "Starting",
  waiting_permission: "Waiting for permission",
};

function ActivityIndicator({ state }: { state: AgentState }) {
  const label = STATE_LABELS[state];
  if (!label) return null;

  const color = state === "waiting_permission" ? "var(--orange)" : "var(--green)";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 14px",
        margin: "8px 0",
        color,
        fontSize: 12,
        fontFamily: "'DM Sans',sans-serif",
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <span style={{ display: "inline-flex", gap: 3 }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: color, animation: "dotBounce 1.4s ease-in-out infinite", animationDelay: "0s" }} />
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: color, animation: "dotBounce 1.4s ease-in-out infinite", animationDelay: "0.2s" }} />
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: color, animation: "dotBounce 1.4s ease-in-out infinite", animationDelay: "0.4s" }} />
      </span>
      <span>{label}...</span>
    </div>
  );
}

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { drafts } = useAppState();
  const dispatch = useDispatch();
  const input = drafts.get(agent.id) ?? "";
  const setInput = (text: string) => dispatch({ type: "set_draft", agentId: agent.id, text });
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll, agent.state]);

  // Auto-resize textarea when draft is restored
  useEffect(() => {
    if (textareaRef.current && input) {
      autoResize(textareaRef.current);
    }
  }, []);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }

  const isBusy = agent.state === "thinking" || agent.state === "tool_executing" || agent.state === "starting";

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    if (isBusy) return;
    send({ type: "send_message", agentId: agent.id, text });
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setAutoScroll(true);
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
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
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-strong)",
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
            border: "1px solid var(--border-medium)",
            background: "var(--btn-surface)",
            color: "var(--text-dim)",
            fontFamily: "'DM Sans',sans-serif",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ← Back to Office
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <StatusLight state={agent.state} size={8} />
          <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{agent.name}</span>
          {STATE_LABELS[agent.state] && (
            <>
              <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
              <span style={{ color: agent.state === "waiting_permission" ? "var(--orange)" : "var(--green)", fontSize: 12, fontFamily: "'DM Sans',sans-serif" }}>
                {STATE_LABELS[agent.state]}
              </span>
            </>
          )}
          <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              color: "var(--text-muted)",
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
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 24px",
          color: "var(--text-secondary)",
        }}
      >
        {logs.length === 0 && (
          <div
            style={{
              color: "var(--text-ghost)",
              textAlign: "center",
              marginTop: 40,
              fontFamily: "'DM Sans',sans-serif",
            }}
          >
            Send a message to start a conversation.
          </div>
        )}
        {logs.map((entry) => (
          <LogEntryCard key={entry.id} entry={entry} />
        ))}
        <ActivityIndicator state={agent.state} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "12px 24px",
          borderTop: "1px solid var(--border-strong)",
          background: "var(--bg-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{ color: isBusy ? "var(--text-ghost)" : "var(--green)", fontWeight: 600, lineHeight: "20px" }}>&#10095;</span>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
              if (e.key === "c" && (e.ctrlKey || e.metaKey) && isBusy) {
                e.preventDefault();
                send({ type: "abort", agentId: agent.id });
              }
            }}
            placeholder={isBusy ? "Agent is busy — Ctrl+C to interrupt..." : "Type a message to the agent..."}
            autoFocus
            rows={1}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: isBusy ? "var(--text-muted)" : "var(--text-secondary)",
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 13,
              caretColor: "var(--green)",
              resize: "none",
              lineHeight: "20px",
              maxHeight: 200,
              overflowY: "auto",
            }}
          />
        </div>
      </div>
    </div>
  );
}
