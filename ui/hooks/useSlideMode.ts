// Reads the device-local Slide Mode gate and re-renders when it changes -
// including while the component stays mounted (the settings surface that
// writes it renders over the view, not in place of it).

import { useSyncExternalStore } from "react";
import {
  getSlideModeEnabled,
  subscribeSlideModeEnabled,
} from "../device-settings.ts";

export function useSlideModeEnabled(): boolean {
  return useSyncExternalStore(
    subscribeSlideModeEnabled,
    getSlideModeEnabled,
    () => false,
  );
}
