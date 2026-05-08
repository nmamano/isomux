import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { oneDark } from "@codemirror/theme-one-dark";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import { useTheme } from "../store.tsx";
import type { ServerMessage } from "../../shared/types.ts";
import { getEditorState, setEditorState, type PersistedTab } from "./editor-state.ts";

interface Tab {
  path: string;
  content: string;
  mtime: number;
  language: string;
  size: number;
  dirty: boolean;
  // Save banner state. "stale": disk newer than expectedMtime; user must
  // pick Overwrite or Reload. "external": file changed under us while we
  // hold a clean buffer (auto-reloaded already → null) or a dirty buffer
  // (banner: "Reload? lose edits").
  banner: null | { kind: "stale"; currentMtime: number } | { kind: "external"; mtime: number } | { kind: "save_error"; message: string };
}

const TABS_KEY = (agentId: string) => `isomux:editor:tabs:${agentId}`;

function readTabs(agentId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(TABS_KEY(agentId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is string => typeof p === "string");
  } catch { return []; }
}

function writeTabs(agentId: string, paths: string[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TABS_KEY(agentId), JSON.stringify(paths.slice(0, 20)));
  } catch {}
}

function languageExtension(language: string) {
  switch (language) {
    case "javascript": return [javascript({ jsx: true, typescript: true })];
    case "json": return [json()];
    case "markdown": return [markdown()];
    case "css": return [css()];
    case "html": return [html()];
    case "python": return [python()];
    case "rust": return [rust()];
    case "go": return [go()];
    default: return [];
  }
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function EditorPanel({
  agentId,
  initialPath,
  onClose,
  onPathOpened,
}: {
  agentId: string;
  initialPath: string | null;
  onClose: () => void;
  onPathOpened?: (path: string) => void;
}) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef<Compartment>(new Compartment());
  const themeCompartmentRef = useRef<Compartment>(new Compartment());
  const readonlyCompartmentRef = useRef<Compartment>(new Compartment());

  // Restore from the module-level store on mount so tabs and dirty buffers
  // survive LogView remount on agent switch. (LogView is keyed by agent id
  // in App.tsx, which fully unmounts the column on each switch — local
  // useState would lose the buffer.) Banner state is volatile, never
  // restored, so the user doesn't see a stale "stale-save" prompt that was
  // resolved before they navigated away.
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const persisted = getEditorState(agentId);
    if (!persisted) return [];
    return persisted.tabs.map((t) => ({
      path: t.path, content: t.content, mtime: t.mtime,
      language: t.language, size: t.size, dirty: t.dirty, banner: null,
    }));
  });
  const [activePath, setActivePath] = useState<string | null>(() => {
    return getEditorState(agentId)?.activePath ?? null;
  });
  const [pendingError, setPendingError] = useState<string | null>(null);

  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;
  // Tracks the language currently installed in the lang compartment so the
  // sync effect only reconfigures when the buffer's language actually changes.
  const installedLangRef = useRef<string | null>(null);

  const setTabsAndPersist = useCallback((updater: (prev: Tab[]) => Tab[]) => {
    setTabs((prev) => {
      const next = updater(prev);
      writeTabs(agentId, next.map((t) => t.path));
      return next;
    });
  }, [agentId]);

  // Mirror tabs + active path into the module store on every change so an
  // agent switch round-trip can restore them. Banner state is dropped on
  // purpose (see comment on the useState initializer).
  useEffect(() => {
    const snapshot: PersistedTab[] = tabs.map((t) => ({
      path: t.path, content: t.content, mtime: t.mtime,
      language: t.language, size: t.size, dirty: t.dirty,
    }));
    setEditorState(agentId, { tabs: snapshot, activePath });
  }, [agentId, tabs, activePath]);

  // Open a file by sending editor_open and waiting for editor_content.
  const openPath = useCallback((path: string) => {
    setPendingError(null);
    send({ type: "editor_open", agentId, path });
  }, [agentId]);

  // First mount: figure out where to load from.
  //   1. Module store (set by a previous mount of this agent's editor) wins
  //      because it preserves dirty buffers. We still send editor_open for
  //      each restored path so the server reinstalls fs.watch — the
  //      editor_content handler is careful to keep the dirty buffer.
  //   2. Else, if the parent passed an initialPath, the [initialPath] effect
  //      below handles it.
  //   3. Else, fall back to localStorage paths from a prior session and open
  //      them fresh from disk.
  useEffect(() => {
    const persisted = getEditorState(agentId);
    if (persisted && persisted.tabs.length > 0) {
      for (const t of persisted.tabs) openPath(t.path);
      return;
    }
    if (initialPath) return;
    const stored = readTabs(agentId);
    for (const p of stored) openPath(p);
    if (stored.length > 0) setActivePath(stored[stored.length - 1] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever a new initialPath arrives — first mount with one, or the parent
  // sets a new path because the boss clicked another EditRequestCard —
  // either focus the existing tab or open the file. Activate it optimistically
  // so it becomes the active tab even when other tabs were restored from the
  // module store with a different activePath set already.
  useEffect(() => {
    if (!initialPath) return;
    setActivePath(initialPath);
    const existing = tabsRef.current.find((t) => t.path === initialPath);
    if (!existing) openPath(initialPath);
    onPathOpened?.(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // Wire raw WebSocket listener for editor_* messages addressed to this agent.
  useEffect(() => {
    const handler = (data: string) => {
      let msg: ServerMessage | null = null;
      try { msg = JSON.parse(data) as ServerMessage; } catch { return; }
      if (!msg) return;
      if (msg.type === "editor_content" && msg.agentId === agentId) {
        const m = msg;
        setTabsAndPersist((prev) => {
          const idx = prev.findIndex((t) => t.path === m.path);
          if (idx >= 0) {
            const existing = prev[idx]!;
            const next = prev.slice();
            if (existing.dirty) {
              // Preserve the dirty buffer — this happens after agent-switch
              // re-mounts when we re-fetch on disk to reinstall fs.watch.
              // Refresh only the metadata fields the server is authoritative for.
              next[idx] = {
                ...existing,
                mtime: m.mtime,
                language: m.language,
                size: m.size,
              };
            } else {
              next[idx] = {
                path: m.path, content: m.content, mtime: m.mtime,
                language: m.language, size: m.size, dirty: false, banner: null,
              };
            }
            return next;
          }
          return [...prev, {
            path: m.path, content: m.content, mtime: m.mtime,
            language: m.language, size: m.size, dirty: false, banner: null,
          }];
        });
        setActivePath((prev) => prev ?? m.path);
      } else if (msg.type === "editor_open_error" && msg.agentId === agentId) {
        const m = msg;
        const reason = m.reason === "not_found" ? "not found" :
          m.reason === "not_file" ? "not a file" :
          m.reason === "binary" ? "binary file (text only)" :
          m.reason === "too_large" ? `too large (${m.size ? (m.size / 1024).toFixed(1) + " KB" : ""}, 1 MB limit)` :
          m.reason === "io_error" ? `error: ${m.message ?? "unknown"}` :
          "bad path";
        setPendingError(`${m.path}: ${reason}`);
      } else if (msg.type === "editor_save_response" && msg.agentId === agentId) {
        const m = msg;
        setTabsAndPersist((prev) => prev.map((t) => {
          if (t.path !== m.path) return t;
          if (m.ok) {
            return { ...t, mtime: m.mtime ?? t.mtime, dirty: false, banner: null };
          }
          if (m.reason === "stale" && m.currentMtime !== undefined) {
            return { ...t, banner: { kind: "stale", currentMtime: m.currentMtime } };
          }
          return { ...t, banner: { kind: "save_error", message: m.error ?? "save failed" } };
        }));
      } else if (msg.type === "editor_external_change" && msg.agentId === agentId) {
        const m = msg;
        // Decide outside the state updater so React strict-mode's double
        // invocation doesn't fire two `editor_open` round-trips.
        const existing = tabsRef.current.find((t) => t.path === m.path);
        if (!existing) return;
        if (existing.dirty) {
          setTabsAndPersist((prev) => prev.map((t) =>
            t.path === m.path ? { ...t, banner: { kind: "external", mtime: m.mtime } } : t
          ));
        } else {
          // Clean buffer → silently re-fetch by triggering an open.
          send({ type: "editor_open", agentId, path: m.path });
        }
      }
    };
    addRawListener(handler);
    return () => removeRawListener(handler);
  }, [agentId, setTabsAndPersist]);

  // Release server-side fs.watch handles when the panel unmounts (LogView
  // reset, agent switch, etc.). Without this, watchers persist on the WS
  // until disconnect — a slow inotify-slot leak for long-lived browser tabs.
  // X-button per-tab close already sends editor_close; this is the catch-all
  // for unmount paths the user didn't explicitly trigger.
  useEffect(() => {
    return () => {
      for (const t of tabsRef.current) {
        send({ type: "editor_close", agentId, path: t.path });
      }
    };
  }, [agentId]);

  // Initialize the CodeMirror EditorView once. We swap content in and out
  // via dispatch when the active tab changes — no remount.
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const path = activePathRef.current;
      if (!path) return;
      const text = update.state.doc.toString();
      setTabsAndPersist((prev) => prev.map((t) => {
        if (t.path !== path) return t;
        if (t.content === text) return t;
        return { ...t, content: text, dirty: true };
      }));
    });

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          highlightSelectionMatches(),
          autocompletion(),
          closeBrackets(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          langCompartmentRef.current.of([]),
          themeCompartmentRef.current.of(theme === "dark" ? oneDark : syntaxHighlighting(defaultHighlightStyle)),
          readonlyCompartmentRef.current.of([]),
          updateListener,
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When theme toggles, swap the theme compartment without rebuilding state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(theme === "dark" ? oneDark : syntaxHighlighting(defaultHighlightStyle)),
    });
  }, [theme]);

  // Sync the editor view whenever the active tab's content or language
  // changes — covers tab switches, content arrival from server, and external
  // reloads. Doc updates check equality first to avoid feedback with the
  // updateListener that flips `dirty`. Language only reconfigures when it
  // actually differs (CodeMirror compartments are cheap but not free).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!activePath) {
      if (view.state.doc.length > 0) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
      }
      if (installedLangRef.current !== null) {
        view.dispatch({ effects: langCompartmentRef.current.reconfigure([]) });
        installedLangRef.current = null;
      }
      return;
    }
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab) return;
    const current = view.state.doc.toString();
    if (current !== tab.content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: tab.content } });
    }
    if (installedLangRef.current !== tab.language) {
      view.dispatch({ effects: langCompartmentRef.current.reconfigure(languageExtension(tab.language)) });
      installedLangRef.current = tab.language;
    }
  }, [tabs, activePath]);

  // Save with Ctrl+S / Cmd+S — must capture to suppress browser save dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "s" || (!e.ctrlKey && !e.metaKey)) return;
      // Only intercept when an editor is actively focused, otherwise let other shortcuts win.
      const view = viewRef.current;
      if (!view) return;
      if (!view.dom.contains(document.activeElement)) return;
      e.preventDefault();
      const path = activePathRef.current;
      if (!path) return;
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return;
      send({ type: "editor_save", agentId, path, content: tab.content, expectedMtime: tab.mtime });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [agentId]);

  const closeTab = useCallback((path: string) => {
    send({ type: "editor_close", agentId, path });
    setTabsAndPersist((prev) => prev.filter((t) => t.path !== path));
    setActivePath((prev) => {
      if (prev !== path) return prev;
      const remaining = tabsRef.current.filter((t) => t.path !== path);
      return remaining.length > 0 ? remaining[remaining.length - 1]!.path : null;
    });
  }, [agentId, setTabsAndPersist]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );

  const overwrite = useCallback(() => {
    if (!activeTab) return;
    // Force-save: bypass mtime check.
    send({
      type: "editor_save", agentId, path: activeTab.path,
      content: activeTab.content, expectedMtime: activeTab.mtime, force: true,
    });
  }, [activeTab, agentId]);

  const reloadFromDisk = useCallback(() => {
    if (!activeTab) return;
    send({ type: "editor_open", agentId, path: activeTab.path });
  }, [activeTab, agentId]);

  const dismissBanner = useCallback(() => {
    if (!activeTab) return;
    setTabsAndPersist((prev) => prev.map((t) =>
      t.path === activeTab.path ? { ...t, banner: null } : t
    ));
  }, [activeTab, setTabsAndPersist]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderLeft: "1px solid var(--border-strong)",
        background: "var(--bg-base)",
        position: "relative",
      }}
    >
      {/* Header: tabs + close */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          borderBottom: "1px solid var(--border-strong)",
          background: "var(--bg-surface)",
          flexShrink: 0,
          minHeight: 36,
          overflowX: "auto",
        }}
      >
        <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
          {tabs.length === 0 && (
            <div style={{
              fontSize: 11,
              color: "var(--text-dim)",
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
            }}>
              No file open. Use <code style={{ margin: "0 4px", color: "var(--text-secondary)" }}>/isomux-edit &lt;path&gt;</code> or have the agent send one.
            </div>
          )}
          {tabs.map((t) => (
            <div
              key={t.path}
              onClick={() => setActivePath(t.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 8px 0 12px",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11,
                color: t.path === activePath ? "var(--text-secondary)" : "var(--text-muted)",
                background: t.path === activePath ? "var(--bg-base)" : "transparent",
                borderRight: "1px solid var(--border)",
                cursor: "pointer",
                flexShrink: 0,
                maxWidth: 200,
                position: "relative",
                ...(t.path === activePath ? { borderTop: "2px solid var(--green)" } : {}),
              }}
              title={t.path}
            >
              <span style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {basename(t.path)}{t.dirty ? "*" : ""}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-ghost)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 2px",
                  lineHeight: 1,
                }}
                title="Close tab"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 16,
            padding: "0 12px",
            lineHeight: 1,
            flexShrink: 0,
          }}
          title="Close editor"
        >
          &times;
        </button>
      </div>

      {/* Banner row (per active tab) */}
      {activeTab?.banner && (
        <div style={{
          padding: "6px 12px",
          background: activeTab.banner.kind === "save_error" ? "var(--red-bg)" : "var(--orange-bg)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: activeTab.banner.kind === "save_error" ? "var(--red)" : "var(--orange)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}>
          {activeTab.banner.kind === "stale" && (
            <>
              <span style={{ flex: 1 }}>File changed on disk since you opened it.</span>
              <button onClick={overwrite} style={bannerBtn("var(--orange)")}>Overwrite</button>
              <button onClick={reloadFromDisk} style={bannerBtn("var(--text-secondary)")}>Reload</button>
            </>
          )}
          {activeTab.banner.kind === "external" && (
            <>
              <span style={{ flex: 1 }}>File changed externally — your edits will be lost if you reload.</span>
              <button onClick={reloadFromDisk} style={bannerBtn("var(--orange)")}>Reload</button>
              <button onClick={dismissBanner} style={bannerBtn("var(--text-secondary)")}>Dismiss</button>
            </>
          )}
          {activeTab.banner.kind === "save_error" && (
            <>
              <span style={{ flex: 1 }}>Save failed: {activeTab.banner.message}</span>
              <button onClick={dismissBanner} style={bannerBtn("var(--red)")}>Dismiss</button>
            </>
          )}
        </div>
      )}

      {pendingError && (
        <div style={{
          padding: "6px 12px",
          background: "var(--red-bg)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--red)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ flex: 1 }}>{pendingError}</span>
          <button onClick={() => setPendingError(null)} style={bannerBtn("var(--red)")}>Dismiss</button>
        </div>
      )}

      {/* Editor body */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: "auto",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      />

      {/* Footer status */}
      {activeTab && (
        <div style={{
          padding: "4px 12px",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          gap: 12,
          fontFamily: "'JetBrains Mono', monospace",
          flexShrink: 0,
        }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeTab.path}</span>
          <span>{activeTab.language}</span>
          <span>{activeTab.dirty ? "modified" : "saved"}</span>
          <span title="Ctrl+S to save">{(navigator.platform || "").includes("Mac") ? "⌘S" : "Ctrl+S"}</span>
        </div>
      )}
    </div>
  );
}

function bannerBtn(color: string): React.CSSProperties {
  return {
    padding: "2px 10px",
    borderRadius: 4,
    border: `1px solid ${color}`,
    background: "transparent",
    color,
    fontSize: 11,
    fontFamily: "'JetBrains Mono',monospace",
    cursor: "pointer",
  };
}
