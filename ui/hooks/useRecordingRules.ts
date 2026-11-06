// Feeds recording mode (ui/recording-mode.ts) the rules from the store: the
// member's word list from their own record (the office name row when they
// never saved one), this office's host, and the other offices the elevator
// knows: its floors first, then the panel's visits and the names this
// browser asked for.

import { useLayoutEffect } from "react";
import { useAppState } from "../store.tsx";
import { useSelfUser } from "./useSelfUser.ts";
import { readNames, readPanel } from "../elevator-panel-store.ts";
import { setRecordingRules } from "../recording-mode.ts";
import { defaultRecordingWords } from "../../shared/recording-redact.ts";

export function useRecordingRules(): void {
  const { office, floors } = useAppState();
  const self = useSelfUser();
  const words = self?.recordingWords;
  const officeName = office.name;
  // A layout effect runs in the commit, before the observer's microtask and
  // before paint: a passive effect runs after paint for a WebSocket update,
  // and the new office name or word would show for one frame.
  useLayoutEffect(() => {
    const names = readNames();
    const otherOffices = [
      ...floors.map((f) => ({
        url: f.url,
        name: f.name ?? names[f.url]?.name ?? null,
      })),
      ...readPanel().visited.map((v) => ({
        url: v.url,
        name: names[v.url]?.name ?? null,
      })),
      ...Object.entries(names).map(([url, n]) => ({ url, name: n.name })),
    ];
    setRecordingRules({
      officeHosts: [location.host],
      otherOffices,
      words: words ?? defaultRecordingWords(officeName),
    });
  }, [floors, words, officeName]);
}
