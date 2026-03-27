import { createContext, useContext, useReducer, useEffect, type ReactNode, type Dispatch } from "react";
import type { AgentInfo, LogEntry, ServerMessage } from "../shared/types.ts";
import { connect } from "./ws.ts";

export interface AppState {
  agents: AgentInfo[];
  logs: Map<string, LogEntry[]>; // agentId → entries
  focusedAgentId: string | null;
  connected: boolean;
}

type Action =
  | { type: "full_state"; agents: AgentInfo[] }
  | { type: "agent_added"; agent: AgentInfo }
  | { type: "agent_removed"; agentId: string }
  | { type: "agent_updated"; agentId: string; changes: Partial<AgentInfo> }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "focus"; agentId: string | null }
  | { type: "connected" };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "full_state":
      return { ...state, agents: action.agents };
    case "agent_added":
      return { ...state, agents: [...state.agents, action.agent] };
    case "agent_removed": {
      const logs = new Map(state.logs);
      logs.delete(action.agentId);
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== action.agentId),
        logs,
        focusedAgentId: state.focusedAgentId === action.agentId ? null : state.focusedAgentId,
      };
    }
    case "agent_updated":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === action.agentId ? { ...a, ...action.changes } : a
        ),
      };
    case "log_entry": {
      const logs = new Map(state.logs);
      const entries = logs.get(action.entry.agentId) ?? [];
      logs.set(action.entry.agentId, [...entries, action.entry]);
      return { ...state, logs };
    }
    case "focus":
      return { ...state, focusedAgentId: action.agentId };
    case "connected":
      return { ...state, connected: true };
    default:
      return state;
  }
}

const initialState: AppState = {
  agents: [],
  logs: new Map(),
  focusedAgentId: null,
  connected: false,
};

const StateCtx = createContext<AppState>(initialState);
const DispatchCtx = createContext<Dispatch<Action>>(() => {});

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    connect((msg: ServerMessage) => {
      dispatch(msg as Action);
      if (msg.type === "full_state") dispatch({ type: "connected" });
    });
  }, []);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState() {
  return useContext(StateCtx);
}

export function useDispatch() {
  return useContext(DispatchCtx);
}
