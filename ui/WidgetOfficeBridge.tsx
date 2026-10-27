import { useEffect, useState } from "react";
import type { AppView } from "../shared/contract-shapes.ts";
import type { AgentInfo } from "../shared/types.ts";
import { App } from "./App.tsx";
import { AppWidgetPage } from "./AppWidgetPage.tsx";
import {
  saveReturnPath,
  takeReturnPath,
  type AppWidgetBoot,
} from "./app-widget-state.ts";
import { useAppState, useDispatch } from "./store.tsx";
import { saveView } from "./view-persistence.ts";
import { WidgetAppCtx, type WidgetAppContext } from "./widget-app-context.ts";

// App owns normal office history. This bridge owns only the original app
// wrapper entry, which must reload its frame when Back reaches it.
export function WidgetOfficeBridge({ boot }: { boot: AppWidgetBoot }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const [office, setOffice] = useState<WidgetAppContext | null>(null);
  // A reload keeps history.state, so the page that Back reloads finds the
  // marker it saved, and with it the page the member left (task d7ac4f73).
  const [entryMarker] = useState(() => {
    const saved = (window.history.state as { isomuxAppWrapper?: unknown })
      ?.isomuxAppWrapper;
    return typeof saved === "string" ? saved : crypto.randomUUID();
  });
  const [returnPath] = useState(() =>
    takeReturnPath(sessionStorage, boot, entryMarker),
  );
  useEffect(() => {
    const backToApp = (event: PopStateEvent) => {
      if (
        (event.state as { isomuxAppWrapper?: unknown } | null)
          ?.isomuxAppWrapper !== entryMarker
      )
        return;
      // The office's listener must not clear the saved chat before the reload.
      event.stopImmediatePropagation();
      window.location.reload();
    };
    window.addEventListener("popstate", backToApp);
    return () => window.removeEventListener("popstate", backToApp);
  }, [entryMarker]);

  const openOffice = (agent: AgentInfo, view: AppView) => {
    window.history.replaceState(
      { ...window.history.state, isomuxAppWrapper: entryMarker },
      "",
    );
    saveReturnPath(sessionStorage, boot, entryMarker, view.path);
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
    setOffice({ agentId: agent.id, appContext: { ...boot, view } });
  };
  return office ? (
    <WidgetAppCtx.Provider value={office}>
      <App />
    </WidgetAppCtx.Provider>
  ) : (
    <AppWidgetPage
      boot={boot}
      returnPath={returnPath}
      onOpenOffice={openOffice}
    />
  );
}
