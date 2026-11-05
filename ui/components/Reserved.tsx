import type { ReactNode } from "react";

// Holds the space of content that is still loading: the children lay out but
// do not paint (unless `dim`), take no focus and are not read out. A line that arrives later
// then takes the place it held, and the card around it keeps its height.
// `dim`: they paint grayed out, so the member sees the real layout wait for
// its answer (task a10fd923).
export function Reserved({
  children,
  dim,
}: {
  children: ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      data-reserved=""
      aria-hidden
      inert
      style={dim ? { opacity: 0.45 } : { visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
