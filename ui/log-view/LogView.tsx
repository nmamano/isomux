import { useState, useRef, useEffect, useMemo, useCallback, type RefCallback } from "react";
import type { AgentInfo, AgentState, LogEntry, SkillInfo, Attachment } from "../../shared/types.ts";
import { familyDisplayLabel, type ModelFamily } from "../../shared/types.ts";
import { StatusLight } from "../office/StatusLight.tsx";
import { Character } from "../office/Character.tsx";
import { send } from "../ws.ts";
import { useAppState, useDispatch, useFeatures, useTheme } from "../store.tsx";
import { LogEntryCard, serializeEntries } from "./LogEntryCard.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { SunIcon, MoonIcon } from "../components/ThemeIcons.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  thinking: "Thinking",
  tool_executing: "Running tool",
};

const ESCALATION_AMBER_MS = 2 * 60 * 1000; // 2 minutes
const ESCALATION_RED_MS = 5 * 60 * 1000; // 5 minutes

const MODEL_TINT: Record<ModelFamily, { border: string; bg: string }> = {
  opus:   { border: "rgba(100,160,255,0.85)", bg: "rgba(100,160,255,0.35)" },
  sonnet: { border: "rgba(218,165,32,0.80)",  bg: "rgba(218,165,32,0.32)" },
  haiku:  { border: "rgba(230,130,180,0.80)", bg: "rgba(230,130,180,0.32)" },
};

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

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
  const baseColor = state === "waiting_for_response" ? "var(--purple)" : "var(--green)";
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
  const baseColor = state === "waiting_for_response" ? "var(--purple)" : "var(--green)";
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
  onOpenTasks,
  onSwipeLeft,
  onSwipeRight,
}: {
  agent: AgentInfo;
  logs: LogEntry[];
  onBack: () => void;
  onEditAgent: () => void;
  username: string;
  onOpenTasks?: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { drafts, slashCommands, stateChangedAt, isMobile } = useAppState();
  const dispatch = useDispatch();
  const features = useFeatures();
  const { theme, toggleTheme } = useTheme();
  const input = drafts.get(agent.id) ?? "";
  const inputRef = useRef(input);
  inputRef.current = input;
  const setInput = (text: string) => dispatch({ type: "set_draft", agentId: agent.id, text });
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const topicInputRef = useRef<HTMLInputElement>(null);
  const topicSavedRef = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [showAvatar, setShowAvatar] = useState(() => localStorage.getItem("isomux-show-avatar") !== "false");
  const toggleAvatar = () => setShowAvatar((prev) => { const next = !prev; localStorage.setItem("isomux-show-avatar", String(next)); return next; });
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);
  const [showMicHint, setShowMicHint] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  type StagedAttachment = Attachment & { id: string; uploading: boolean; error?: string };
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const hasUploading = stagedAttachments.some((a) => a.uploading);
  const validAttachments = stagedAttachments.filter((a) => !a.error);
  const [draggingOver, setDraggingOver] = useState(false);
  const [editingLogEntryId, setEditingLogEntryId] = useState<string | null>(null);
  const dragCounterRef = useRef(0);
  const swipeRef = useSwipeLeftRight(onSwipeLeft ?? (() => {}), onSwipeRight ?? (() => {}), isMobile);
  const messagesRef: RefCallback<HTMLDivElement> = useCallback((node: HTMLDivElement | null) => {
    (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    (swipeRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, []);

  // Dismiss edit textarea when agent is no longer idle (e.g. another tab sent a message)
  useEffect(() => {
    if (agent.state !== "waiting_for_response" && editingLogEntryId) {
      setEditingLogEntryId(null);
    }
  }, [agent.state]);

  // Mobile keyboard fix: use visualViewport.height as the container height.
  // On mobile browsers, 100dvh/100vh do NOT shrink when the virtual keyboard
  // opens, so the input bar gets pushed behind it. By tracking the actual
  // visible viewport height and using position:fixed, the container always
  // matches exactly what's visible — keyboard or not. No scrollIntoView hacks.
  const [vpHeight, setVpHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const bannerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--banner-h")) || 0;
      setVpHeight(vv.height - bannerH);
      window.scrollTo(0, 0);
      // When keyboard opens (viewport shrinks), scroll chat to bottom
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, [isMobile]);

  // Build merged command list for autocomplete, with origin labels and descriptions
  const agentCmds = slashCommands.get(agent.id);
  const { allCommands, skillOrigins, commandDescriptions } = useMemo(() => {
    const cmds: string[] = [];
    const origins = new Map<string, string>(); // name → origin label
    const descs = new Map<string, string>(); // name → description
    const originLabels: Record<string, string> = {
      user: "user skill",
      project: "project skill",
      plugin: "plugin skill",
      isomux: "isomux-bundled skill",
      claude: "claude skill",
    };
    if (agentCmds) {
      for (const c of agentCmds.commands) {
        // Handle both old string format and new { name, description } format
        const name = typeof c === "string" ? c : c.name;
        const desc = typeof c === "string" ? undefined : c.description;
        cmds.push(name);
        if (desc) descs.set(name, desc);
      }
      for (const s of agentCmds.skills) {
        if (!cmds.includes(s.name)) cmds.push(s.name);
        origins.set(s.name, originLabels[s.origin] ?? "skill");
        if (s.description) descs.set(s.name, s.description);
      }
    }
    return { allCommands: cmds.sort(), skillOrigins: origins, commandDescriptions: descs };
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

  // Re-enable auto-scroll when logs are cleared (e.g. /resume, /clear)
  const prevLogsLen = useRef(logs.length);
  useEffect(() => {
    if (logs.length === 0 && prevLogsLen.current > 0) {
      setAutoScroll(true);
    }
    prevLogsLen.current = logs.length;
  }, [logs.length]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      const el = scrollRef.current;
      // Defer scroll until after browser layout so scrollHeight is final.
      // Double-rAF ensures content (images, code blocks, etc.) has been measured.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
    }
  }, [logs, autoScroll, agent.state]);

  // Auto-resize textarea and place cursor at end when draft is restored
  useEffect(() => {
    if (textareaRef.current && input) {
      autoResize(textareaRef.current);
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, []);

  // Ctrl+` to toggle terminal panel
  useEffect(() => {
    function handleTerminalShortcut(e: KeyboardEvent) {
      if (isMobile || !features.terminal) return;
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setTerminalOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleTerminalShortcut);
    return () => window.removeEventListener("keydown", handleTerminalShortcut);
  }, [isMobile, features.terminal]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }

  const isBusy = agent.state === "thinking" || agent.state === "tool_executing";

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

  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  // Tracks the draft text before voice started + all finalized speech segments
  const committedTextRef = useRef("");

  function startListening() {
    if (isListeningRef.current || !SpeechRecognition) return;
    isListeningRef.current = true;
    setIsListening(true);
    committedTextRef.current = inputRef.current;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += t;
        } else {
          interimText += t;
        }
      }
      if (finalText) {
        committedTextRef.current += finalText;
      }
      dispatch({ type: "set_draft", agentId: agent.id, text: committedTextRef.current + interimText });
      requestAnimationFrame(() => { if (textareaRef.current) autoResize(textareaRef.current); });
    };
    recognition.onend = () => { isListeningRef.current = false; setIsListening(false); };
    recognition.onerror = () => { isListeningRef.current = false; setIsListening(false); };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopListening() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }

  // Ctrl+Space push-to-talk
  useEffect(() => {
    if (!SpeechRecognition || !window.isSecureContext) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat) {
        e.preventDefault();
        startListening();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat) {
        stopListening();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      recognitionRef.current?.stop();
    };
  }, []);

  function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        const id = Math.random().toString(36).slice(2, 10);
        setStagedAttachments((prev) => [...prev, {
          id, filename: "", originalName: file.name, mediaType: file.type || "application/octet-stream", size: file.size,
          uploading: false, error: "File too large (max 20MB)",
        }]);
        continue;
      }
      const id = Math.random().toString(36).slice(2, 10);
      setStagedAttachments((prev) => [...prev, {
        id, filename: "", originalName: file.name, mediaType: file.type || "application/octet-stream", size: file.size,
        uploading: true,
      }]);
      const formData = new FormData();
      formData.append("file", file);
      fetch(`/api/upload/${agent.id}`, { method: "POST", body: formData })
        .then((res) => {
          if (!res.ok) throw new Error(`Upload failed (${res.status})`);
          return res.json();
        })
        .then((data: { attachments: Attachment[] }) => {
          const att = data.attachments[0];
          setStagedAttachments((prev) => prev.map((s) =>
            s.id === id ? { ...s, ...att, uploading: false } : s
          ));
        })
        .catch((err) => {
          setStagedAttachments((prev) => prev.map((s) =>
            s.id === id ? { ...s, uploading: false, error: err.message } : s
          ));
        });
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeStaged(id: string) {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDraggingOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDraggingOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDraggingOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      handleFileSelect(dt.files);
    }
    // If no files, let default text paste through
  }

  function handleSend() {
    const text = input.trim();
    if (!text && validAttachments.length === 0) return;
    if (isBusy || hasUploading || editingLogEntryId) return;
    const attachments = validAttachments.length > 0
      ? validAttachments.map(({ id: _id, uploading: _u, error: _e, ...att }) => att as Attachment)
      : undefined;
    send({ type: "send_message", agentId: agent.id, text, username, attachments });
    setInput("");
    setStagedAttachments([]);
    stopListening();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setAutoScroll(true);
  }

  return (
    <div
      style={{
        ...(isMobile ? {
          position: "fixed" as const,
          top: 0,
          left: 0,
          right: 0,
          height: vpHeight != null ? vpHeight : "calc(100dvh - var(--banner-h, 0px))",
          overflow: "hidden",
        } : {
          height: "calc(100vh - var(--banner-h, 0px))",
        }),
        display: "flex",
        flexDirection: "row",
        background: "var(--bg-base)",
        animation: "termEnter 0.3s ease-out",
      }}
    >
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
          flexDirection: "row",
          alignItems: "stretch",
          padding: "0 12px 0 0",
          paddingTop: "env(safe-area-inset-top, 0px)",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-strong)",
          flexShrink: 0,
        }}>
          <button onClick={onBack} style={{
            padding: "12px 14px",
            border: "none",
            borderRight: "1px solid var(--border-medium)",
            background: "var(--btn-surface)",
            color: "var(--text-dim)",
            fontSize: 20, cursor: "pointer", lineHeight: 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>←</button>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", padding: "8px 10px", gap: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusLight state={agent.state} size={8} />
              <span onClick={onEditAgent} style={{
                fontWeight: 600, color: "var(--text-primary)", fontSize: 15,
                cursor: "pointer", flex: 1, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{agent.name}{agent.room > 0 ? <span style={{ opacity: 0.4, fontWeight: 400, fontSize: 12, marginLeft: 6 }}>R{agent.room + 1}:{agent.desk + 1}</span> : ""}</span>
              {STATE_LABELS[agent.state] && (
                <HeaderTimer state={agent.state} stateChangedAt={stateChangedAt.get(agent.id)} />
              )}
              {logs.length > 0 && <CopyButton getText={getConversationText} />}
              <button
                onClick={toggleAvatar}
                title={showAvatar ? "Hide agent avatar" : "Show agent avatar"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "2px 6px",
                  borderRadius: 6,
                  border: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  opacity: showAvatar ? 1 : 0.35,
                  transition: "opacity 0.2s",
                  flexShrink: 0,
                }}
              >
                <PersonIcon />
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 16 }}>
              <span style={{
                fontFamily: "'JetBrains Mono',monospace",
                color: "var(--text-muted)", fontSize: 12,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                flex: 1,
              }}>{agent.cwd}</span>
            </div>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, flex: 1, minWidth: 0, marginLeft: 12 }}>
            <span style={{ flexShrink: 0 }}><StatusLight state={agent.state} size={8} /></span>
            <span
              onClick={onEditAgent}
              style={{ fontWeight: 600, color: "var(--text-primary)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
              title="Edit agent"
            ><span style={{ opacity: 0.5 }}>{agent.room > 0 ? `R${agent.room + 1}:` : ""}{agent.desk + 1} ·</span> {agent.name}</span>
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
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                  title={agent.topic ?? "Click to edit topic"}
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
              {agent.cwd.replace(/^\/home\/[^/]+/, "~")}
            </span>
            <span style={{ color: "var(--text-ghost)" }}>&middot;</span>
            <span
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                color: "var(--text-ghost)",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              {familyDisplayLabel(agent.modelFamily)}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
            {onOpenTasks && (
              <button
                onClick={onOpenTasks}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-dim)",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "'DM Sans',sans-serif",
                }}
              >
                Tasks
              </button>
            )}
            {logs.length > 0 && <CopyButton getText={getConversationText} />}
            <button
              onClick={toggleAvatar}
              title={showAvatar ? "Hide agent avatar" : "Show agent avatar"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid var(--border-medium)",
                background: "var(--btn-surface)",
                color: "var(--text-dim)",
                cursor: "pointer",
                opacity: showAvatar ? 1 : 0.35,
                transition: "opacity 0.2s",
              }}
            >
              <PersonIcon />
            </button>
            {!isMobile && (
              <button
                onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border-medium)",
                  background: "var(--btn-surface)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                }}
              >
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </button>
            )}
            {features.terminal && (
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
                color: terminalOpen ? "var(--green)" : "var(--text-dim)",
                fontFamily: "'DM Sans',sans-serif",
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>&gt;_</span>
            </button>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={messagesRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: isMobile ? "12px 12px" : "16px 24px",
          color: "var(--text-secondary)",
          position: "relative",
        }}
      >
        {/* Floating agent portrait */}
        <div
          onClick={onEditAgent}
          style={{
            position: "sticky",
            top: isMobile ? 12 : 16,
            float: "right",
            marginRight: 0,
            zIndex: 10,
            width: 62,
            height: 78,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            border: `2px solid ${MODEL_TINT[agent.modelFamily]?.border ?? "var(--border-medium)"}`,
            background: MODEL_TINT[agent.modelFamily]?.bg ?? "rgba(128,128,128,0.2)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            cursor: "pointer",
            opacity: showAvatar ? 1 : 0,
            pointerEvents: showAvatar ? "auto" : "none",
            transition: "opacity 0.2s",
          }}
          title="Edit agent"
        >
          <Character key={agent.state} state={agent.state} outfit={agent.outfit} />
        </div>
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
          const canEditMsg = entry.kind === "user_message" && agent.state === "waiting_for_response" && !editingLogEntryId;
          return (
            <LogEntryCard
              key={entry.id}
              entry={entry}
              isLastInTurn={td?.isLastInTurn}
              turnEntries={td?.turnEntries}
              isMobile={isMobile}
              canEdit={canEditMsg}
              isEditing={editingLogEntryId === entry.id}
              onStartEdit={(id) => setEditingLogEntryId(id)}
              onCancelEdit={() => setEditingLogEntryId(null)}
              onSubmitEdit={(id, newText) => {
                setEditingLogEntryId(null);
                send({ type: "edit_message", agentId: agent.id, logEntryId: id, newText, username });
              }}
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
          flexShrink: 0,
          padding: isMobile ? "10px 12px 10px 11px" : "10px 24px 10px 11px",
          paddingBottom: isMobile ? "calc(10px + env(safe-area-inset-bottom, 0px))" : undefined,
          borderTop: draggingOver ? "2px solid var(--green)" : "2px solid var(--border-strong)",
          background: draggingOver ? "var(--bg-hover)" : "var(--bg-surface)",
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleFileSelect(e.target.files)}
        />
        {stagedAttachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {stagedAttachments.map((att) => (
              <div
                key={att.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: att.error ? "var(--red-bg)" : "var(--bg-hover)",
                  border: `1px solid ${att.error ? "var(--red)" : "var(--border)"}`,
                  fontSize: isMobile ? 13 : 11,
                  fontFamily: "'JetBrains Mono',monospace",
                  color: att.error ? "var(--red)" : "var(--text-secondary)",
                  maxWidth: "100%",
                }}
              >
                {att.mediaType.startsWith("image/") ? "🖼️" : att.mediaType === "application/pdf" ? "📄" : "📎"}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{att.originalName}</span>
                {att.uploading && <span style={{ color: "var(--text-ghost)" }}>uploading…</span>}
                {att.error && <span style={{ fontSize: isMobile ? 11 : 9 }}>{att.error}</span>}
                <button
                  onClick={() => removeStaged(att.id)}
                  style={{
                    background: "none", border: "none", color: att.error ? "var(--red)" : "var(--text-ghost)",
                    cursor: "pointer", padding: "0 2px", fontSize: 14, lineHeight: 1, flexShrink: 0,
                  }}
                >×</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            style={{
              background: "none", border: "none", padding: 0,
              color: isBusy ? "var(--text-ghost)" : "var(--text-muted)",
              cursor: isBusy ? "default" : "pointer",
              lineHeight: "20px",
              fontSize: 16, flexShrink: 0,
              opacity: isBusy ? 0.4 : 0.7,
              transition: "opacity 0.15s",
            }}
            title="Attach files"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <span style={{ color: isBusy ? "var(--text-ghost)" : "var(--green)", fontWeight: 600, lineHeight: "20px", position: "relative", top: -2 }}>&#10095;</span>
          <div style={{ flex: 1, position: "relative", top: -2 }}>
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
                  const originLabel = skillOrigins.get(cmd);
                  const desc = commandDescriptions.get(cmd);
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
                        flexShrink: 0,
                      }}>
                        /{cmd}
                      </span>
                      {originLabel && (
                        <span style={{
                          fontSize: 10,
                          color: "var(--text-ghost)",
                          fontFamily: "'DM Sans',sans-serif",
                          background: "var(--bg-base)",
                          padding: "1px 6px",
                          borderRadius: 4,
                          flexShrink: 0,
                        }}>
                          {originLabel}
                        </span>
                      )}
                      {desc && (
                        <span style={{
                          fontSize: 11,
                          color: "var(--text-ghost)",
                          fontFamily: "'DM Sans',sans-serif",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {desc}
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
              onPaste={handlePaste}
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
              placeholder={editingLogEntryId ? "Editing message above..." : isBusy ? (isMobile ? "Agent is busy..." : "Agent is busy — Ctrl+C to interrupt...") : isMobile ? "Type a message..." : "Type a message or / for commands..."}
              autoFocus={!isMobile}
              rows={1}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                outline: "none",
                color: (isBusy || editingLogEntryId) ? "var(--text-muted)" : "var(--text-secondary)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: isMobile ? 16 : 13,
                caretColor: "var(--green)",
                resize: "none",
                padding: "0 0 4px",
                lineHeight: "20px",
                maxHeight: 200,
                overflowY: "auto",
              }}
            />
          </div>
          {SpeechRecognition && window.isSecureContext ? (
            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onMouseLeave={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
              style={{
                flexShrink: 0,
                width: 36,
                height: 36,
                marginTop: -9,
                borderRadius: 6,
                border: isListening ? "1px solid var(--red)" : "1px solid var(--border)",
                background: isListening ? "rgba(255,50,50,0.15)" : "transparent",
                color: isListening ? "var(--red)" : "var(--text-muted)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                transition: "all 0.15s",
                animation: isListening ? "mic-pulse 1.5s ease-in-out infinite" : "none",
                userSelect: "none",
                WebkitUserSelect: "none",
              }}
              title="Hold to talk (Ctrl+Space)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="1" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="17" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
          ) : SpeechRecognition && !window.isSecureContext ? (
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                onClick={() => setShowMicHint((v) => !v)}
                style={{
                  width: 36,
                  height: 36,
                  marginTop: -9,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  opacity: 0.4,
                }}
                title="Voice input requires HTTPS"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="1" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="17" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              {showMicHint && (
                <div style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  right: 0,
                  width: 320,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-medium)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  fontSize: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  color: "var(--text-secondary)",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                  zIndex: 20,
                  animation: "fadeIn 0.1s ease-out",
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--text-primary)" }}>
                    Voice input requires HTTPS
                  </div>
                  <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
                    Enable HTTPS in your <span style={{ color: "var(--text-primary)" }}>Tailscale admin console</span> (DNS page), then run these on the host (use the built-in terminal):
                  </div>
                  <code style={{
                    display: "block",
                    background: "var(--bg-base)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: "8px 10px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono',monospace",
                    color: "var(--text-secondary)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    lineHeight: 1.6,
                  }}>
                    {`sudo tailscale set --operator=$USER\ntailscale serve --bg http://localhost:4000`}
                  </code>
                  <div style={{ marginTop: 8, lineHeight: 1.5, color: "var(--text-muted)" }}>
                    Restart isomux and reload this page. You'll be auto-redirected to HTTPS.
                  </div>
                  <button
                    onClick={() => setShowMicHint(false)}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 10,
                      background: "none",
                      border: "none",
                      color: "var(--text-ghost)",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: 0,
                    }}
                  >
                    &times;
                  </button>
                </div>
              )}
            </div>
          ) : null}
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
                disabled={(!input.trim() && validAttachments.length === 0) || hasUploading || !!editingLogEntryId}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: "none",
                  background: (input.trim() || validAttachments.length > 0) && !hasUploading && !editingLogEntryId ? "var(--green)" : "var(--bg-hover)",
                  color: (input.trim() || validAttachments.length > 0) && !hasUploading && !editingLogEntryId ? "var(--bg-base)" : "var(--text-ghost)",
                  fontSize: 16,
                  cursor: (input.trim() || validAttachments.length > 0) && !hasUploading && !editingLogEntryId ? "pointer" : "default",
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
    {features.terminal && !isMobile && terminalOpen && (
      <div style={{ width: "40%", minWidth: 300, maxWidth: 600, flexShrink: 0 }}>
        <TerminalPanel agentId={agent.id} onClose={() => setTerminalOpen(false)} />
      </div>
    )}
    </div>
  );
}
