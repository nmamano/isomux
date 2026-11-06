import { useLayoutEffect, useState } from "react";

export interface VisibleArea {
  top: number;
  height: number;
}

// The part of the window the visual viewport shows, held inside the window:
// on iOS the keyboard shrinks the visual viewport, and WebKit can report an
// offsetTop the window cannot hold.
export function visibleArea(
  layoutHeight: number,
  vv: { height: number; offsetTop: number },
): VisibleArea {
  const height = Math.min(vv.height, layoutHeight);
  const top = Math.min(Math.max(0, vv.offsetTop), layoutHeight - height);
  return { top, height };
}

// The visible area while `active`, kept live through keyboard opens and
// closes, with the page scroll iOS adds undone. Null when inactive or without
// visualViewport.
export function useVisibleArea(active: boolean): VisibleArea | null {
  const [area, setArea] = useState<VisibleArea | null>(null);
  // Before paint, so the box never shows at the old area.
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const update = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
      setArea(visibleArea(window.innerHeight, vv));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  return active ? area : null;
}
