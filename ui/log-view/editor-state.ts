// Module-level editor state per agent. EditorPanel state (tabs, dirty
// buffers, scroll, selection) lives here rather than in the React tree so
// it survives LogView remount when the boss switches between agents.
//
// The data is intentionally NOT in the App reducer because every keystroke
// would dispatch a state update - too much churn for a Map of ~5 tabs each
// with a string body. Reading/writing happens directly in EditorPanel.

export interface PersistedTab {
  path: string;
  content: string;
  mtime: number;
  // Server-issued revision this buffer is based on (see server/file-editor.ts).
  rev: number;
  language: string;
  size: number;
  dirty: boolean;
  // Captured CodeMirror view state so per-tab cursor and scroll restore
  // when the boss switches back. Optional; missing means start at the top.
  scrollTop?: number;
  selection?: { anchor: number; head: number };
}

export interface PersistedEditorState {
  tabs: PersistedTab[];
  activePath: string | null;
}

const stateByAgent = new Map<string, PersistedEditorState>();
const viewStateByAgent = new Map<
  string,
  Map<
    string,
    {
      scrollTop: number;
      selection: { anchor: number; head: number };
    }
  >
>();

export function getEditorState(agentId: string): PersistedEditorState | null {
  const state = stateByAgent.get(agentId);
  if (!state) return null;
  const views = viewStateByAgent.get(agentId);
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab, ...views?.get(tab.path) })),
  };
}

export function setEditorState(
  agentId: string,
  state: PersistedEditorState | null,
): void {
  if (
    state === null ||
    (state.tabs.length === 0 && state.activePath === null)
  ) {
    stateByAgent.delete(agentId);
    viewStateByAgent.delete(agentId);
  } else {
    stateByAgent.set(agentId, state);
    const paths = new Set(state.tabs.map((tab) => tab.path));
    const views = viewStateByAgent.get(agentId);
    if (views) {
      for (const path of views.keys()) {
        if (!paths.has(path)) views.delete(path);
      }
      if (views.size === 0) viewStateByAgent.delete(agentId);
    }
  }
}

export function setEditorViewState(
  agentId: string,
  path: string,
  scrollTop: number,
  selection: { anchor: number; head: number },
): void {
  if (!stateByAgent.get(agentId)?.tabs.some((tab) => tab.path === path)) return;
  let views = viewStateByAgent.get(agentId);
  if (!views) {
    views = new Map();
    viewStateByAgent.set(agentId, views);
  }
  views.set(path, { scrollTop, selection });
}
