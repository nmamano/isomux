import { useEffect, useState } from "react";
import type { AgentInfo } from "../shared/types.ts";
import { App } from "./App.tsx";
import { AppWidgetPage } from "./AppWidgetPage.tsx";
import type { AppWidgetBoot } from "./app-widget-state.ts";
import { useAppState, useDispatch } from "./store.tsx";
import { saveView } from "./view-persistence.ts";

// App owns normal office history. This bridge owns only the original app
// wrapper entry, which must reload its frame when Back reaches it.
export function WidgetOfficeBridge({ boot }: { boot: AppWidgetBoot }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const [office, setOffice] = useState(false);
  const [entryMarker] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const backToApp = (event: PopStateEvent) => {
      if (event.state?.isomuxAppWrapper !== entryMarker) return;
      // The office's listener must not clear the saved chat before the reload.
      event.stopImmediatePropagation();
      window.location.reload();
    };
    window.addEventListener("popstate", backToApp);
    return () => window.removeEventListener("popstate", backToApp);
  }, [entryMarker]);

  const openOffice = (agent: AgentInfo) => {
    window.history.replaceState(
      { ...window.history.state, isomuxAppWrapper: entryMarker },
      "",
    );
    if (state.sessionContext?.username) {
      saveView(state.sessionContext.username, {
        roomId: agent.roomId,
        agentId: agent.id,
        panel: null,
        lobby: false,
      });
    }
    dispatch({ type: "set_current_room", roomId: agent.roomId });
    dispatch({ type: "focus", agentId: agent.id });
    setOffice(true);
  };
  return office ? (
    <App />
  ) : (
    <AppWidgetPage boot={boot} onOpenOffice={openOffice} />
  );
}
