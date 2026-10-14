import type { ReactNode } from "react";

// Holds the space of content that is still loading: the children lay out but
// do not paint, take no focus and are not read out. A line that arrives later
// then takes the place it held, and the card around it keeps its height.
export function Reserved({ children }: { children: ReactNode }) {
  return (
    <div data-reserved="" aria-hidden inert style={{ visibility: "hidden" }}>
      {children}
    </div>
  );
}
