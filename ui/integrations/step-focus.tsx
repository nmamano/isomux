// A step ask's focus on the Integrations page (task c71cb60f): the ask's
// link opens a tab with the step, and the tab marks the setting the step is
// done in (data-step-focus) and scrolls it into view. IntegrationsView gives
// each card the step only when the step is the card's (its scope, its
// member), so a section marks what it draws.

import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import type { StepAskRequest } from "../../shared/types.ts";

export const StepFocus = createContext<StepAskRequest | null>(null);

export function useStepFocus(): StepAskRequest | null {
  return useContext(StepFocus);
}

// The marked setting: an accent outline, scrolled into view once.
export function StepMark({
  active,
  kind,
  children,
}: {
  active: boolean;
  kind: StepAskRequest["kind"];
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (element && typeof element.scrollIntoView === "function")
      element.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);
  if (!active) return <>{children}</>;
  return (
    <div
      ref={ref}
      data-step-focus={kind}
      style={{
        outline: "2px solid var(--accent)",
        outlineOffset: 4,
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}
