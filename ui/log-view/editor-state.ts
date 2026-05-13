// Module-level editor state per agent. EditorPanel state (tabs, dirty
// buffers, scroll, selection) lives here rather than in the React tree so
// it survives LogView remount when the boss switches between agents.
//
// The data is intentionally NOT in the App reducer because every keystroke
// would dispatch a state update — too much churn for a Map of ~5 tabs each
// with a string body. Reading/writing happens directly in EditorPanel.

export interface PersistedTab {
  path: string;
  content: string;
  mtime: number;
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

export function getEditorState(agentId: string): PersistedEditorState | null {
  return stateByAgent.get(agentId) ?? null;
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
  } else {
    stateByAgent.set(agentId, state);
  }
}
