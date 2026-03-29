import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { AgentInfo, AgentState, LogEntry } from "../../shared/types.ts";
import { StatusLight } from "../office/StatusLight.tsx";
import { send } from "../ws.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { LogEntryCard, serializeEntries } from "./LogEntryCard.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  thinking: "Thinking",
  tool_executing: "Running tool",
  starting: "Starting",
  waiting_permission: "Waiting for permission",
};

const ESCALATION_AMBER_MS = 2 * 60 * 1000; // 2 minutes
const ESCALATION_RED_MS = 5 * 60 * 1000; // 5 minutes

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function escalationColor(elapsedMs: number, baseColor: string): string {
  if (elapsedMs >= ESCALATION_RED_MS) return "var(--red)";
  if (elapsedMs >= ESCALATION_AMBER_MS) return "var(--orange)";
  return baseColor;
}

function ActivityIndicator({ state, stateChangedAt, agentId }: { state: AgentState; stateChangedAt?: number; agentId: string }) {
  const label = STATE_LABELS[state];
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!label) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [label]);

  if (!label) return null;

  const elapsedMs = stateChangedAt ? now - stateChangedAt : 0;
  const baseColor = state === "waiting_permission" ? "var(--orange)" : "var(--green)";
  const color = escalationColor(elapsedMs, baseColor);
  const showAbort = elapsedMs >= ESCALATION_AMBER_MS;

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
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, opacity: 0.7 }}>
        {formatElapsed(elapsedMs)}
      </span>
      {showAbort && (
        <button
          onClick={() => send({ type: "abort", agentId })}
          style={{
            marginLeft: 8,
            padding: "2px 10px",
            borderRadius: 4,
            border: `1px solid ${color}`,
            background: "transparent",
            color,
            fontSize: 11,
            fontFamily: "'DM Sans',sans-serif",
            cursor: "pointer",
            opacity: 0.8,
          }}
        >
          Abort
        </button>
      )}
    </div>
  );
}

function HeaderTimer({ state, stateChangedAt }: { state: AgentState; stateChangedAt?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = stateChangedAt ? now - stateChangedAt : 0;
  const baseColor = state === "waiting_permission" ? "var(--orange)" : "var(--green)";
  const color = escalationColor(elapsedMs, baseColor);
  return (
    <>
      <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
      <span style={{ color, fontSize: 12, fontFamily: "'DM Sans',sans-serif" }}>
        {STATE_LABELS[state]} {formatElapsed(elapsedMs)}
      </span>
    </>
  );
}

export function LogView({
  agent,
  logs,
  onBack,
  onEditAgent,
  username,
}: {
  agent: AgentInfo;
  logs: LogEntry[];
  onBack: () => void;
  onEditAgent: () => void;
  username: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { drafts, slashCommands, stateChangedAt, isMobile } = useAppState();
  const dispatch = useDispatch();
  const input = drafts.get(agent.id) ?? "";
  const setInput = (text: string) => dispatch({ type: "set_draft", agentId: agent.id, text });
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);
  const topicSavedRef = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

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

  // Ctrl+` to toggle terminal panel
  useEffect(() => {
    function handleTerminalShortcut(e: KeyboardEvent) {
      if (isMobile) return;
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setTerminalOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleTerminalShortcut);
    return () => window.removeEventListener("keydown", handleTerminalShortcut);
  }, [isMobile]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }

  const isBusy = agent.state === "thinking" || agent.state === "tool_executing" || agent.state === "starting";

  // Compute agent turns: group entries between user_messages
  // For each entry, determine if it's the last in its agent turn
  const turnData = useMemo(() => {
    const result: { isLastInTurn: boolean; turnEntries: LogEntry[] }[] = [];
    // Identify turn boundaries (user_message entries start a new turn)
    // Agent turn = all non-user entries after a user message, until the next user message
    let currentTurn: { startIdx: number; entries: LogEntry[] } = { startIdx: 0, entries: [] };
    const turns: { startIdx: number; entries: LogEntry[] }[] = [];

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      if (entry.kind === "user_message") {
        // Close previous agent turn if it has entries
        if (currentTurn.entries.length > 0) {
          turns.push(currentTurn);
        }
        // User messages are their own "turn" (no grouping needed)
        turns.push({ startIdx: i, entries: [entry] });
        currentTurn = { startIdx: i + 1, entries: [] };
      } else {
        currentTurn.entries.push(entry);
      }
    }
    if (currentTurn.entries.length > 0) {
      turns.push(currentTurn);
    }

    // Build per-entry lookup
    const entryMap = new Map<string, { isLastInTurn: boolean; turnEntries: LogEntry[] }>();
    for (const turn of turns) {
      if (turn.entries.length === 1 && turn.entries[0].kind === "user_message") {
        entryMap.set(turn.entries[0].id, { isLastInTurn: false, turnEntries: [] });
        continue;
      }
      for (let i = 0; i < turn.entries.length; i++) {
        const isLast = i === turn.entries.length - 1;
        entryMap.set(turn.entries[i].id, { isLastInTurn: isLast, turnEntries: turn.entries });
      }
    }

    return entryMap;
  }, [logs]);

  const getConversationText = useCallback(() => serializeEntries(logs), [logs]);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    if (isBusy) return;
    send({ type: "send_message", agentId: agent.id, text, username });
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setAutoScroll(true);
  }

  return (
    <div
      style={{
        height: isMobile ? "100dvh" : "100vh",
        display: "flex",
        flexDirection: "row",
        background: "var(--bg-base)",
        animation: "termEnter 0.3s ease-out",
      }}
    >
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        position: "relative",
      }}
    >
      {/* Header */}
      {isMobile ? (
        <div style={{
          display: "flex",
          flexDirection: "column",
          padding: "8px 12px",
          paddingTop: "calc(8px + env(safe-area-inset-top, 0px))",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-strong)",
          flexShrink: 0,
          gap: 4,
        }}>
          {/* Row 1 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={onBack} style={{
              padding: "4px 8px", borderRadius: 6,
              border: "1px solid var(--border-medium)",
              background: "var(--btn-surface)",
              color: "var(--text-dim)",
              fontSize: 16, cursor: "pointer", lineHeight: 1,
            }}>←</button>
            <StatusLight state={agent.state} size={8} />
            <span onClick={onEditAgent} style={{
              fontWeight: 600, color: "var(--text-primary)", fontSize: 15,
              cursor: "pointer", flex: 1, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{agent.name}</span>
            {STATE_LABELS[agent.state] && (
              <HeaderTimer state={agent.state} stateChangedAt={stateChangedAt.get(agent.id)} />
            )}
            {logs.length > 0 && <CopyButton getText={getConversationText} />}
          </div>
          {/* Row 2 */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 36 }}>
            <span style={{
              fontFamily: "'JetBrains Mono',monospace",
              color: "var(--text-muted)", fontSize: 12,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              flex: 1,
            }}>{agent.cwd}</span>
          </div>
        </div>
      ) : (
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
            <span
              onClick={onEditAgent}
              style={{ fontWeight: 600, color: "var(--text-primary)", cursor: "pointer" }}
              title="Edit agent"
            ><span style={{ opacity: 0.5 }}>{agent.desk + 1} ·</span> {agent.name}</span>
            {STATE_LABELS[agent.state] && (
              <HeaderTimer state={agent.state} stateChangedAt={stateChangedAt.get(agent.id)} />
            )}
            {agent.topic && agent.topic !== "..." && !editingTopic && (
              <>
                <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
                <span
                  onClick={() => {
                    setEditingTopic(true);
                    setTopicDraft(agent.topic ?? "");
                    setTimeout(() => topicInputRef.current?.focus(), 0);
                  }}
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    cursor: "text",
                  }}
                  title="Click to edit topic"
                >
                  {agent.topic}
                </span>
                <button
                  onClick={() => send({ type: "reset_topic", agentId: agent.id })}
                  disabled={!agent.topicStale}
                  title={agent.topicStale ? "Regenerate topic from conversation" : "No new messages since last generation"}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: agent.topicStale ? "pointer" : "default",
                    color: "var(--text-secondary)",
                    fontSize: 15,
                    padding: "0 4px",
                    opacity: agent.topicStale ? 0.8 : 0.3,
                    transition: "opacity 0.2s",
                    lineHeight: 1,
                  }}
                >
                  ↻
                </button>
              </>
            )}
            {agent.topic === "..." && (
              <>
                <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
                <span style={{ color: "var(--text-ghost)", fontSize: 13 }}>...</span>
              </>
            )}
            {editingTopic && (
              <input
                ref={topicInputRef}
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const trimmed = topicDraft.trim();
                    if (trimmed && trimmed !== agent.topic) {
                      send({ type: "set_topic", agentId: agent.id, topic: trimmed });
                    }
                    topicSavedRef.current = true;
                    setEditingTopic(false);
                  }
                  if (e.key === "Escape") {
                    topicSavedRef.current = true;
                    setEditingTopic(false);
                  }
                }}
                onBlur={() => {
                  if (topicSavedRef.current) {
                    topicSavedRef.current = false;
                    setEditingTopic(false);
                    return;
                  }
                  const trimmed = topicDraft.trim();
                  if (trimmed && trimmed !== agent.topic) {
                    send({ type: "set_topic", agentId: agent.id, topic: trimmed });
                  }
                  setEditingTopic(false);
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-medium)",
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  padding: "1px 6px",
                  fontFamily: "'DM Sans',sans-serif",
                  outline: "none",
                  width: 200,
                }}
              />
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
            {logs.length > 0 && <CopyButton getText={getConversationText} />}
            <button
              onClick={() => setTerminalOpen((prev) => !prev)}
              title={terminalOpen ? "Close terminal (Ctrl+`)" : "Open terminal (Ctrl+`)"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${terminalOpen ? "var(--green-border)" : "var(--border-medium)"}`,
                background: terminalOpen ? "var(--green-bg)" : "var(--btn-surface)",
                color: terminalOpen ? "var(--green)" : "var(--text-muted)",
                fontFamily: "'DM Sans',sans-serif",
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>&gt;_</span>
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: isMobile ? "12px 12px" : "16px 24px",
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
        {logs.map((entry) => {
          const td = turnData.get(entry.id);
          return (
            <LogEntryCard
              key={entry.id}
              entry={entry}
              isLastInTurn={td?.isLastInTurn}
              turnEntries={td?.turnEntries}
              isMobile={isMobile}
            />
          );
        })}
        <ActivityIndicator state={agent.state} stateChangedAt={stateChangedAt.get(agent.id)} agentId={agent.id} />
      </div>

      {/* Scroll to bottom */}
      {!autoScroll && (
        <button
          onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
            setAutoScroll(true);
          }}
          style={{
            position: "absolute",
            bottom: 80,
            right: 32,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "1px solid var(--border-medium)",
            background: "var(--bg-surface)",
            color: "var(--text-muted)",
            fontSize: 16,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            zIndex: 5,
            transition: "opacity 0.15s",
          }}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}

      {/* Input */}
      <div
        style={{
          padding: isMobile ? "10px 12px" : "12px 24px",
          paddingBottom: isMobile ? "calc(10px + env(safe-area-inset-bottom, 0px))" : undefined,
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
                if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                  e.preventDefault();
                  handleSend();
                }
                if (e.key === "c" && (e.ctrlKey || e.metaKey) && isBusy) {
                  e.preventDefault();
                  send({ type: "abort", agentId: agent.id });
                }
              }}
              placeholder={isBusy ? (isMobile ? "Agent is busy..." : "Agent is busy — Ctrl+C to interrupt...") : "Type a message or / for commands..."}
              autoFocus={!isMobile}
              rows={1}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                color: isBusy ? "var(--text-muted)" : "var(--text-secondary)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: isMobile ? 16 : 13,
                caretColor: "var(--green)",
                resize: "none",
                lineHeight: "20px",
                maxHeight: 200,
                overflowY: "auto",
              }}
            />
          </div>
          {isMobile && (
            isBusy ? (
              <button
                onClick={() => send({ type: "abort", agentId: agent.id })}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: "1px solid var(--red)",
                  background: "transparent",
                  color: "var(--red)",
                  fontSize: 16,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
                title="Abort"
              >
                ■
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: "none",
                  background: input.trim() ? "var(--green)" : "var(--bg-hover)",
                  color: input.trim() ? "var(--bg-base)" : "var(--text-ghost)",
                  fontSize: 16,
                  cursor: input.trim() ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                  transition: "background 0.15s, color 0.15s",
                }}
                title="Send"
              >
                ▲
              </button>
            )
          )}
        </div>
      </div>
    </div>
    {!isMobile && terminalOpen && (
      <div style={{ width: "40%", minWidth: 300, maxWidth: 600, flexShrink: 0 }}>
        <TerminalPanel agentId={agent.id} onClose={() => setTerminalOpen(false)} />
      </div>
    )}
    </div>
  );
}
