// The opaque bar at the top of a phone screen (task d60726c7): see
// ui/safe-area.ts. Above every other layer (the highest below is 9999), in
// the colour of the phone headers, so bar and header read as one band. It
// takes taps, so nothing under it is tapped by mistake. Not on desktop.

import { PHONE_TOP } from "../safe-area.ts";

export function PhoneTopBar({
  isMobile,
}: {
  isMobile: boolean;
}): React.ReactElement | null {
  if (!isMobile) return null;
  return (
    <div
      data-phone-top-bar=""
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: PHONE_TOP,
        background: "var(--bg-hud-solid)",
        zIndex: 10000,
      }}
    />
  );
}
