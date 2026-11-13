// The phone's sidebar drawer (task 3cced5be): the sidebar App draws beside
// the view on a desktop, here over a dimmed view, sliding in from the left
// (styles.ts .phone-sidebar). A tap on the backdrop closes it; App owns the
// open state and the history entry.

import type { ReactNode } from "react";

export function PhoneSidebarDrawer({
  onClose,
  children,
}: {
  onClose: () => void;
  // The sidebar, drawn when the drawer is.
  children: () => ReactNode;
}): React.ReactElement {
  return (
    <div data-phone-sidebar="" className="phone-sidebar">
      <div
        data-phone-sidebar-backdrop=""
        className="phone-sidebar-backdrop"
        onClick={onClose}
      />
      <div className="phone-sidebar-panel">
        <div style={{ position: "relative", height: "100%" }}>{children()}</div>
      </div>
    </div>
  );
}
