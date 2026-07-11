import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { oneDark } from "@codemirror/theme-one-dark";
import { addRawListener, removeRawListener } from "../ws.ts";
import { useAppState, useTheme } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { ServerMessage } from "../../shared/types.ts";
import {
  getEditorState,
  setEditorState,
  type PersistedTab,
} from "./editor-state.ts";

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
  banner:
    | null
    | { kind: "stale"; currentMtime: number }
    | { kind: "external"; mtime: number }
    | { kind: "save_error"; message: string };
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
  } catch {
    return [];
  }
}

function writeTabs(agentId: string, paths: string[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TABS_KEY(agentId), JSON.stringify(paths.slice(0, 20)));
  } catch {}
}

function languageExtension(language: string) {
  switch (language) {
    case "javascript":
      return [javascript({ jsx: true, typescript: true })];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "css":
      return [css()];
    case "html":
      return [html()];
    case "python":
      return [python()];
    case "rust":
      return [rust()];
    case "go":
      return [go()];
    default:
      return [];
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
  mobile = false,
}: {
  agentId: string;
  initialPath: string | null;
  onClose: () => void;
  onPathOpened?: (path: string) => void;
  // When true, renders mobile-friendly chrome: a tab dropdown instead of an
  // overflowing tab strip, an explicit Save button (mobile has no Ctrl+S),
  // a hidden line-number gutter, no autocomplete popup, and contentAttributes
  // that disable iOS autocorrect/autocapitalize on the editable surface.
  mobile?: boolean;
}) {
  const { mode } = useTheme();
  const { sessionContext } = useAppState();
  // This tab's connectionId binds the editor file-watch to THIS socket: the GET
  // (open) and DELETE (close) carry it as X-Isomux-Connection-Id and
  // editor_external_change pushes back over it. Empty only before the first
  // session_context arrives — the editor isn't reachable that early.
  const connectionId = sessionContext?.connectionId ?? "";
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
      path: t.path,
      content: t.content,
      mtime: t.mtime,
      language: t.language,
      size: t.size,
      dirty: t.dirty,
      banner: null,
    }));
  });
  const [activePath, setActivePath] = useState<string | null>(() => {
    return getEditorState(agentId)?.activePath ?? null;
  });
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuButtonRef = useRef<HTMLButtonElement>(null);

  const tabsRef = useRef<Tab[]>([]);
  const activePathRef = useRef<string | null>(null);
  /* eslint-disable react-hooks/refs */
  tabsRef.current = tabs;
  activePathRef.current = activePath;
  /* eslint-enable react-hooks/refs */
  // Tracks the language currently installed in the lang compartment so the
  // sync effect only reconfigures when the buffer's language actually changes.
  const installedLangRef = useRef<string | null>(null);

  const setTabsAndPersist = useCallback(
    (updater: (prev: Tab[]) => Tab[]) => {
      setTabs((prev) => {
        const next = updater(prev);
        writeTabs(
          agentId,
          next.map((t) => t.path),
        );
        return next;
      });
    },
    [agentId],
  );

  // Mirror tabs + active path into the module store on every change so an
  // agent switch round-trip can restore them. Banner state is dropped on
  // purpose (see comment on the useState initializer).
  useEffect(() => {
    const snapshot: PersistedTab[] = tabs.map((t) => ({
      path: t.path,
      content: t.content,
      mtime: t.mtime,
      language: t.language,
      size: t.size,
      dirty: t.dirty,
    }));
    setEditorState(agentId, { tabs: snapshot, activePath });
  }, [agentId, tabs, activePath]);

  // Open (or reload) a file: GET its content, (re)arm the watch on the resolved
  // path, and merge it into the tab list — keyed by the RESOLVED path the server
  // returns (so it matches editor_external_change). Replaces the editor_open WS
  // command + the editor_content / editor_open_error events (now .then / .catch).
  const openPath = useCallback(
    (path: string) => {
      setPendingError(null);
      apiFetch<{
        path: string;
        content: string;
        mtime: number;
        language: string;
        size: number;
      }>(
        "GET",
        `/api/agents/${agentId}/file?path=${encodeURIComponent(path)}`,
        undefined,
        { headers: { "X-Isomux-Connection-Id": connectionId } },
      )
        .then((m) => {
          setTabsAndPersist((prev) => {
            const idx = prev.findIndex((t) => t.path === m.path);
            if (idx >= 0) {
              const existing = prev[idx];
              const next = prev.slice();
              if (existing.dirty) {
                // Preserve the dirty buffer — this happens after agent-switch
                // re-mounts when we re-fetch to reinstall the watch. Refresh only
                // the metadata fields the server is authoritative for.
                next[idx] = {
                  ...existing,
                  mtime: m.mtime,
                  language: m.language,
                  size: m.size,
                };
              } else {
                next[idx] = {
                  path: m.path,
                  content: m.content,
                  mtime: m.mtime,
                  language: m.language,
                  size: m.size,
                  dirty: false,
                  banner: null,
                };
              }
              return next;
            }
            return [
              ...prev,
              {
                path: m.path,
                content: m.content,
                mtime: m.mtime,
                language: m.language,
                size: m.size,
                dirty: false,
                banner: null,
              },
            ];
          });
          setActivePath((prev) => prev ?? m.path);
        })
        .catch((err) => {
          // The server formats the open-error message per reason (not found / not
          // a file / binary / too large / bad path / io), so just surface it.
          setPendingError(
            `${path}: ${err instanceof ApiError ? err.message : "failed to open"}`,
          );
        });
    },
    [agentId, connectionId, setTabsAndPersist],
  );

  // Disarm a file watch (DELETE) — used on tab close + panel unmount. The
  // connection header binds the unwatch to THIS socket. Fire-and-forget.
  const closeWatch = useCallback(
    (path: string) => {
      apiFetch(
        "DELETE",
        `/api/agents/${agentId}/file/watch?path=${encodeURIComponent(path)}`,
        undefined,
        { headers: { "X-Isomux-Connection-Id": connectionId } },
      ).catch(() => {});
    },
    [agentId, connectionId],
  );

  // Save (PUT) a tab. Replaces editor_save + the editor_save_response event:
  // .then applies the new mtime / clears dirty; .catch maps the 409 stale
  // conflict (currentMtime rides ApiError.detail) to the stale banner, else a
  // save_error banner.
  const saveTab = useCallback(
    (path: string, content: string, expectedMtime: number, force: boolean) => {
      apiFetch<{ ok: true; mtime: number }>(
        "PUT",
        `/api/agents/${agentId}/file`,
        {
          path,
          content,
          expectedMtime,
          force,
        },
      )
        .then((m) => {
          setTabsAndPersist((prev) =>
            prev.map((t) =>
              t.path === path
                ? { ...t, mtime: m.mtime, dirty: false, banner: null }
                : t,
            ),
          );
        })
        .catch((err) => {
          setTabsAndPersist((prev) =>
            prev.map((t) => {
              if (t.path !== path) return t;
              if (err instanceof ApiError && err.code === "stale") {
                const currentMtime =
                  typeof err.detail?.currentMtime === "number"
                    ? err.detail.currentMtime
                    : t.mtime;
                return { ...t, banner: { kind: "stale", currentMtime } };
              }
              return {
                ...t,
                banner: {
                  kind: "save_error",
                  message:
                    err instanceof ApiError ? err.message : "save failed",
                },
              };
            }),
          );
        });
    },
    [agentId, setTabsAndPersist],
  );

  // First mount: figure out where to load from.
  //   1. Module store (set by a previous mount of this agent's editor) wins
  //      because it preserves dirty buffers. We still re-open each restored path
  //      (the GET) so the server reinstalls the watch — openPath is careful to
  //      keep the dirty buffer.
  //   2. Else, if the parent passed an initialPath, the [initialPath] effect
  //      below handles it.
  //   3. Else, fall back to localStorage paths from a prior session and open
  //      them fresh from disk.
  useEffect(() => {
    const persisted = getEditorState(agentId);
    if (persisted && persisted.tabs.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivePath(initialPath);
    const existing = tabsRef.current.find((t) => t.path === initialPath);
    if (!existing) openPath(initialPath);
    onPathOpened?.(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // Wire a raw WebSocket listener for editor_external_change — the one editor
  // event that stays on the WS (the file-watch push). open/save are now apiFetch
  // (.then/.catch), so editor_content / editor_open_error / editor_save_response
  // are retired and no longer handled here.
  useEffect(() => {
    const handler = (data: string) => {
      let msg: ServerMessage | null = null;
      try {
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "editor_external_change" && msg.agentId === agentId) {
        const m = msg;
        // Decide outside the state updater so React strict-mode's double
        // invocation doesn't fire two open round-trips.
        const existing = tabsRef.current.find((t) => t.path === m.path);
        if (!existing) return;
        if (existing.dirty) {
          setTabsAndPersist((prev) =>
            prev.map((t) =>
              t.path === m.path
                ? { ...t, banner: { kind: "external", mtime: m.mtime } }
                : t,
            ),
          );
        } else {
          // Clean buffer → silently re-fetch by re-opening.
          openPath(m.path);
        }
      }
    };
    addRawListener(handler);
    return () => removeRawListener(handler);
  }, [agentId, setTabsAndPersist, openPath]);

  // Release server-side fs.watch handles when the panel unmounts (LogView
  // reset, agent switch, etc.). Without this, watchers persist on the WS
  // until disconnect — a slow inotify-slot leak for long-lived browser tabs.
  // X-button per-tab close already sends editor_close; this is the catch-all
  // for unmount paths the user didn't explicitly trigger.
  useEffect(() => {
    return () => {
      for (const t of tabsRef.current) {
        closeWatch(t.path);
      }
    };
  }, [closeWatch]);

  // Initialize the CodeMirror EditorView once. We swap content in and out
  // via dispatch when the active tab changes — no remount.
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const path = activePathRef.current;
      if (!path) return;
      const text = update.state.doc.toString();
      setTabsAndPersist((prev) =>
        prev.map((t) => {
          if (t.path !== path) return t;
          if (t.content === text) return t;
          return { ...t, content: text, dirty: true };
        }),
      );
    });

    // Mobile gets a leaner extension set: no gutter (eats ~40px on a 390px
    // screen), no autocompletion popup (lands off-screen with the soft
    // keyboard up — see tab board), and contentAttributes that turn off iOS
    // autocorrect/autocapitalize/spellcheck so it doesn't mangle code.
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          ...(mobile ? [] : [lineNumbers()]),
          highlightActiveLine(),
          history(),
          highlightSelectionMatches(),
          ...(mobile ? [] : [autocompletion()]),
          closeBrackets(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          ...(mobile
            ? [
                EditorView.contentAttributes.of({
                  autocorrect: "off",
                  autocapitalize: "off",
                  spellcheck: "false",
                }),
              ]
            : []),
          langCompartmentRef.current.of([]),
          themeCompartmentRef.current.of(
            mode === "dark"
              ? oneDark
              : syntaxHighlighting(defaultHighlightStyle),
          ),
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

  // When theme mode toggles, swap the theme compartment without rebuilding state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        mode === "dark" ? oneDark : syntaxHighlighting(defaultHighlightStyle),
      ),
    });
  }, [mode]);

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
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
        });
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
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: tab.content },
      });
    }
    if (installedLangRef.current !== tab.language) {
      view.dispatch({
        effects: langCompartmentRef.current.reconfigure(
          languageExtension(tab.language),
        ),
      });
      installedLangRef.current = tab.language;
    }
  }, [tabs, activePath]);

  const saveActiveTab = useCallback(() => {
    const path = activePathRef.current;
    if (!path) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    saveTab(path, tab.content, tab.mtime, false);
  }, [saveTab]);

  // Save with Ctrl+S / Cmd+S — must capture to suppress browser save dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "s" || (!e.ctrlKey && !e.metaKey)) return;
      // Only intercept when an editor is actively focused, otherwise let other shortcuts win.
      const view = viewRef.current;
      if (!view) return;
      if (!view.dom.contains(document.activeElement)) return;
      e.preventDefault();
      saveActiveTab();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [saveActiveTab]);

  // Close the mobile tab menu when the boss taps anywhere outside it (or its
  // anchor button). pointerdown beats click so we close before a competing
  // tap target reads the open state.
  useEffect(() => {
    if (!tabMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (tabMenuRef.current?.contains(target)) return;
      if (tabMenuButtonRef.current?.contains(target)) return;
      setTabMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [tabMenuOpen]);

  const closeTab = useCallback(
    (path: string) => {
      closeWatch(path);
      setTabsAndPersist((prev) => prev.filter((t) => t.path !== path));
      setActivePath((prev) => {
        if (prev !== path) return prev;
        const remaining = tabsRef.current.filter((t) => t.path !== path);
        return remaining.length > 0
          ? remaining[remaining.length - 1].path
          : null;
      });
      // If we just closed the last tab, force the mobile dropdown shut so a
      // freshly opened file (e.g. an EditRequestCard tap) doesn't surprise the
      // user by re-opening the menu they thought they'd left.
      if (tabsRef.current.length <= 1) {
        setTabMenuOpen(false);
      }
    },
    [closeWatch, setTabsAndPersist],
  );

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );

  const overwrite = useCallback(() => {
    if (!activeTab) return;
    // Force-save: bypass the mtime check.
    saveTab(activeTab.path, activeTab.content, activeTab.mtime, true);
  }, [activeTab, saveTab]);

  const reloadFromDisk = useCallback(() => {
    if (!activeTab) return;
    openPath(activeTab.path);
  }, [activeTab, openPath]);

  const dismissBanner = useCallback(() => {
    if (!activeTab) return;
    setTabsAndPersist((prev) =>
      prev.map((t) => (t.path === activeTab.path ? { ...t, banner: null } : t)),
    );
  }, [activeTab, setTabsAndPersist]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // borderLeft removed — the parent container's PanelResizer renders
        // the divider so it can be drag-targeted and hover-tinted.
        background: "var(--bg-base)",
        position: "relative",
        // Clip the mobile tab-dropdown so a deep file list never overflows
        // past the editor's bottom edge into the chat column behind. Desktop
        // has no popover, so the clipping is a no-op there.
        overflow: mobile ? "hidden" : undefined,
      }}
    >
      {/* Header: tabs + close. Two layouts — desktop is a horizontally
          scrolling tab strip; mobile is a single dropdown switcher with a
          dirty-only Save button next to the close ×. The mobile branch keeps
          the close affordance reachable even with many files open. */}
      {mobile ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid var(--border-strong)",
            background: "var(--bg-surface)",
            flexShrink: 0,
            minHeight: 44,
            position: "relative",
          }}
        >
          {tabs.length === 0 ? (
            <div
              style={{
                flex: 1,
                fontSize: 12,
                color: "var(--text-dim)",
                padding: "0 12px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              No file open
            </div>
          ) : (
            <button
              ref={tabMenuButtonRef}
              onClick={() => setTabMenuOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                minWidth: 0,
                height: "100%",
                padding: "0 12px",
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 13,
                cursor: "pointer",
                textAlign: "left",
              }}
              title={activeTab?.path ?? ""}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {activeTab
                  ? basename(activeTab.path) + (activeTab.dirty ? "*" : "")
                  : "Select file"}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                {tabs.length > 1 ? `▼ ${tabs.length}` : "▼"}
              </span>
            </button>
          )}
          {activeTab?.dirty && (
            <button
              onClick={saveActiveTab}
              style={{
                flexShrink: 0,
                marginRight: 6,
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid var(--green-border)",
                background: "var(--green-bg)",
                color: "var(--green)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
              }}
              title="Save"
            >
              Save
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 24,
              padding: "4px 12px",
              lineHeight: 1,
              flexShrink: 0,
            }}
            title="Close editor"
          >
            &times;
          </button>
          {tabMenuOpen && tabs.length > 0 && (
            <div
              ref={tabMenuRef}
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-strong)",
                borderTop: "none",
                maxHeight: 300,
                overflowY: "auto",
                zIndex: 5,
                boxShadow: "0 4px 12px var(--shadow)",
              }}
            >
              {tabs.map((t) => {
                const isActive = t.path === activePath;
                return (
                  <div
                    key={t.path}
                    onClick={() => {
                      setActivePath(t.path);
                      setTabMenuOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 12px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 13,
                      color: isActive
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      background: isActive ? "var(--bg-base)" : "transparent",
                      borderLeft: isActive
                        ? "3px solid var(--green)"
                        : "3px solid transparent",
                      borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                    title={t.path}
                  >
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {basename(t.path)}
                      {t.dirty ? "*" : ""}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.path);
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-ghost)",
                        cursor: "pointer",
                        fontSize: 20,
                        // 44×44pt hit target — Apple's minimum, important for
                        // a button that sits next to a row tap area where a
                        // miss switches tabs instead of closing them.
                        minWidth: 44,
                        minHeight: 44,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                        lineHeight: 1,
                        flexShrink: 0,
                      }}
                      title="Close tab"
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
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
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-dim)",
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                No file open. Use{" "}
                <code
                  style={{ margin: "0 4px", color: "var(--text-secondary)" }}
                >
                  /isomux-edit &lt;path&gt;
                </code>{" "}
                or have the agent send one.
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
                  color:
                    t.path === activePath
                      ? "var(--text-secondary)"
                      : "var(--text-muted)",
                  background:
                    t.path === activePath ? "var(--bg-base)" : "transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  flexShrink: 0,
                  maxWidth: 200,
                  position: "relative",
                  ...(t.path === activePath
                    ? { borderTop: "2px solid var(--green)" }
                    : {}),
                }}
                title={t.path}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {basename(t.path)}
                  {t.dirty ? "*" : ""}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.path);
                  }}
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
              fontSize: 20,
              padding: "4px 12px",
              lineHeight: 1,
              flexShrink: 0,
            }}
            title="Close editor"
          >
            &times;
          </button>
        </div>
      )}

      {/* Banner row (per active tab) */}
      {activeTab?.banner && (
        <div
          style={{
            padding: "6px 12px",
            background:
              activeTab.banner.kind === "save_error"
                ? "var(--red-bg)"
                : "var(--orange-bg)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            color:
              activeTab.banner.kind === "save_error"
                ? "var(--red)"
                : "var(--orange)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {activeTab.banner.kind === "stale" && (
            <>
              <span style={{ flex: 1 }}>
                File changed on disk since you opened it.
              </span>
              <button onClick={overwrite} style={bannerBtn("var(--orange)")}>
                Overwrite
              </button>
              <button
                onClick={reloadFromDisk}
                style={bannerBtn("var(--text-secondary)")}
              >
                Reload
              </button>
            </>
          )}
          {activeTab.banner.kind === "external" && (
            <>
              <span style={{ flex: 1 }}>
                File changed externally — your edits will be lost if you reload.
              </span>
              <button
                onClick={reloadFromDisk}
                style={bannerBtn("var(--orange)")}
              >
                Reload
              </button>
              <button
                onClick={dismissBanner}
                style={bannerBtn("var(--text-secondary)")}
              >
                Dismiss
              </button>
            </>
          )}
          {activeTab.banner.kind === "save_error" && (
            <>
              <span style={{ flex: 1 }}>
                Save failed: {activeTab.banner.message}
              </span>
              <button onClick={dismissBanner} style={bannerBtn("var(--red)")}>
                Dismiss
              </button>
            </>
          )}
        </div>
      )}

      {pendingError && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--red-bg)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--red)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{pendingError}</span>
          <button
            onClick={() => setPendingError(null)}
            style={bannerBtn("var(--red)")}
          >
            Dismiss
          </button>
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

      {/* Footer status. Mobile drops the path (low value at 320px and already
          available in the tab-dropdown tooltip) and the Ctrl+S hint (no Ctrl
          key on touch). The bottom safe-area inset is handled by the outer
          overlay container in LogView, so the footer keeps a flat 4px pad. */}
      {activeTab && (
        <div
          style={{
            padding: "4px 12px",
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-surface)",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 12,
            fontFamily: "'JetBrains Mono', monospace",
            flexShrink: 0,
          }}
        >
          {!mobile && (
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activeTab.path}
            </span>
          )}
          {mobile && <span style={{ flex: 1 }} />}
          <span>{activeTab.language}</span>
          <span>{activeTab.dirty ? "modified" : "saved"}</span>
          {!mobile && (
            <span title="Ctrl+S to save">
              {(navigator.platform || "").includes("Mac") ? "⌘S" : "Ctrl+S"}
            </span>
          )}
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
