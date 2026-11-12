// The top-bar buttons the open desktop sidebar repeats (OFFICE_BAR_TWINS,
// CHAT_BAR_TWINS in ui/chat-sidebar.ts) fade instead of popping (task
// 5dac6b9b): as the sidebar opens they fade out over its slide and then
// leave the bar; as it closes they come back with a fade in.

import { useEffect, useState } from "react";
import type { NavAction } from "../components/NavActions.tsx";

const FADE_MS = 200;

type Twins = "shown" | "leaving" | "gone" | "entering";

export function useTwinFade(
  sidebarOpen: boolean,
  actions: NavAction[],
  twins: ReadonlySet<string>,
): NavAction[] {
  const [state, setState] = useState<Twins>(sidebarOpen ? "gone" : "shown");
  const [seenOpen, setSeenOpen] = useState(sidebarOpen);
  if (sidebarOpen !== seenOpen) {
    setSeenOpen(sidebarOpen);
    setState(sidebarOpen ? "leaving" : "entering");
  }
  useEffect(() => {
    if (state !== "leaving") return;
    const id = setTimeout(() => setState("gone"), FADE_MS);
    return () => clearTimeout(id);
  }, [state]);
  if (state === "shown") return actions;
  if (state === "gone") return actions.filter((a) => !twins.has(a.id));
  const fade = state === "leaving" ? "out" : "in";
  return actions.map((a) => (twins.has(a.id) ? { ...a, fade } : a));
}
