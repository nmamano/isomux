import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import { useTheme } from "../store.tsx";
import type { ServerMessage } from "../../shared/types.ts";

const DARK_THEME = {
  background: "#0a0e16",
  foreground: "#c0c8d8",
  cursor: "#50B86C",
  cursorAccent: "#0a0e16",
  selectionBackground: "rgba(126,184,255,0.2)",
  black: "#1a2030",
  red: "#E85D75",
  green: "#50B86C",
  yellow: "#F5A623",
  blue: "#7eb8ff",
  magenta: "#9B6DFF",
  cyan: "#56d4dd",
  white: "#c0c8d8",
  brightBlack: "#5a6f8f",
  brightRed: "#ff7b92",
  brightGreen: "#6fd88a",
  brightYellow: "#ffc44d",
  brightBlue: "#a0d0ff",
  brightMagenta: "#b98eff",
  brightCyan: "#7eeef5",
  brightWhite: "#e0e8f5",
};

const LIGHT_THEME = {
  background: "#f0f2f6",
  foreground: "#3a4a60",
  cursor: "#16a34a",
  cursorAccent: "#f0f2f6",
  selectionBackground: "rgba(59,130,246,0.2)",
  black: "#1a2030",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#d97706",
  blue: "#3b82f6",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#3a4a60",
  brightBlack: "#7a8a9a",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#60a5fa",
  brightMagenta: "#a78bfa",
  brightCyan: "#22d3ee",
  brightWhite: "#1a2030",
};

export function TerminalPanel({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { theme } = useTheme();
  const [exited, setExited] = useState<number | null>(null);

  // Handle server messages for this terminal
  const handleRawMessage = useCallback(
    (data: string) => {
      try {
        const msg = JSON.parse(data) as ServerMessage;
        if (msg.type === "terminal_output" && msg.agentId === agentId) {
          termRef.current?.write(msg.data);
        } else if (msg.type === "terminal_exit" && msg.agentId === agentId) {
          setExited(msg.exitCode);
        }
      } catch {}
    },
    [agentId]
  );

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit and focus after open (needs a frame to measure)
    requestAnimationFrame(() => {
      fitAddon.fit();
      term.focus();
      // Tell server the initial size
      send({
        type: "terminal_resize",
        agentId,
        cols: term.cols,
        rows: term.rows,
      });
    });

    term.onData((data) => {
      send({ type: "terminal_input", agentId, data });
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // Listen for terminal messages via raw WebSocket listener
    // (survives reconnects, avoids unnecessary React re-renders)
    addRawListener(handleRawMessage);

    // Open the PTY on the server
    send({ type: "terminal_open", agentId });

    // Resize observer
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      send({
        type: "terminal_resize",
        agentId,
        cols: term.cols,
        rows: term.rows,
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      removeRawListener(handleRawMessage);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update theme without re-creating terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  function handleRespawn() {
    setExited(null);
    termRef.current?.clear();
    // Close old PTY (if still around) and open a new one
    send({ type: "terminal_close", agentId });
    setTimeout(() => send({ type: "terminal_open", agentId }), 100);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderLeft: "1px solid var(--border-strong)",
        background: theme === "dark" ? "#0a0e16" : "#f0f2f6",
        position: "relative",
      }}
    >
      {/* Terminal header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          height: 36,
          borderBottom: "1px solid var(--border-strong)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "'DM Sans',sans-serif",
            color: "var(--text-dim)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--green)", fontSize: 13 }}>&#9654;</span>
          Terminal
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            padding: "0 4px",
            lineHeight: 1,
          }}
          title="Close terminal"
        >
          &times;
        </button>
      </div>

      {/* Terminal body */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          padding: 4,
          overflow: "hidden",
        }}
      />

      {/* Exit overlay */}
      {exited !== null && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-medium)",
            borderRadius: 8,
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 12,
            fontFamily: "'DM Sans',sans-serif",
            color: "var(--text-dim)",
            boxShadow: "0 4px 12px var(--shadow)",
          }}
        >
          <span>Shell exited ({exited})</span>
          <button
            onClick={handleRespawn}
            style={{
              padding: "3px 12px",
              borderRadius: 6,
              border: "1px solid var(--green-border)",
              background: "var(--green-bg)",
              color: "var(--green)",
              fontSize: 12,
              fontFamily: "'DM Sans',sans-serif",
              cursor: "pointer",
            }}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
