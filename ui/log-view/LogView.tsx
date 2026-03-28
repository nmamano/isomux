import { useState, useRef, useEffect, useMemo } from "react";
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
  const { drafts, slashCommands } = useAppState();
  const dispatch = useDispatch();
  const input = drafts.get(agent.id) ?? "";
  const setInput = (text: string) => dispatch({ type: "set_draft", agentId: agent.id, text });
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Build merged command list for autocomplete
  const agentCmds = slashCommands.get(agent.id);
  const allCommands = useMemo(() => {
    const cmds: string[] = [];
    if (agentCmds) {
      for (const c of agentCmds.commands) cmds.push(c);
      for (const s of agentCmds.skills) {
        if (!cmds.includes(s)) cmds.push(s);
      }
    }
    return cmds.sort();
  }, [agentCmds]);

  // Filter commands based on input
  const showAutocomplete = input.startsWith("/") && !input.includes(" ") && input.length > 0;
  const partial = input.slice(1).toLowerCase();
  const filteredCommands = useMemo(() => {
    if (!showAutocomplete) return [];
    if (partial === "") return allCommands;
    return allCommands.filter((c) => c.toLowerCase().startsWith(partial));
  }, [showAutocomplete, partial, allCommands]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [filteredCommands.length, partial]);

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
          <div style={{ flex: 1, position: "relative" }}>
            {showAutocomplete && filteredCommands.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  right: 0,
                  marginBottom: 4,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-medium)",
                  borderRadius: 8,
                  maxHeight: 200,
                  overflowY: "auto",
                  boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
                  zIndex: 10,
                }}
              >
                {filteredCommands.map((cmd, i) => {
                  const isSkill = agentCmds?.skills.includes(cmd);
                  return (
                    <div
                      key={cmd}
                      ref={i === selectedIdx ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setInput(`/${cmd} `);
                        textareaRef.current?.focus();
                      }}
                      onMouseEnter={() => setSelectedIdx(i)}
                      style={{
                        padding: "6px 12px",
                        cursor: "pointer",
                        background: i === selectedIdx ? "var(--bg-subtle)" : "transparent",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{
                        color: "var(--green)",
                        fontFamily: "'JetBrains Mono',monospace",
                        fontSize: 13,
                        fontWeight: 600,
                      }}>
                        /{cmd}
                      </span>
                      {isSkill && (
                        <span style={{
                          fontSize: 10,
                          color: "var(--text-ghost)",
                          fontFamily: "'DM Sans',sans-serif",
                          background: "var(--bg-base)",
                          padding: "1px 6px",
                          borderRadius: 4,
                        }}>
                          skill
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize(e.target);
              }}
              onKeyDown={(e) => {
                // Autocomplete navigation
                if (showAutocomplete && filteredCommands.length > 0) {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSelectedIdx((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSelectedIdx((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const selected = filteredCommands[selectedIdx];
                    if (selected) {
                      setInput(`/${selected} `);
                    }
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    const selected = filteredCommands[selectedIdx];
                    // If exact match, send it; otherwise autocomplete
                    if (selected && partial === selected.toLowerCase()) {
                      // Exact match — fall through to send
                    } else if (selected) {
                      e.preventDefault();
                      setInput(`/${selected} `);
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput("");
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
                if (e.key === "c" && (e.ctrlKey || e.metaKey) && isBusy) {
                  e.preventDefault();
                  send({ type: "abort", agentId: agent.id });
                }
              }}
              placeholder={isBusy ? "Agent is busy — Ctrl+C to interrupt..." : "Type a message or / for commands..."}
              autoFocus
              rows={1}
              style={{
                width: "100%",
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
    </div>
  );
}
